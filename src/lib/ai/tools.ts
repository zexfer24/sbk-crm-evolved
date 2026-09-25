import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { BUSINESS_NAME } from "@/lib/brand";
import { getBcvRate } from "@/lib/ai/bcv";
import { catalogTermGroups, type SearchSynonym } from "@/lib/ai/catalog-search";
import { formatQuote } from "@/lib/ai/precio";
import {
  RECLAMO_CATEGORIES,
  escalateConversation,
  type EscalateResult,
  type EscalationMotivo,
  type ReclamoCategory,
} from "@/lib/ai/escalate";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_SIN_STOCK,
} from "@/lib/ai/seba";
import { inventoryAgeInstruction, inventoryFreshness } from "@/lib/inventory-freshness";
import { errorText, log } from "@/lib/log";
import type { BusinessHours, BusinessStatus } from "@/lib/business-hours";
// F (20/9/2026, "El resguardo antes del push", C3): mismo escapado de
// literales que `catalog-search.ts` usa para el `.or()` de `products` — acá
// hace falta para no interpolar `conversationId` crudo en el `.or()` de
// `ai_lessons` (ver más abajo).
import { pgrstLiteral } from "@/lib/ai/pgrst";

/**
 * Tope de repuestos que se le pasan al modelo de una vez.
 *
 * Sin tope, un término genérico —«repuesto», «moto», «aceite»— metía el
 * catálogo entero en el contexto, con precios, stock y compatibilidades de
 * cada producto, y se repetía en cada paso del tool loop.
 *
 * Diez no es solo por costo: nadie lee veinticinco repuestos en un mensaje de
 * WhatsApp. Si hay más, conviene que la IA pida precisar antes que enumerar.
 */
const MAX_CATALOG_RESULTS = 10;

/**
 * Tope de sinónimos activos (`ai_lessons.kind = 'sinonimo'`) que se leen en
 * cada búsqueda (T5c, 18/9/2026, ver catalog-search.ts). 200 es
 * generosamente más de lo que un equipo de asesores va a acumular en la
 * práctica; el límite existe para que la consulta nunca sea ilimitada, no
 * porque se espere acercarse a él.
 */
const MAX_SYNONYM_LESSONS = 200;

/**
 * Se le dice en palabras qué hacer con el recorte: si no, el modelo enumera
 * los que le llegaron como si fueran todo el catálogo.
 */
const RECORTE_INSTRUCTION =
  "Hay más resultados de los que caben acá. Muestra estos y pídele al cliente que precise (marca del repuesto, modelo de su moto) en vez de dar a entender que esto es todo lo que hay.";

/**
 * T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4 del cliente):
 * hasta esta corrida un repuesto en cero solo dejaba un aviso suelto
 * (`SIN_STOCK_INSTRUCTION`, ver abajo qué reemplazó) y nada obligaba a
 * escalar. Ahora TODA llamada al catálogo con resultado termina en una de
 * cuatro instrucciones, en este orden de precedencia (`generico` primero
 * porque es la única que le prohíbe escalar: requisito 5, la única
 * pregunta):
 *   1. `generico` — varios repuestos calzan y ninguna moto los distingue:
 *      UNA pregunta de filtro, sin escalar en este turno.
 *   2. resultados con existencia — cotiza y escala con `confirmar_inventario`.
 *   3. resultados todos en cero — avisa y escala con `sin_stock`.
 *   4. sin resultados (o el motor de búsqueda no encontró términos) — avisa
 *      y escala con `no_identificado`.
 * Los tres textos que el modelo tiene que decir TEXTUAL vienen de `seba.ts`
 * (el cliente los dictó, o el operador los fijó para el caso 4): nunca se
 * escriben literales acá, para que no puedan desincronizarse de lo que dicta
 * el prompt (sección 5.1) ni de lo que exporta `seba.test.ts`.
 *
 * T2, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026, D1
 * del operador): antes de esta ola la pregunta de filtro era SIEMPRE por la
 * moto («¿para qué modelo y año?»), aunque el repuesto no dependiera de
 * ella — un aceite o un casco no necesitan saber la moto, y preguntarla de
 * todos modos era una vuelta de más. `GENERICO_INSTRUCTION` ahora lleva los
 * DOS textos fijos y deja que el modelo elija cuál preguntar, según si el
 * repuesto depende de la moto (piezas de motor, frenos, carrocería,
 * eléctrico, transmisión → `PREGUNTA_FILTRO`) o no (aceites, cascos,
 * intercomunicadores, maletas, accesorios → `PREGUNTA_FILTRO_PRODUCTO`) — el
 * código no puede decidir esto solo, no sabe de qué categoría es cada
 * repuesto.
 */
const GENERICO_INSTRUCTION =
  `El cliente no dio ningún dato que distinga cuál de los varios repuestos que calzan quiere: haz UNA sola pregunta de filtro y NO escales en este turno. Si el repuesto depende de la moto (piezas de motor, frenos, carrocería, eléctrico, transmisión), pregunta «${PREGUNTA_FILTRO}»; si no depende de la moto (aceites, cascos, intercomunicadores, maletas, accesorios), pregunta «${PREGUNTA_FILTRO_PRODUCTO}». Con la respuesta vuelves a buscar.`;

/**
 * T2 (25-26/9/2026, corrección del operador sobre la moto): el cliente SÍ
 * dio marca o modelo de moto, pero ningún repuesto de los que más calzan la
 * nombra — la moto no sirve para filtrar acá, así que volver a preguntarla
 * sería pedirle al cliente que repita un dato que ya dio. Manda SOLO
 * `PREGUNTA_FILTRO_PRODUCTO`, nunca `PREGUNTA_FILTRO`.
 */
const GENERICO_MOTO_IGNORADA_INSTRUCTION =
  `El cliente ya dijo el modelo de su moto, pero ninguno de los repuestos que más calzan lo menciona: la moto no sirve para filtrar acá. Haz UNA sola pregunta de filtro, «${PREGUNTA_FILTRO_PRODUCTO}» (no vuelvas a preguntar por la moto, el cliente ya la dio), y NO escales en este turno. Con la respuesta vuelves a buscar.`;

/**
 * Reemplaza a la vieja `SIN_STOCK_INSTRUCTION` ("alguno de estos repuestos
 * está en cero"), que solo avisaba sin obligar a escalar. Ahora, con AL
 * MENOS un resultado con existencia, se cotiza tal cual (los que estén en
 * cero se dicen como agotados) y se agrega el texto fijo del requisito 3.
 */
