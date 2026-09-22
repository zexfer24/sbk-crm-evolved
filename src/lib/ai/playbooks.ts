import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CatalogLink, Playbook, PlaybookAfterSend, PlaybookAttachmentType, Tag, TagColor } from "@/lib/types";
import { getClassifierModel } from "@/lib/ai/model";
import {
  DEFAULT_BUSINESS_HOURS,
  dayBand,
  describeSchedule,
  businessStatus,
  type BusinessHours,
} from "@/lib/business-hours";
import { formatCrmDateTime } from "@/lib/time-zone";
import { isGreetingPlaybook } from "@/lib/ai/saludo";
import { resolveCatalogMarkers } from "@/lib/catalog-links";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Reconocimiento de escenario: fase 0 del turno. Elige cuál respuesta
// predeterminada aplica, entre las que el supervisor tenga cargadas. Es solo
// una clasificación — el texto que se le envía al cliente sale tal cual de la
// base de datos, sin pasar por el modelo (ver runPlaybook en agent.ts).
// ---------------------------------------------------------------------------

/** Valor del enum que el modelo elige cuando ningún escenario aplica. */
const NO_MATCH = "ninguno";

/**
 * Cuánto tiene que pasar para que un escenario pueda repetirse en el mismo
 * chat.
 *
 * El 27 de agosto de 2026 un cliente recibió el MISMO mensaje cinco veces en
 * 68 minutos. El emparejador no falló: el disparador que el equipo escribió
 * ("pregunta por cascos, modelos disponibles o tallas") captura también las
 * preguntas de seguimiento, y el cliente dijo "talla" en los cinco mensajes.
 * En 24 h eso fueron 25 repeticiones exactas sobre 202 mensajes: un 12 %.
 *
 * Esto no arregla el disparador —eso lo escribe el dueño desde el panel— ni lo
 * intenta: es la red que hace que una regla mal escrita no pueda convertirse
 * en un cliente recibiendo lo mismo cinco veces.
 *
 * Seis horas y no una: el escenario frenado no deja al cliente en silencio,
 * el turno cae al flujo genérico y le contesta con lo que sepa. O sea que
 * pasarse de largo cuesta poco —una respuesta redactada en vez del texto
 * oficial— y quedarse corto cuesta lo del incidente. Lo único que se pierde
 * de verdad es el adjunto, que solo viaja con el escenario; por eso no es
 * "una vez por conversación": el que vuelve mañana a pedir el catálogo lo
 * recibe.
 */
const PLAYBOOK_COOLDOWN_HOURS = 6;

/**
 * ¿Este escenario ya salió en este chat hace poco?
 *
 * Se pregunta contra `agent_turns`, que es donde queda registrado cada
 * escenario que se envió, con su `playbook_id`. El índice
 * `agent_turns_conversation_id_idx` es (conversation_id, created_at desc), así
 * que la consulta toca solo las filas de esta conversación.
 *
 * Falla CERRADO: si no se puede preguntar, se da por repetido. Cuesta barato
 * equivocarse hacia ese lado —el turno sigue por el flujo genérico y el
 * cliente igual recibe una respuesta—, y equivocarse hacia el otro es
 * exactamente el incidente.
 */