const CONFIRMAR_INVENTARIO_INSTRUCTION =
  `Da nombre, precio y stock tal como llegan (si alguno está en cero, dilo como agotado) y agrega textual: «${TEXTO_CONFIRMAR_INVENTARIO}». Luego llama a escalarAAsesor con motivo confirmar_inventario en este mismo turno.`;

/** Todos los resultados en cero (requisito 4): el texto fijo reemplaza cualquier oferta de "hay unidades". */
const SIN_STOCK_CASO_INSTRUCTION =
  `Di textual: «${TEXTO_SIN_STOCK}» y llama a escalarAAsesor con motivo sin_stock.`;

/**
 * Sin resultados, o sin términos de búsqueda reconocibles (requisito 2): el
 * catálogo no da para más, así que se pasa el caso de una vez sin inventar
 * alternativas.
 */
const NO_IDENTIFICADO_INSTRUCTION =
  `No encontraste nada, o no queda claro cuál es: di «${TEXTO_NO_IDENTIFICADO}» y llama a escalarAAsesor con motivo no_identificado. No inventes ni sugieras alternativas.`;

/**
 * K2 (20/9/2026): corrige un efecto colateral de K (commit 3d96863, "Seba
 * consulta el inventario antes de hablar de existencias"). Caso a mano del
 * mismo día, conversación local del +584140000012: el cliente reabrió un
 * chat con "hola, otra consulta"; el clasificador lo marcó
 * `consulta_disponibilidad` (la confusión `consulta_disponibilidad`↔`otro`
 * es el desacuerdo dominante del clasificador, ver CLAUDE.md, trampa "El
 * comparador de clasificación"); `tool-choice.ts` obligó al paso 0 a llamar
 * a `buscarRepuesto` SIN que el cliente hubiera nombrado ningún repuesto; la
 * herramienta devolvió sin resultados (`catalogOutcome.sinResultados =
 * true`) y la red de seguridad de `agent.ts` escaló con `no_identificado`
 * ("El cliente desea realizar otra consulta, pero no especificó qué
 * repuesto…"), quemando un asesor por cada mensaje vago — antes de K, Seba
 * habría preguntado qué necesita.
 *
 * `clienteNoNombroRepuesto` le da al modelo una salida sin tocar la base:
 * reutiliza la MISMA bandera `generico` que el requisito 5 de "Seba atiende
 * el mostrador" («la única pregunta») ya usa para bloquear la red de
 * seguridad del catálogo, así que no hace falta tocar `agent.ts`.
 *
 * K2b (20/9/2026): la primera versión de esta corrección hacía que la
 * bandera SOLO ganara cuando `searchTerms(query)` no encontraba ningún
 * término real, para no dejar de buscar un "casco LS2" nombrado de verdad.
 * Medido contra el modelo real (gemini-3.1-flash-lite, conversación local
 * del +584140000032, "buenas, tienen disponible?"): `query` es un string
 * OBLIGATORIO del esquema, así que el modelo INVENTA un texto para llenarlo
 * aunque marque la bandera — el log temporal capturó el argumento exacto
 * `{"query":"repuesto genérico","clienteNoNombroRepuesto":true}`. Ese texto
 * inventado trae palabras de sobra (≥3 letras) para calzar productos reales
 * del catálogo, así que la precedencia vieja NUNCA protegía nada en la
 * práctica: Seba cotizó carburador/filtros/pastillas al azar y escaló con
 * `confirmar_inventario` sobre un cliente que solo había preguntado si
 * había algo disponible.
 *
 * Ahora la bandera gana SIEMPRE, sin mirar `terms`, sin tocar la base (ni
 * `products` ni `ai_lessons`). Riesgo residual aceptado: si el modelo la
 * marca por error CON un producto de verdad en el `query` (el caso del
 * casco LS2 que motivó la precedencia vieja), Seba pregunta "¿qué buscas?"
 * en vez de buscar — molesto (el cliente tiene que repetirlo) pero
 * inofensivo, frente a cotizar al azar y quemar un asesor de verdad.
 */
export const PREGUNTA_QUE_BUSCA_INSTRUCTION =
  "El cliente todavía no dijo qué repuesto o producto busca: haz UNA sola pregunta para saber qué necesita y NO escales ni prometas un asesor en este turno. Con la respuesta vuelves a buscar.";

/** El `updated_at` más viejo del grupo, o null si ninguna fila trae fecha. */
function oldestUpdate(rows: { updated_at?: string | null }[]): string | null {
  const fechas = rows.map((row) => row.updated_at).filter((fecha): fecha is string => Boolean(fecha));
  return fechas.length === 0 ? null : fechas.reduce((viejo, fecha) => (fecha < viejo ? fecha : viejo));
}

interface ToolDeps {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  /**
   * Horario de la tienda (Frente B4, "El reloj dice la verdad", 5/9/2026):
   * solo lo usa `buildEscalateTool` para saber cuándo prometer que un asesor
   * escribe. Opcional porque el resto de las herramientas no lo necesitan y
   * `escalateConversation` ya tiene su propio default si llega `undefined`.
   */
  businessHours?: BusinessHours;
  /** Inyectable en tests; en producción usa el reloj real. */
  now?: Date;
}

/** Se llena cuando el turno escala, para que el orquestador sepa qué pasó sin volver a tocar la base de datos. */
export interface EscalationOutcome {
  escalated: boolean;
  motivo?: EscalationMotivo;
  assignedAgentName?: string;
  reason?: string;
  /**
   * La escalación quedó sin ningún asesor disponible (anexo A1, 5/9/2026).
   * Hasta el 14/9/2026 el orquestador la usaba para decidir si el mensaje
   * final es una despedida sin nadie detrás —`isAutoReply: true` en
   * `sendAgentText`—; desde la Tarea 5 ("La voz cercana y la espera
   * visible") la promesa de un asesor TAMPOCO es una respuesta real (170
   * promesas ≥ 30 min sin cumplir, 23 de ellas nunca atendidas, medidas en
   * la auditoría de esa tarea), así que `isAutoReply` pasó a depender solo
   * de `escalated` — este campo se sigue usando para elegir QUÉ despedida
   * fija mandar (`DESPEDIDA_SIN_ASESOR` vs. `despedidaConAsesor`, agent.ts).
   */
  unassigned?: boolean;
  /**
   * El horario de la tienda en el momento de escalar (Tarea 5, 14/9/2026):
   * `escalateConversation` lo calcula siempre (ver escalate.ts) y viaja acá
   * para que la despedida fija CON asesor (`despedidaConAsesor`, agent.ts) y
   * la instrucción que lee el modelo (`escalationInstruction`, este
   * archivo) usen el MISMO reloj — nunca uno recalculado después, que podría
   * cruzar el borde de la hora de cierre entre el escalamiento y el envío.
   */
  businessStatus?: BusinessStatus;
}

/**
 * T3, "Seba atiende el mostrador" (18/9/2026): lo que pasó en las llamadas al
 * catálogo durante EL MISMO turno, para que la red de seguridad de
 * `agent.ts` sepa si tiene que escalar en código cuando el modelo se quedó
 * sin pasos sin haberlo hecho (requisitos 2/3/4 del cliente: repuesto
 * encontrado, agotado o no identificado SIEMPRE terminan con un asesor).
 * Mismo patrón que `EscalationOutcome`: un objeto mutable que
 * `buildCatalogTool` va llenando, pasado por el orquestador.
 *
 * Se ACUMULA entre llamadas del mismo turno y nunca se resetea: una consulta
 * con existencia y otra sin resultados dejan `conExistencia = true` Y
 * `sinResultados = true` a la vez. La precedencia de qué motivo escala (si
 * hace falta) la decide `agent.ts`, no este tipo — acá solo se deja
 * constancia de lo que pasó.
 */
export interface CatalogOutcome {
  /** El tool se invocó al menos una vez en este turno. */
  ran: boolean;
  /** Alguna llamada devolvió al menos un repuesto con stock > 0. */
  conExistencia: boolean;
  /** Alguna llamada devolvió repuestos, pero todos en cero. */
  agotados: boolean;
  /** Alguna llamada no encontró nada (o sin términos de búsqueda reconocibles, o falló la consulta a la base). */
  sinResultados: boolean;
  /** Alguna llamada fue una consulta genérica: se le pidió UNA pregunta de filtro, sin escalar. */
  generico: boolean;
}