export async function playbookSentRecently(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  playbookId: string,
  now: number = Date.now()
): Promise<boolean> {
  const desde = new Date(now - PLAYBOOK_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("agent_turns")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("playbook_id", playbookId)
    .gt("created_at", desde)
    .limit(1);

  if (error) {
    log.error("escenario_repeticion_no_consultable", { conversationId, detail: error.message });
    return true;
  }

  return (data ?? []).length > 0;
}

// Exportada (8/9/2026) para que runTurnPhases (agent.ts) pueda devolver el
// mismo "sin escenario, sin costo" cuando se salta matchPlaybook a propósito
// —el último mensaje del cliente es un marcador de media, y comparar un
// escenario contra "[El cliente envió una foto…]" no calza nunca y solo
// gastaría una llamada al proveedor de balde.
export const ZERO_USAGE: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

export interface PlaybookMatch {
  playbook: Playbook | null;
  usage: LanguageModelUsage;
}

/** Fila de `ai_playbook_tags` con su etiqueta embebida, tal como llega de PostgREST. */
interface RawPlaybookTag {
  tag: { id: string; label: string; color: string } | null;
}

/**
 * Las etiquetas viajan embebidas y no en una segunda consulta porque acá son
 * unas pocas decenas de filas en total —los escenarios se cuentan con los
 * dedos— y esto corre una vez por turno. El caso que obliga a separar (el
 * lateral por fila sobre cientos de filas, ver CONVERSATION_BOARD_SELECT en
 * src/lib/data.ts) no es este.
 */
export async function fetchActivePlaybooks(supabase: SupabaseClient<Database>): Promise<Playbook[]> {
  const { data, error } = await supabase
    .from("ai_playbooks")
    .select(
      "id, name, trigger_description, response_text, attachment_url, attachment_type, after_send, is_active, cede_al_inventario, ai_playbook_tags(tag:tags(id, label, color))"
    )
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("No se pudieron leer los escenarios de la IA, el turno sigue por el flujo genérico:", error);
    return [];
  }

  // Los CHECK de la tabla no viajan al tipo generado (llegan como `text`),
  // pero garantizan que estos valores están dentro de la unión.
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    triggerDescription: row.trigger_description,
    responseText: row.response_text,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type as PlaybookAttachmentType | null,
    afterSend: row.after_send as PlaybookAfterSend,
    isActive: row.is_active,
    // T1, plan "El catálogo configurado sale siempre" (21/9/2026): cuarta
    // condición de "el repuesto manda" (H1) -- sin mapearla acá, `agent.ts`
    // nunca podría saber si el supervisor marcó este escenario para ceder al
    // inventario, aunque la columna ya viniera en el select.
    cedeAlInventario: row.cede_al_inventario,
    tags: playbookTags(row as unknown as { ai_playbook_tags: RawPlaybookTag[] | null }),
  }));
}

/**
 * `tag` puede llegar en null si la etiqueta se borró entre la consulta y la
 * respuesta. La clave foránea con cascada hace que esa fila desaparezca sola,
 * así que es una carrera, no un estado guardado — se descarta y ya.
 */
function playbookTags(row: { ai_playbook_tags: RawPlaybookTag[] | null }): Tag[] {
  return (row.ai_playbook_tags ?? [])
    .map((link) => link.tag)
    .filter((tag): tag is NonNullable<RawPlaybookTag["tag"]> => tag !== null)
    .map((tag) => ({ id: tag.id, label: tag.label, color: tag.color as TagColor }));
}

/**
 * Franja y horario calculados, igual que en `prompt.ts` (Frente B3, "El
 * reloj dice la verdad", 5/9/2026): antes el clasificador solo recibía la
 * fecha en texto ("4:45 p. m.") y tenía que deducir la franja él mismo para
 * comparar contra los disparadores de horario. Acá viene ya resuelta.
 *
 * El párrafo del reloj vive al FINAL del prompt, justo antes de la
 * instrucción de cómo responder — no en la segunda línea, como hasta el
 * 21/9/2026 (hallazgo 4 del informe del VPS, plan "Nada se pierde en un
 * corte ni en un deploy", 22/9/2026). El caché de prompts del proveedor
 * cachea por PREFIJO idéntico entre llamadas: con el reloj arriba, cada
 * turno mandaba una hora distinta en los primeros caracteres y el prefijo se
 * rompía siempre — esta llamada (la de fase 0) nunca podía cachear, y un
 * turno resuelto por escenario hace solo esta llamada más la de intención.
 * Con todo lo estático primero (instrucción + catálogo + reglas), el
 * prefijo es el mismo turno tras turno; el reloj queda como el único tramo
 * que cambia, al final. Sin promesa de efecto (nota A del VPS): con 14
 * escenarios activos el bloque estático ronda ~830 tokens, por debajo del
 * mínimo de ~1.024 del caché de OpenAI — T4 mide después si de verdad
 * alcanza a cachear.
 */