// ---------------------------------------------------------------------------
// Buscar repuesto — consulta_disponibilidad / otro. Solo lectura.
// ---------------------------------------------------------------------------
export function buildCatalogTool({ supabase, conversationId }: ToolDeps, catalogOutcome: CatalogOutcome) {
  return tool({
    description:
      `Busca repuestos en el catálogo real de ${BUSINESS_NAME} por nombre o marca del repuesto, y opcionalmente ordena primero los que calzan con la marca/modelo de la moto del cliente. Devuelve precio en USD y Bs (tasa BCV del día) y el stock disponible. Si no devuelve nada, ese repuesto no existe en el catálogo — no te lo inventes.`,
    inputSchema: z.object({
      // K2b (20/9/2026): "Si el cliente todavía no nombró ningún repuesto,
      // deja este campo vacío ("") y marca clienteNoNombroRepuesto" — se
      // suma esta frase al describe porque `query` sigue siendo obligatorio
      // (no se cambia la forma del esquema: hay proveedores que tratan mal
      // los campos opcionales) y sin esta instrucción el modelo rellena el
      // campo con un texto inventado que la búsqueda real puede llegar a
      // calzar (ver el comentario de PREGUNTA_QUE_BUSCA_INSTRUCTION).
      //
      // T2 (25-26/9/2026): "solo el nombre del repuesto y lo que lo
      // distingue" — nada de relleno ("precio", "tienen", "para"): ese
      // relleno ya lo descarta `catalogTermGroups` en código
      // (`RELLENO`, catalog-search.ts), pero pedírselo también al modelo
      // evita que arrastre una frase completa que diluye el puntaje de cada
      // grupo con palabras que ningún producto va a contener.
      query: z
        .string()
        .describe(
          "Solo el nombre del repuesto y lo que lo distingue -- marca, medida o modelo (ej. 'carburador', 'bujía NGK', 'maleta 45 litros'), sin relleno ('precio', 'tienen', 'para'). Si el cliente todavía no nombró ningún repuesto, deja este campo vacío (\"\") y marca clienteNoNombroRepuesto."
        ),
      // T2 (25-26/9/2026): motoBrand/motoModel ya NO filtran -- `product_
      // compatibility` está vacía hoy (ver CLAUDE.md), así que un filtro
      // real no tendría nada contra qué comparar. Lo que hacen es ORDENAR:
      // `buscar_productos` les da un bono de orden a los repuestos cuyo
      // nombre nombra la moto, y las nueve pastillas de freno de una BERA
      // quedan primero entre las pastillas si el cliente ya dijo "BERA".
      motoBrand: z
        .string()
        .optional()
        .describe("Marca de la moto del cliente, si la mencionó (ej. 'Bera'). Ordena los resultados, no filtra."),
      motoModel: z
        .string()
        .optional()
        .describe("Modelo de la moto del cliente, si lo mencionó (ej. 'SBR 200'). Ordena los resultados, no filtra."),
      // K2 (20/9/2026): ver el comentario de PREGUNTA_QUE_BUSCA_INSTRUCTION.
      clienteNoNombroRepuesto: z
        .boolean()
        .optional()
        .describe(
          "Marca true SOLO cuando el cliente todavía no dijo qué repuesto o producto busca (ej. 'tengo una consulta', 'otra pregunta', '¿tienen disponible?'). NUNCA la marques si nombró cualquier producto, aunque parezca que no lo vendemos (ej. 'casco LS2' SÍ es un producto nombrado: se busca)."
        ),
    }),
    execute: async ({ query, motoBrand, motoModel, clienteNoNombroRepuesto }) => {
      // T3 (18/9/2026): el tool "corrió" en cuanto el modelo lo invoca, sea
      // cual sea el resultado — la red de seguridad de `agent.ts` necesita
      // distinguir "nunca se consultó el catálogo" de "se consultó y no se
      // pudo decidir nada" (sin términos de búsqueda, o la consulta falló).
      catalogOutcome.ran = true;

      // K2b (20/9/2026): la bandera gana SIEMPRE, sin mirar los grupos ni
      // tocar la base (ni `buscar_productos` ni `ai_lessons`) — ver el
      // comentario largo de PREGUNTA_QUE_BUSCA_INSTRUCTION arriba: `query`
      // es obligatorio, así que el modelo siempre manda algo aunque no haya
      // repuesto que buscar, y ese "algo" puede calzar productos reales por
      // accidente.
      if (clienteNoNombroRepuesto === true) {
        catalogOutcome.generico = true;
        return { results: [], instruccionParaTuRespuesta: PREGUNTA_QUE_BUSCA_INSTRUCTION };
      }

      // T2 (25-26/9/2026): antes de tocar la base (ni siquiera los
      // sinónimos), se comprueba si `query` deja algún término reconocible.
      // Un sinónimo nunca CREA un grupo de la nada — solo suma una
      // alternativa a un grupo que ya existe (ver `catalogTermGroups`) — así
      // que esta comprobación con los sinónimos vacíos ya alcanza para saber
      // si va a quedar algo que buscar.
      if (catalogTermGroups(query).length === 0) {
        // Antes de T3 este caso volvía sin instrucción (uno de los "dos
        // sitios" del plan): el modelo se quedaba sin saber qué decir cuando
        // no había ni un término reconocible que buscar.
        catalogOutcome.sinResultados = true;
        return { results: [], instruccionParaTuRespuesta: NO_IDENTIFICADO_INSTRUCTION };
      }

      // Sinónimos de búsqueda (T5c, "Seba atiende el mostrador", 18/9/2026):
      // lo que un asesor le enseñó a Seba desde "Lecciones de Seba" —jerga
      // local que no calza con el nombre real del catálogo. Se leen ANTES de
      // armar los grupos porque el sinónimo tiene que entrar como una
      // alternativa MÁS del mismo grupo (T2, catalogTermGroups), no en una
      // segunda consulta. Un error acá no frena la búsqueda: se sigue con
      // los términos tal cual llegaron, ni mejor ni peor que antes de esta
      // tarea.
      //
      // F (20/9/2026, "El resguardo antes del push", C3): faltaba filtrar
      // por ALCANCE. `teach-seba-modal.tsx` permite guardar un sinónimo como
      // "Solo este chat" (`scope = 'conversacion'`, con `conversation_id`
      // propio) — sin este `.or()`, esa consulta traía TODOS los sinónimos
      // activos sin mirar su alcance, así que un sinónimo pensado para un
      // solo cliente se aplicaba a cualquier chat que consultara el
      // catálogo. Ahora solo entran los `scope = 'global'` (el default de la
      // UI) o los que nacieron en ESTA conversación.
      const { data: synonymRows } = await supabase
        .from("ai_lessons")
        .select("synonym_from, synonym_to")
        .eq("kind", "sinonimo")
        .eq("is_active", true)
        .or(`scope.eq.global,conversation_id.eq.${pgrstLiteral(conversationId)}`)
        .limit(MAX_SYNONYM_LESSONS);

      const synonyms: SearchSynonym[] = (synonymRows ?? [])
        .filter(
          (row): row is { synonym_from: string; synonym_to: string } =>
            typeof row.synonym_from === "string" && typeof row.synonym_to === "string"
        )
        .map((row) => ({ from: row.synonym_from, to: row.synonym_to }));

      // T1 (25-26/9/2026): los términos viajan como GRUPOS de alternativas
      // (un grupo calza si calza cualquiera) — necesario para que el
      // sinónimo sume una alternativa en vez de reemplazar el término, y
      // para que "dt200"/"dt 200" sean el MISMO grupo. `gruposMoto` sale de
      // la MISMA función, sin sinónimos: es jerga de moto ("bera", "sbr
      // 200"), no del repuesto — si el cliente no dio marca ni modelo, da
      // `[]` (grupos vacíos NUNCA excluyen nada, solo ordenan; ver la
      // migración `20260926010000`).
      const grupos = catalogTermGroups(query, synonyms);
      const gruposMoto = catalogTermGroups(`${motoBrand ?? ""} ${motoModel ?? ""}`);

      // T1 (25-26/9/2026): el orden, el puntaje y los conteos (cuántas filas
      // calzan el máximo, con o sin la moto) se calculan en SQL, sobre TODO
      // el conjunto de candidatos, ANTES de recortar a `MAX_CATALOG_RESULTS`
      // — el bug de origen (`tools.ts:333-335` hasta esta tarea) era
      // exactamente lo contrario: cortar con `.limit()` SIN order y recién
      // después ordenar esas pocas filas en memoria.
      const { data: rows, error } = await supabase.rpc("buscar_productos", {
        p_terminos: grupos,
        p_moto: gruposMoto,
        p_limite: MAX_CATALOG_RESULTS,
      });

      if (error) {
        // D3 (6/9/2026): antes este error se tragaba en silencio. El 5/9/2026
        // se buscó en vano el rastro de un "catálogo fuera de servicio" que
        // resultó ser el interruptor por herramienta apagado, pero la
        // búsqueda fue a ciegas porque un error real de la base tampoco
        // habría dejado nada en el log del servidor.
        log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(error) });
        // T3 (18/9/2026): un error de la base tampoco deja decidir nada — la
        // red de seguridad de `agent.ts` lo trata como "no identificado" si
        // el turno se queda sin pasos sin escalar.
        catalogOutcome.sinResultados = true;
        return {
          results: [],
          error: "No se pudo consultar el catálogo en este momento.",
          instruccionParaTuRespuesta: NO_IDENTIFICADO_INSTRUCTION,
        };
      }

      const candidatosRelevantes = rows ?? [];

      // T2 (25-26/9/2026, decisión del operador en el plan): con 1 a 3
      // grupos hace falta que calcen TODOS; con 4 o más se tolera que falte
      // uno solo (N-1) — "asiento sbr original" (3/3) y "disco freno
      // delantero dt200" (4/4, tolera 3) siguen calzando igual, medido
      // contra el catálogo real del VPS el 25/9/2026.
      const requerido = grupos.length <= 3 ? grupos.length : grupos.length - 1;

      if (candidatosRelevantes.length === 0 || candidatosRelevantes[0].puntaje_maximo < requerido) {
        catalogOutcome.sinResultados = true;
        return { results: [], instruccionParaTuRespuesta: NO_IDENTIFICADO_INSTRUCTION };
      }

      const puntajeMaximo = candidatosRelevantes[0].puntaje_maximo;
      const puntajeMotoMaximo = candidatosRelevantes[0].puntaje_moto_maximo;

      // Corrección del operador sobre la moto (plan, 25-26/9/2026): la moto
      // solo "calza" si el cliente la dio Y al menos una de las filas del
      // máximo puntaje la nombra. Si calza, se cotiza SOLO esa moto (nunca
      // genérico: el cliente ya filtró lo que pudo). Si no calza —sin moto,
      // o la moto no aparece en ninguna fila del máximo— la moto se ignora
      // por completo y rige la regla sin moto.
      const motoCalza = gruposMoto.length > 0 && puntajeMotoMaximo > 0;
      const motoIgnorada = gruposMoto.length > 0 && !motoCalza;

      const candidatos = motoCalza
        ? candidatosRelevantes.filter((r) => r.puntaje === puntajeMaximo && r.puntaje_moto === puntajeMotoMaximo)
        : candidatosRelevantes.filter((r) => r.puntaje === puntajeMaximo);

      // Los conteos vienen de la base, calculados ANTES del límite (ver el
      // comentario de la migración): `coinciden` nunca se mide contando el
      // arreglo que llegó acá, que ya puede venir recortado a
      // MAX_CATALOG_RESULTS por `p_limite`.
      const coinciden = motoCalza
        ? candidatosRelevantes[0].filas_con_maximo_y_moto
        : candidatosRelevantes[0].filas_con_puntaje_maximo;
      const hayMas = coinciden > MAX_CATALOG_RESULTS;

      // T3 (18/9/2026, requisito 5 "única pregunta"), corregido por T2
      // (25-26/9/2026): con la moto calzando NUNCA es genérico (el cliente
      // ya filtró lo que pudo). Sin ella —dada o no— es genérico cuando más
      // de tres filas comparten el puntaje máximo.
      const generico = !motoCalza && coinciden > 3;

      // T2 (25-26/9/2026): los filtros por `product_compatibility` se
      // mantienen sobre `compatibilidad`, pero hoy esa tabla tiene 0 filas
      // (medido en el VPS el 25/9/2026, ver CLAUDE.md) — así que
      // `compatibilidad` llega siempre `[]` y este filtro no descarta nada
      // todavía. El día que la tabla tenga datos, vuelve a filtrar solo.
      let filtered = candidatos;
      if (motoBrand) {
        filtered = filtered.filter(
          (p) =>
            p.compatibilidad.length === 0 ||
            p.compatibilidad.some((c) => c.moto_brand.toLowerCase().includes(motoBrand.toLowerCase()))
        );
      }
      if (motoModel) {
        filtered = filtered.filter(
          (p) =>
            p.compatibilidad.length === 0 ||
            p.compatibilidad.some((c) => c.moto_model.toLowerCase().includes(motoModel.toLowerCase()))
        );
      }

      const { rate, isStale } = await getBcvRate(supabase);

      const quoted = filtered.map((p) => ({
        id: p.id,
        nombre: p.name,
        marca: p.brand,
        precioUsd: p.currency === "USD" ? p.price : Number((p.price / rate).toFixed(2)),
        precioBs: p.currency === "USD" ? Number((p.price * rate).toFixed(2)) : p.price,
        stock: p.stock_quantity,
        compatibleCon: p.compatibilidad.map((c) => `${c.moto_brand} ${c.moto_model}`),
      }));

      // La antigüedad se mide por el repuesto MÁS VIEJO de los que se están
      // cotizando: la respuesta es tan confiable como el peor dato que lleva
      // dentro. Quedarse con el más reciente dejaría pasar justo el que puede
      // estar vendido.
      const freshness = inventoryFreshness(oldestUpdate(filtered));
      if (freshness.isStale) {
        // El mismo aviso que el del BCV y por la misma razón: una función
        // degradada que no se nota es peor que una que falla. Sin esta línea,
        // "el inventario lleva días congelado" solo se ve consultando la base.
        log.warn("inventario_desactualizado", {
          conversationId,
          dias: freshness.ageDays,
          desde: freshness.updatedAt,
        });
      }

      // Orden de precedencia dentro de esta llamada (genérico primero: es la
      // única que le prohíbe escalar).
      let casoInstruccion: string;
      if (generico) {
        catalogOutcome.generico = true;
        // T2 (25-26/9/2026, corrección del operador): si la moto llegó pero
        // se ignoró, no tiene sentido volver a preguntarla — el texto fijo
        // pasa a ser SOLO PREGUNTA_FILTRO_PRODUCTO.
        casoInstruccion = motoIgnorada ? GENERICO_MOTO_IGNORADA_INSTRUCTION : GENERICO_INSTRUCTION;
      } else if (quoted.length === 0) {
        catalogOutcome.sinResultados = true;
        casoInstruccion = NO_IDENTIFICADO_INSTRUCTION;
      } else if (quoted.some((q) => q.stock > 0)) {
        catalogOutcome.conExistencia = true;
        casoInstruccion = CONFIRMAR_INVENTARIO_INSTRUCTION;
      } else {
        catalogOutcome.agotados = true;
        casoInstruccion = SIN_STOCK_CASO_INSTRUCTION;
      }

      // Las advertencias se juntan en una sola instrucción: el modelo lee una
      // frase, no un formulario. El recorte se calla en el caso genérico: ahí
      // la instrucción ya dice "no listes, pregunta primero", y avisar "hay
      // más" encima contradice ese pedido.
      const instrucciones = [
        casoInstruccion,
        inventoryAgeInstruction(freshness),
        !generico && hayMas ? RECORTE_INSTRUCTION : null,
      ].filter((linea): linea is string => linea !== null);

      // El monto de una venta sale de lo que se cotizó acá, no de un número
      // que el agente escriba a mano al cerrar -- por eso se deja registro
      // de cada resultado que el modelo efectivamente vio, con el precio
      // exacto en el momento de la cotización.
      if (quoted.length > 0) {
        await supabase.from("conversation_quotes").insert(
          quoted.map((q) => ({
            conversation_id: conversationId,
            product_id: q.id,
            product_name: q.nombre,
            price_usd: q.precioUsd,
            price_bs: q.precioBs,
            bcv_rate: rate,
          }))
        );
      }

      return {
        // El precio va como texto ya escrito y los números crudos se quedan
        // acá. Convertir o reformatear un número es aritmética, y es donde
        // los modelos alucinan; sin el número no hay nada que calcular.
        results: quoted.map((q) => ({
          nombre: q.nombre,
          marca: q.marca,
          precio: formatQuote(q.precioUsd, q.precioBs),
          stock: q.stock,
          compatibleCon: q.compatibleCon,
        })),
        tasaBcvUsada: rate,
        tasaDesactualizada: isStale,
        inventarioDesactualizado: freshness.isStale,
        hayMas,
        // T3 (18/9/2026): antes esta clave solo aparecía si había algo que
        // avisar (stock en cero, inventario viejo, recorte); ahora SIEMPRE
        // hay una instrucción de caso (generico/existencia/agotado/sin
        // resultados), así que la condición sobra — pero se conserva el
        // `.filter` de arriba porque las otras dos líneas siguen siendo
        // opcionales.
        instruccionParaTuRespuesta: instrucciones.join(" "),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Historial de compras — devolucion. Solo lectura: no hay forma de aprobar,
// rechazar ni modificar nada desde esta herramienta.
// ---------------------------------------------------------------------------
export function buildOrderHistoryTool({ supabase, contactId, conversationId }: ToolDeps) {
  return tool({
    description:
      "Consulta el historial real de compras del cliente (qué compró, cuándo, cuánto pagó). Solo lectura: úsala para armar contexto, nunca para aprobar ni procesar una devolución.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data: orders, error } = await supabase
        .from("orders")
        .select("id, purchased_at, total_amount, currency, order_items(description, quantity, unit_price)")
        .eq("contact_id", contactId)
        .order("purchased_at", { ascending: false })
        .limit(10);

      if (error) {
        // D3 (6/9/2026): mismo rastro que la herramienta de catálogo, misma
        // historia (ver el comentario de arriba en `buildCatalogTool`).
        log.error("herramienta_historial_fallo", { conversationId, detail: errorText(error) });
        return { orders: [], error: "No se pudo consultar el historial de compras." };
      }

      return {
        orders: (orders ?? []).map((o) => ({
          fecha: o.purchased_at,
          total: o.total_amount,
          moneda: o.currency,
          items: o.order_items.map((i) => ({
            descripcion: i.description,
            cantidad: i.quantity,
            precioUnitario: i.unit_price,
          })),
        })),
      };
    },
  });
}

/**
 * La instrucción con la que el modelo redacta la despedida al escalar, con o
 * sin asesor asignado.
 *
 * Nace en el Frente B4 ("El reloj dice la verdad", 5/9/2026) cubriendo solo
 * el caso SIN asesor: hasta ahí la IA no sabía si la tienda estaba abierta,
 * así que no podía decir cuándo la iban a atender sin arriesgarse a prometer
 * un plazo falso ("ya te atienden" a las 2 am de un domingo). La Tarea 5
 * ("La voz cercana y la espera visible", 14/9/2026) encontró la MISMA falla
 * del lado CON asesor —170 promesas "ya te paso con un asesor" en 72 h, 23
 * con la tienda ya cerrada y sin decir cuándo— y la cerró acá, renombrando la
 * función (antes `unassignedEscalationInstruction`) porque dejó de ser
 * exclusiva del caso sin asesor.
 *
 * Con `businessStatus` ya calculado por `escalateConversation` (mismo
 * `now`/horario que dejó el evento de sistema, SIEMPRE presente desde la
 * Tarea 5 — ver escalate.ts), acá solo se traduce a prosa, en las cuatro
 * combinaciones de asesor × horario:
 * - con asesor, abierta: cálida, sin horario ("un asesor toma su caso").
 * - con asesor, cerrada: agradece la paciencia y nombra cuándo escribe el
 *   asesor (día y hora exactos, o "apenas la tienda vuelva a abrir" si no hay
 *   ninguna franja en los próximos 7 días).
 * - sin asesor, abierta: promete "en breve", que sí es cierto porque hay
 *   quién conteste hoy.
 * - sin asesor, cerrada: mismo criterio de B4, con o sin próxima apertura.
 *
 * Tarea 3 ("La voz cercana y la espera visible", 14/9/2026): hasta acá solo
 * la rama "con asesor, cerrada" llevaba calidez explícita ("dile con
 * calidez..."); las otras tres decían el hecho seco ("un asesor lo va a
 * atender", "su caso quedó registrado") sin agradecer ni suavizar. Las
 * cuatro ramas reciben ahora el mismo trato: agradecer la espera o la
 * paciencia, y nombrar con calidez lo que va a pasar.
 *
 * Corrección del 15/9/2026 (verificación final de "La voz de mostrador con
 * nombre propio y el cierre de v1.1"): un chat NUEVO ("buenas tardes,
 * tienen tanque de EK Xpress") no encontró stock, escaló por
 * `escalarAAsesor` (motivo `seguimiento`) y la redacción final salió SIN el
 * saludo de franja que `needsGreeting` pedía en el sufijo de `prompt.ts` —el
 * modelo obedece la ÚLTIMA instrucción que lee, y esta no mencionaba el
 * saludo, así que se lo comía. Las cuatro ramas terminan ahora con
 * `RECORDATORIO_SALUDO` para que el saludo del primer mensaje sobreviva
 * también cuando el turno termina en una escalada.
 *
 * 18/9/2026 (T2b, plan "Seba atiende el mostrador"): el saludo dejó de ser
 * algo que el modelo redacta — sale como mensaje aparte, por código, ANTES
 * del tool loop (`sebaGreeting`, agent.ts). El riesgo que motivó este
 * recordatorio en 15/9 ya no existe (no hay ningún saludo que el modelo
 * pueda "comerse"), pero el texto se conserva con el sentido inverso: sigue
 * siendo la ÚLTIMA instrucción que las cuatro ramas le dejan al modelo, así
 * que tiene que seguir diciendo la verdad — no saludes, ya se presentó.
 */
export const RECORDATORIO_SALUDO =
  " No saludes ni te presentes: Seba ya se presentó en un mensaje aparte.";

function escalationInstruction(status: BusinessStatus | undefined, assignedName: string | null): string {
  const abierta = !status || status.open;

  if (assignedName) {
    if (abierta) {
      return `Ya está asignado a ${assignedName}. Dile al cliente, con calidez, que un asesor toma su caso y le escribe por acá; agradécele la espera.${RECORDATORIO_SALUDO}`;
    }
    const cuando = status?.nextOpening
      ? `${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}`
      : "apenas la tienda vuelva a abrir";
    return `Ya está asignado a ${assignedName}, pero la tienda está cerrada. Dile al cliente, con calidez, que un asesor toma su caso y le escribe ${cuando}; agradécele la paciencia. NO prometas que lo atienden ahora.${RECORDATORIO_SALUDO}`;
  }

  if (abierta) {
    return `No hay ningún asesor conectado ahora. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben en breve, apenas haya alguien disponible; agradécele la espera. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  if (!status?.nextOpening) {
    return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben apenas la tienda vuelva a abrir; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que un asesor le escribe ${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
}

/** Los siete motivos de siempre, sin asesor asignado todavía. */
const MOTIVOS_COMPLETOS = [
  "devolucion",
  "queja",
  "intencion_compra",
  "seguimiento",
  "confirmar_inventario",
  "sin_stock",
  "no_identificado",
] as const;

/**
 * T2, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026,
 * D2 del operador). Medido en producción el 21/9/2026: en la primera hora
 * del deploy, 24 de 34 turnos escalados eran repeticiones sobre un chat que
 * YA tenía asesor asignado (bastaban 9) — el modelo no tenía forma de saber
 * que el caso ya estaba en manos de alguien, así que volvía a llamar
 * `escalarAAsesor` en cada mensaje del cliente. `escalate.ts` ya lo
 * detectaba (rama `alreadyAssigned`, solo deja una nota interna "IA reiteró
 * la escalada…"), pero la vuelta completa al proveedor ya se había pagado.
 * Con un asesor asignado, `buildEscalateTool` recorta el enum de `motivo` a
 * este único valor: la única razón real para volver a tocar la herramienta
 * es que el cliente ACABA de confirmar que quiere comprar (deja
 * `deal_status: "in_progress"`, ver `escalate.ts`), no repetir el pase.
 */
const MOTIVOS_RESTRINGIDOS = ["intencion_compra"] as const;

const RESUMEN_DESCRIBE =
  // T1 (21/9/2026): tope de 600 caracteres — las dos espirales medidas en
  // producción también inflaban este campo en cada llamada repetida a la
  // herramienta. Corrección 4b de la revisión de T1 (21/9/2026): el
  // `.max(600)` ya existía, pero el describe no se lo decía al modelo —
  // se enteraba recién por un error de validación que le quema un paso.
  "Resumen para el asesor: qué quiere el cliente, qué compró si aplica, y por qué se escala. Máximo 600 caracteres.";

/**
 * "Solo si motivo='queja'…": la categoría queda igual en las dos variantes
 * de la herramienta — en modo restringido el modelo nunca podrá elegir
 * `queja` (el enum de `motivo` no la admite), así que este campo queda
 * simplemente sin uso ahí, sin necesidad de un esquema aparte para omitirlo.
 */
function categoriaReclamoField() {
  return z
    .enum(RECLAMO_CATEGORIES)
    .optional()
    .describe("Solo si motivo='queja': la categoría que mejor describe el reclamo.");
}

/**
 * El `execute` de `escalarAAsesor`, compartido entre el modo completo y el
 * restringido — la única diferencia entre los dos es el ESQUEMA de entrada
 * (`inputSchema`, más abajo), nunca qué hace la llamada una vez que zod ya
 * validó `motivo`.
 *
 * `pending` guarda la promesa de la PRIMERA escalada de este turno (T1,
 * 21/9/2026): se asigna de forma SÍNCRONA, antes del primer `await`, así que
 * dos tool calls disparadas juntas en el mismo paso (sin esperar la primera)
 * también quedan cubiertas — la segunda invocación ve `pending` ya asignado
 * por la primera, sin haber corrido todavía ningún código asíncrono de por
 * medio.
 *
 * Corrección 4a de la revisión de T1 (21/9/2026): hasta acá `pending` quedaba
 * cacheado PARA SIEMPRE en cuanto la primera llamada terminaba — si
 * `escalateConversation` lanzaba, o algún día devolviera `escalated: false`,
 * un segundo intento legítimo del modelo en el MISMO turno se topaba con esa
 * promesa rota/negativa sin poder volver a intentarlo de verdad. Ahora, si el
 * resultado no cuajó (`!result.escalated`) o la promesa rechaza, `pending`
 * vuelve a `null` para que la siguiente llamada invoque `escalateConversation`
 * de nuevo — solo una escalada que SÍ salió bien queda cacheada el resto del
 * turno.
 */
function buildEscalateExecute(
  { supabase, conversationId, contactId, businessHours, now }: ToolDeps,
  outcome: EscalationOutcome
) {
  let pending: Promise<EscalateResult & { instruccionParaTuRespuesta: string }> | null = null;

  return async ({
    motivo,
    resumen,
    categoriaReclamo,
  }: {
    motivo: EscalationMotivo;
    resumen: string;
    categoriaReclamo?: ReclamoCategory;
  }) => {
    // T1 (21/9/2026): ya hay una escalada en curso (o resuelta) en este
    // turno — se devuelve el MISMO resultado sin tocar la base ni reclamar
    // otro asesor. `escalateConversation` (escalate.ts) no se toca: la
    // segunda llamada nunca llega a invocarla.
    if (pending) {
      log.info("escalada_repetida_en_el_turno", { conversationId, motivo });
      return pending;
    }

    const attempt = (async () => {
      const result = await escalateConversation(supabase, {
        conversationId,
        contactId,
        motivo,
        resumen,
        categoriaReclamo,
        businessHours,
        now,
      });

      if (!result.escalated) {
        // Corrección 4a: una escalada que no cuajó no puede dejar `pending`
        // cacheado para el resto del turno.
        pending = null;
      }

      outcome.escalated = result.escalated;
      outcome.motivo = motivo;
      outcome.assignedAgentName = result.assignedAgentName ?? undefined;
      outcome.reason = result.reason;
      outcome.unassigned = result.unassigned;
      outcome.businessStatus = result.businessStatus;

      // El modelo redacta el cierre con esto, así que se le dice en palabras
      // qué prometer: ni con asesor ni sin él puede decir «ya te atienden»
      // sin saber si la tienda está abierta (Tarea 5, 14/9/2026).
      return {
        ...result,
        instruccionParaTuRespuesta: escalationInstruction(result.businessStatus, result.assignedAgentName ?? null),
      };
    })();

    // Corrección 4a: si `escalateConversation` LANZA, `pending` se libera
    // igual que cuando devuelve `escalated: false` — de lo contrario una
    // excepción transitoria quedaría cacheada para siempre. El error sigue
    // propagándose a quien esté esperando `attempt` (el tool loop del SDK);
    // este `.catch` es solo para resetear la variable, nunca para tragarlo.
    attempt.catch(() => {
      pending = null;
    });

    pending = attempt;
    return attempt;
  };
}

// ---------------------------------------------------------------------------
// Escalar a un asesor — devolucion, queja, e intención de compra dentro de
// consulta_disponibilidad. Única forma de tocar dinero o cerrar un caso: la
// IA nunca aprueba, rechaza ni cierra nada por su cuenta.
// ---------------------------------------------------------------------------
export function buildEscalateTool(
  deps: ToolDeps,
  outcome: EscalationOutcome,
  /**
   * T2, plan "La escalada se hace una vez y la búsqueda responde"
   * (21/9/2026, D2 del operador). `agent.ts` la pasa en `true` cuando el
   * chat que abre el turno YA tiene asesor asignado — ver `esperandoAsesor`
   * en `runTurnPhases`. Default `false`: sin asesor, la herramienta se
   * arma exactamente como siempre.
   */
  opciones: { restrictedToPurchase?: boolean } = {}
) {
  const restrictedToPurchase = opciones.restrictedToPurchase ?? false;
  const execute = buildEscalateExecute(deps, outcome);

  if (restrictedToPurchase) {
    return tool({
      // T2 (21/9/2026): con asesor asignado, la herramienta deja de ser "la
      // única forma de pasar el caso" (ya está pasado) y pasa a ser
      // solamente el gatillo para marcar que el cliente confirmó la compra.
      description:
        "Este chat YA tiene un asesor asignado que todavía no le escribió al cliente. Úsala SOLO cuando el cliente ACABA de confirmar que quiere comprar (motivo intencion_compra), para dejar marcada la venta en curso — no la llames para volver a pasar el caso ni para pedir que lo atiendan: el asesor ya lo tiene.",
      inputSchema: z.object({
        motivo: z
          .enum(MOTIVOS_RESTRINGIDOS)
          .describe(
            "El único motivo posible en este chat: intencion_compra, cuando el cliente acaba de confirmar que quiere comprar. Deja marcada la venta en curso; no vuelve a pasar el caso, el asesor ya lo tiene."
          ),
        resumen: z.string().max(600).describe(RESUMEN_DESCRIBE),
        categoriaReclamo: categoriaReclamoField(),
      }),
      execute,
    });
  }

  return tool({
    // 18/9/2026 (T2a, plan "Seba atiende el mostrador", requisito 6 del
    // cliente): hasta acá esta descripción decía "pausa la IA" — escalar
    // apagaba el turno en el acto (`escalate.ts`, `ai_enabled: false`). El
    // requisito 6 pide lo contrario: tras pasar el caso, Seba sigue
    // respondiendo lo que el cliente pregunte en ese chat hasta que el
    // asesor escriba su primer mensaje real, y recién ahí se calla. La
    // reescritura de `escalate.ts` para que de verdad deje de apagar
    // `ai_enabled` es tarea aparte (T4 del plan); acá solo se corrige lo que
    // el modelo lee sobre qué hace esta herramienta.
    //
    // Reescrito el 22-23/9/2026 (T5, plan "Seba no habla de más mientras el
    // cliente espera al asesor", opción (b) del operador): "la IA sigue
    // contestando en este chat" dejó de ser cierto — medido en producción el
    // 22/9/2026, 27 % de los mensajes de Seba salían con una escalada
    // abierta, la mayoría puro relleno ("el asesor ya tiene tu caso"), hasta
    // 6 en la misma espera. Desde esta tarea, después de escalar, el chat
    // pasa por el camino "espera abierta" de `runTurnPhases` (agent.ts): ni
    // tool loop ni clasificación, solo un escenario ya redactado del panel
    // si calza con lo que el cliente pregunta — el resto queda anotado para
    // el asesor, sin mensaje nuevo al cliente.
    description:
      "Escala la conversación a un asesor de la tienda: asigna al asesor con más tiempo sin recibir un cliente nuevo, y deja un resumen para que no tenga que volver a preguntar todo. Después de esto YA NO vas a poder redactar respuestas nuevas en este chat: si el cliente escribe algo más mientras espera, solo se le contesta si calza un escenario informativo ya armado del panel — lo demás queda anotado para que el asesor lo vea. Es la única forma de tocar dinero real (devoluciones, ventas) o reclamos — la IA nunca los resuelve sola.",
    inputSchema: z.object({
      // Tarea 7 ("El guion atiende a quien no es cliente…", 14/9/2026): suma
      // `seguimiento` (ya admitido por `EscalationMotivo` en escalate.ts,
      // que no tuvo que tocarse) para el aviso de reposición de un repuesto
      // agotado, las listas largas o de mayoreo, y la postventa en general —
      // casos que no son ni una devolución, ni una queja, ni una venta en
      // curso, y que hasta ahora no tenían dónde caer sin forzar uno de los
      // otros tres motivos.
      // T3 (18/9/2026, requisitos 2/3/4): suma confirmar_inventario, sin_stock
      // y no_identificado — los tres motivos con los que `buildCatalogTool`
      // le pide al modelo que escale tras cotizar. Sin `consulta_generica`:
      // ese caso (requisito 5) pide una pregunta y a propósito no escala.
      motivo: z
        .enum(MOTIVOS_COMPLETOS)
        .describe(
          "Por qué se escala: devolucion (quiere devolver o cambiar algo que ya compró), queja (reclamo), intencion_compra (quiere comprar y hay que cobrarle), seguimiento (avisar cuando llegue un repuesto agotado, una lista larga o de mayoreo, o cualquier postventa que no sea devolución ni queja), confirmar_inventario (el catálogo mostró un repuesto con existencia y hay que confirmar el inventario físico), sin_stock (el catálogo marca cero unidades), no_identificado (no se encontró el repuesto en el catálogo, o no quedó claro cuál es)."
        ),
      resumen: z.string().max(600).describe(RESUMEN_DESCRIBE),
      categoriaReclamo: categoriaReclamoField(),
    }),
    execute,
  });
}