function buildPrompt(playbooks: Playbook[], now: Date, businessHours: BusinessHours = DEFAULT_BUSINESS_HOURS): string {
  const catalog = playbooks.map((p) => `- ${p.name}: ${p.triggerDescription}`).join("\n");
  const franja = dayBand(now);
  const estado = businessStatus(now, businessHours).open ? "abierta" : "cerrada";

  const reloj = `Fecha y hora local: ${formatCrmDateTime(now)} (Venezuela) — franja: ${franja}. Horario de atención: ${describeSchedule(businessHours)}. Ahora mismo la tienda está ${estado}. Varios disparadores están escritos como franjas horarias: compruébalos contra ESA hora, no contra las palabras del cliente. Alguien puede escribir "buenas noches" a las once de la mañana.`;

  return `Eres el clasificador de una repuestera de motos en Venezuela que atiende por WhatsApp. Tienes respuestas ya redactadas para ciertas situaciones. Tu única tarea es decidir cuál de ellas corresponde al ÚLTIMO mensaje del cliente, tomando en cuenta todo el contexto previo de la conversación.

Escenarios disponibles:
${catalog}

Si el cliente saluda Y pregunta algo en el mismo mensaje, el saludo no cuenta: clasifica por la pregunta.

Responde "${NO_MATCH}" si ninguno calza con claridad.

Ante la duda, responde "${NO_MATCH}". Equivocarse de escenario le manda al cliente un mensaje que no tiene nada que ver con lo que preguntó; responder "${NO_MATCH}" solo hace que otro agente atienda el caso con normalidad. Prefiere siempre el segundo error.

${reloj}

Responde solo con el nombre exacto del escenario, o con "${NO_MATCH}".`;
}

/**
 * ¿Este escenario tiene algún `{{catalogo:<key>}}`/`{{catalogos}}` que NO
 * resuelve contra los catálogos ACTIVOS de hoy?
 *
 * Mira `response_text` y, cuando el adjunto es de tipo `link`, también
 * `attachment_url` — los dos sitios que `playbookMessageText` (send.ts)
 * junta en el mensaje final. Un catálogo desactivado o borrado, o un
 * `{{catalogos}}` sin NINGÚN catálogo activo (ajuste sobre D6 hallado al
 * implementar esta tarea, ver `catalog-links.ts`), cuentan igual que un
 * marcador mal escrito: D6 es "un marcador que no resuelve nunca llega al
 * cliente".
 */
function hasUnresolvedCatalogMarker(playbook: Playbook, links: CatalogLink[]): boolean {
  if (resolveCatalogMarkers(playbook.responseText, links).missing.length > 0) return true;
  if (playbook.attachmentType === "link" && playbook.attachmentUrl) {
    return resolveCatalogMarkers(playbook.attachmentUrl, links).missing.length > 0;
  }
  return false;
}

/**
 * Fase 0 del turno. Devuelve el escenario que aplica, o null.
 *
 * Nunca lanza: un fallo del proveedor no puede tumbar el turno, solo hace
 * que la conversación siga por el flujo genérico, que es el comportamiento
 * que había antes de que existieran los escenarios.
 */
export async function matchPlaybook(
  history: ModelMessage[],
  playbooks: Playbook[],
  now: Date = new Date(),
  // Con default para no romper a los llamadores viejos ni a los tests que
  // todavía no pasan horario: cae al horario por defecto (Frente B3, "El
  // reloj dice la verdad", 5/9/2026).
  businessHours: BusinessHours = DEFAULT_BUSINESS_HOURS,
  // T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
  // D6): los catálogos ACTIVOS leídos al abrir el turno. Con default `[]`
  // por el mismo motivo que `businessHours` de arriba — un escenario sin
  // ningún marcador de catálogo (la inmensa mayoría) no se entera de que
  // este parámetro existe.
  links: CatalogLink[] = []
): Promise<PlaybookMatch> {
  // Historia de este filtro, tres capítulos:
  //
  // 27/8/2026 — el saludo lo daba el TEXTO del escenario, elegido por el
  // modelo entre tres opciones ("Buen día"/"Buenas tardes"/"Buenas noches")
  // sin saber qué hora era: 4 de 14 salieron con el saludo equivocado.
  // 5/9/2026 (B3) se arregló restringiendo esos tres por franja horaria, con
  // un módulo aparte dedicado solo a acotar por hora los escenarios que
  // saludan.
  //
  // 14/9/2026 (T4 de la corrida anterior) apareció el problema real: 53
  // veces en 72 h el cliente saludó Y preguntó en el mismo mensaje ("Buenas
  // tardes, tienen tanque de EK Xpress") y el escenario de saludo calzaba
  // igual —su disparador no exige que el mensaje sea SOLO un saludo—, así
  // que la pregunta real se perdía. El parche de entonces solo descartaba
  // los escenarios de saludo cuando el ÚLTIMO texto del cliente traía algo
  // más que un saludo puro (quinto argumento de esta función, retirado en
  // la corrida siguiente).
  //
  // 15/9/2026 (T3 de esta corrida, `44145c7`): el saludo dejó de salir de
  // NINGÚN escenario del panel. `buildInstructions` (prompt.ts) ya saluda
  // por código, con la franja calculada, UNA sola vez por conversación —
  // así que ya no hace falta que fase 0 elija BIEN cuál saludo mandar: hace
  // falta que NUNCA elija uno, porque el saludo ya salió antes. El descarte
  // pasa a ser incondicional (ya no depende de si el cliente saludó pelado
  // o con pregunta) y el módulo que acotaba los escenarios de saludo por
  // hora queda sin trabajo: se retira. `isGreetingPlaybook` (saludo.ts)
  // sigue siendo la única pregunta que hace falta — "¿el texto YA REDACTADO
  // de este escenario empieza saludando?" — y ahora se aplica siempre, sin
  // condición.
  const antes = playbooks.length;
  const sinSaludo = playbooks.filter((p) => !isGreetingPlaybook(p.responseText));
  if (sinSaludo.length < antes) {
    const ignorados = antes - sinSaludo.length;
    // `LogContext` (log.ts) solo acepta valores escalares: los nombres viajan
    // unidos por coma, no como arreglo.
    const nombres = playbooks
      .filter((p) => isGreetingPlaybook(p.responseText))
      .map((p) => p.name)
      .join(", ");
    log.info("escenarios_saludo_ignorados", { ignorados, nombres });
  }

  // T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
  // D6): mismo patrón que el descarte de saludo de arriba, para el marcador
  // de catálogo. Un escenario con `{{catalogo:<key>}}`/`{{catalogos}}` sin
  // resolver NUNCA llega al cliente — se saca de los candidatos ANTES de
  // llamar al modelo, no se manda con el marcador crudo ni se le pide al
  // modelo que "arregle" el texto.
  const candidatos = sinSaludo.filter((p) => !hasUnresolvedCatalogMarker(p, links));
  if (candidatos.length < sinSaludo.length) {
    const ignorados = sinSaludo.length - candidatos.length;
    const nombres = sinSaludo
      .filter((p) => hasUnresolvedCatalogMarker(p, links))
      .map((p) => p.name)
      .join(", ");
    log.info("escenarios_enlace_sin_resolver", { ignorados, nombres });
  }

  // Sin escenarios que puedan salir ahora no hay nada que elegir: se ahorra la
  // llamada y el turno sigue por el flujo genérico, que redacta con la hora
  // correcta (va en TURNO ACTUAL, ver prompt.ts).
  if (candidatos.length === 0) return { playbook: null, usage: ZERO_USAGE };

  const { model, providerOptions } = getClassifierModel("escenario");

  try {
    const { object, usage } = await generateObject({
      model,
      providerOptions,
      // Ver classify.ts: el reintento lo hace el control de ritmo, no el SDK.
      maxRetries: 0,
      output: "enum",
      enum: [...candidatos.map((p) => p.name), NO_MATCH],
      system: buildPrompt(candidatos, now, businessHours),
      messages: history,
    });

    return { playbook: candidatos.find((p) => p.name === object) ?? null, usage };
  } catch (err) {
    // Registro estructurado y no console.error: este catch se traga
    // CUALQUIER fallo del proveedor, rate limit incluido, y el turno
    // sigue como si no hubiera escenarios. Enterrado en texto suelto,
    // un 429 acá era invisible: solo se veía cuando volvía a pegar en la
    // fase siguiente, que es la que sí aborta el turno.
    log.error("escenario_reconocimiento_fallido", { detail: errorText(err) });
    return { playbook: null, usage: ZERO_USAGE };
  }
}
