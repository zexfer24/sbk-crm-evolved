import {
  DEFAULT_BUSINESS_HOURS,
  businessMinutesBetween,
  type BusinessHours,
} from "@/lib/business-hours";
import type {
  AgentRef,
  BoardConversation,
  JourneyStageId,
  Tag,
  TicketTagsByContact,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Reclamos
//
// Un reclamo no es una entidad aparte: es un contacto etiquetado. Cualquier
// etiqueta cuyo nombre empiece por "Reclamo" cuenta como tal, y lo que va
// después del separador es la categoría ("Reclamo · Envío" -> "Envío").
// Así el equipo abre categorías nuevas desde el panel de etiquetas, sin
// tocar el código ni la base de datos.
// ---------------------------------------------------------------------------

const TICKET_PREFIX = "reclamo";
const CATEGORY_SEPARATORS = /[·:\-–—/]/;

const DIACRITICS = /[̀-ͯ]/g;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .trim()
    .toLowerCase();
}

export function isTicketTag(tag: Tag): boolean {
  return normalize(tag.label).startsWith(TICKET_PREFIX);
}

export function ticketCategory(tag: Tag): string {
  const parts = tag.label.split(CATEGORY_SEPARATORS);
  const tail = parts.slice(1).join(" ").trim();
  return tail.length > 0 ? tail : "General";
}

/**
 * Las etiquetas de reclamo de una conversación.
 *
 * Salen de un mapa por contacto y no de la propia fila: el tablero pide
 * cientos de conversaciones de una vez, y embeberle a cada una sus etiquetas
 * cuesta un lateral por fila en PostgREST. El mapa son dos consultas planas
 * (ver `fetchTicketTags`).
 */
export function ticketTagsOf(
  conversation: Pick<BoardConversation, "contact">,
  ticketTags: TicketTagsByContact
): Tag[] {
  return ticketTags.get(conversation.contact.id) ?? [];
}

export function isTicket(
  conversation: Pick<BoardConversation, "contact">,
  ticketTags: TicketTagsByContact
): boolean {
  return ticketTagsOf(conversation, ticketTags).length > 0;
}

// ---------------------------------------------------------------------------
// Recorrido del cliente
//
// El recorrido que describe el operador (5/9/2026, "El reloj dice la
// verdad"): Primer contacto → Consulta → Clasificando → Herramienta → Con
// asesor. `journey_stage` es lo que escribe la IA en vivo, pero es un resto
// que puede quedar congelado (un turno rechazado por Meta, por ejemplo, ver
// `rejectedByMeta` en `agent.ts`/A3) o directamente pegajoso
// (`journey_stage = 'assigned'` sobrevive a que el asesor se desasigne).
// `stageOf` YA NO confía en él a ciegas: solo lo consulta donde la etapa no
// se puede deducir de otra cosa (`classifying`/`tool_running`), y siempre
// bajo `awaitingReply` — sin eso es un resto, no una etapa real.
//
// Corrida "Los números del día" (10/9/2026, pedido del operador): el
// tablero pasa a mostrar SOLO el día en curso y el orden se da vuelta. Tres
// cambios, todos con un `dayStart?: string | null` opcional que viaja hasta
// `stageOf`/`waitingMinutes`/`isStalled`/`buildJourney` para no romper a
// quien todavía llama sin él (`journey-board.tsx` no necesita tocarse):
//   1. `buildJourney` filtra, ADEMÁS de `isActive`, con el mismo corte
//      "habló hoy" que ya usa la bandeja (`matchesDay`, `inbox-filters.ts`,
//      trampa "El corte habló hoy tiene UNA sola fuente" en CLAUDE.md) —
//      replicado acá abajo, sin importarlo, porque `inbox-filters.ts` ya
//      importa `awaitingReply`/`contactName` de este archivo y la vía
//      contraria crearía un ciclo. Se aplica en memoria, no en la consulta:
//      `ticketQueue`, en este mismo archivo, necesita reclamos de
//      CUALQUIER fecha.
//   2. El peldaño de `first_contact` deja de exigir `!awaitingReply`: pasa
//      a significar "escribió por primera vez HOY y la IA todavía no le
//      contestó", así que ahora SÍ se atasca (`stallMinutes: 15`, antes
//      `null` — "nunca se atasca").
//   3. El orden dentro de cada etapa se da vuelta: "mayor espera arriba"
//      (5/9/2026) pasa a "más nuevo arriba" — el punto rojo de atasco y el
//      contador "N atascados" conservan la urgencia, el orden ya no tiene
//      que hacerlo también.
//
// Corrida "El Recorrido cuenta los números nuevos del día" (10/9/2026,
// mismo día, segunda vuelta): el peldaño 4 de `stageOf` —"recibió la
// bienvenida y no volvió a escribir"— dependía de `welcomeSentAt`, y
// `WHATSAPP_WELCOME_TEMPLATE` está vacía desde siempre: `welcome_sent_at`
// nunca se sella y la columna "Primer contacto" medía, en producción el
// 10/9/2026, CERO sobre 119 números nuevos del día (90 ya con asesor, 28 ya
// con respuesta real). Sacar solo el requisito de `welcomeSentAt` no
// arreglaba nada de fondo: habría mostrado 1 de 119, porque casi ningún
// lead nuevo se queda quieto más de un instante en un peldaño de escalera.
// El problema no era ESE campo, era que la etapa seguía siendo un peldaño
// EXCLUSIVO. El operador decidió otra cosa: "Primer contacto" deja la
// escalera y pasa a ser una COLUMNA DE COHORTE — todo lo que entró hoy al
// sistema (`isFirstContact`, más abajo), aparezca donde aparezca ADEMÁS en
// su etapa real. Una conversación puede salir en dos columnas del tablero a
// la vez, a propósito. `stageOf` pierde el peldaño 4 entero y nunca vuelve a
// devolver `"first_contact"` (de ahí su tipo de retorno,
// `Exclude<JourneyStageId, "first_contact">`: el compilador lo garantiza).
// `stageDetail` y el `stallMinutes` de la cohorte delegan en la etapa real
// de cada tarjeta — ver los comentarios de cada uno.
// ---------------------------------------------------------------------------

export interface JourneyStage {
  id: JourneyStageId;
  label: string;
  caption: string;
  /**
   * Minutos a partir de los cuales una conversación en esta etapa se
   * considera atascada. `null` = nunca se atasca en esta etapa.
   *
   * Para "Primer contacto" esto es documentación, no comportamiento, desde
   * la corrida "El Recorrido cuenta los números nuevos del día" (10/9/2026,
   * segunda vuelta del mismo día): la etapa dejó de ser un peldaño de la
   * escalera y pasó a ser una columna de cohorte, así que `stageOf` ya NUNCA
   * devuelve `"first_contact"` — e `isStalled`, que busca el umbral
   * indexando esta lista por `stageOf(conversation)`, jamás llega a
   * consultar esta entrada. Cada tarjeta de la cohorte se marca atascada con
   * el umbral de su etapa REAL (60 min laborales con asesor, 15 sin él), no
   * con este número. Volvió a `null` (fue `15` entre las dos corridas del
   * 10/9/2026, cuando el peldaño 4 todavía existía) para que quien lea esto
   * no crea que la cohorte tiene reloj propio.
   */
  stallMinutes: number | null;
  conversations: BoardConversation[];
  stalled: number;
}

const STAGE_DEFINITIONS: Omit<JourneyStage, "conversations" | "stalled">[] = [
  {
    id: "first_contact",
    label: "Primer contacto",
    // 10/9/2026, "El Recorrido cuenta los números nuevos del día": deja de
    // describir un momento del recorrido (ni "la IA le responde" ni
    // "esperamos su siguiente mensaje" son ciertos para toda la cohorte) y
    // pasa a describir la columna misma — números que entraron hoy, estén
    // donde estén parados de verdad.
    caption: "Números nuevos de hoy; también aparecen en su etapa",
    stallMinutes: null,
  },
  {
    id: "inquiry",
    label: "Consulta",
    caption: "Pregunta y espera respuesta",
    stallMinutes: 15,
  },
  {
    id: "classifying",
    label: "Clasificando",
    caption: "La IA determina qué necesita",
    stallMinutes: 5,
  },
  {
    id: "tool_running",
    label: "Herramienta",
    caption: "La IA consulta o ejecuta una herramienta",
    stallMinutes: 3,
  },
  {
    id: "assigned",
    label: "Con asesor",
    caption: "Un asesor lleva el caso",
    stallMinutes: 60,
  },
];

/** La última etapa se pinta como destino del recorrido, no como una más. */
export const TERMINAL_STAGE: JourneyStageId = "assigned";

/** El tablero solo muestra recorridos vivos: lo cerrado ya no está en camino. */
export function isActive(conversation: BoardConversation): boolean {
  return conversation.status !== "closed";
}

/**
 * Escalera de la etapa. Nació el 5/9/2026 ("El reloj dice la verdad") con
 * cinco peldaños, uno de ellos `first_contact` ("recibió la bienvenida y no
 * volvió a escribir"). El 10/9/2026 tuvo dos corridas seguidas sobre ese
 * peldaño: "Los números del día" le sacó el requisito `!awaitingReply"; unas
 * horas después, midiendo en producción, "El Recorrido cuenta los números
 * nuevos del día" encontró que el peldaño entero dependía de
 * `welcomeSentAt` y que `WHATSAPP_WELCOME_TEMPLATE` vacía significa que ese
 * campo NUNCA se sella —la columna medía 0 de 119 leads nuevos reales esa
 * mañana—, así que el operador sacó el peldaño 4 de la escalera por
 * completo: "Primer contacto" pasa a ser una columna de cohorte aparte
 * (`isFirstContact`, `buildJourney`), no un estado de esta función. La
 * escalera queda en CUATRO peldaños y esta función NUNCA devuelve
 * `"first_contact"` (de ahí el tipo de retorno,
 * `Exclude<JourneyStageId, "first_contact">`). Primer peldaño que cumple,
 * gana:
 *
 * 1. Hay asesor asignado → `assigned`. Un `journey_stage = 'assigned'` SIN
 *    asesor ya no cuenta acá (el punto 3 del diagnóstico: el lead sin dueño
 *    disfrazado de atendido) — sigue bajando la escalera.
 * 2. Espera respuesta y hay una herramienta corriendo (en vivo o escrita en
 *    `journey_stage`) → `tool_running`.
 * 3. Espera respuesta, `journey_stage = 'classifying'` y la IA sigue activa
 *    → `classifying`. Sin `awaitingReply`, un `classifying`/`tool_running`
 *    escrito es un resto congelado (punto 4 del diagnóstico, ver
 *    `rejectedByMeta` en `agent.ts`) y no se honra: sigue bajando.
 * 4. Todo lo demás → `inquiry`. Cubre dos casos bien distintos a propósito:
 *    el cliente pregunta y espera (atascable) y el cliente calló tras la
 *    respuesta de la IA (no atascable, se pinta en gris) — los separa
 *    `awaitingReply`, no la etapa.
 */
export function stageOf(
  conversation: BoardConversation
): Exclude<JourneyStageId, "first_contact"> {
  if (conversation.assignedAgent) return "assigned";

  const waiting = awaitingReply(conversation);

  if (waiting && (conversation.activeTool || conversation.journeyStage === "tool_running")) {
    return "tool_running";
  }

  if (waiting && conversation.journeyStage === "classifying" && conversation.aiEnabled) {
    return "classifying";
  }

  return "inquiry";
}

/**
 * ¿Esta conversación entró HOY al sistema? Reemplaza al peldaño 4 que tenía
 * `stageOf` hasta el 10/9/2026 (ver el docblock de arriba): "Primer
 * contacto" deja de ser un estado exclusivo de la escalera y pasa a ser una
 * columna de COHORTE — todo lo que llegó hoy, aparezca donde aparezca
 * además en su etapa real (`stageOf`). Una conversación puede salir en dos
 * columnas del tablero a la vez, a propósito.
 *
 * Usa `conversations.created_at`, no `welcomeSentAt`: el webhook busca la
 * conversación por `contact_id + whatsapp_channel_id` con `maybeSingle`
 * (`src/app/api/webhooks/whatsapp/route.ts`) y una conversación cerrada se
 * REABRE, nunca se recrea — hay una conversación por número y canal, para
 * siempre, así que `createdAt` es de verdad "cuándo entró el número al
 * sistema".
 *
 * Dos casos que fallan a `false` a propósito:
 * - Sin `lastCustomerMessageAt`: un contacto agregado a mano desde la
 *   bandeja (T6, "Seis frentes del buzón") que todavía no escribió no es un
 *   lead que llegó, es una fila vacía.
 * - `dayStart` nulo: sin día no hay cohorte que contar. Esto es lo
 *   CONTRARIO del viejo `createdToday` de `stageOf` (que sin `dayStart`
 *   dejaba pasar cualquier fecha, para no romper a un llamador que todavía
 *   no lo conocía) — acá dejar pasar todo duplicaría CADA tarjeta del
 *   tablero contra la columna de cohorte, así que el default seguro es el
 *   opuesto.
 *
 * Comparación NUMÉRICA con `Date.parse`, nunca de texto: `dayStart` sale de
 * `toISOString()` (sufijo `Z`) y Supabase devuelve `timestamptz` con offset
 * explícito (`+00:00`) — los dos strings no ordenan igual como texto.
 */
export function isFirstContact(
  conversation: BoardConversation,
  dayStart?: string | null
): boolean {
  if (!conversation.lastCustomerMessageAt) return false;
  if (dayStart == null) return false;
  return Date.parse(conversation.createdAt) >= Date.parse(dayStart);
}

/**
 * La ventana de texto libre de WhatsApp.
 *
 * Meta solo acepta un mensaje escrito por nosotros dentro de las 24 h
 * siguientes al último mensaje del cliente. Pasado ese punto lo único que
 * entra es una plantilla aprobada, y hoy no hay ninguna configurada
 * (WHATSAPP_WELCOME_TEMPLATE está vacía). O sea que fuera de la ventana no
 * hay nada que enviar: el intento se rechaza y el cliente no recibe nada.
 */
export const FREEFORM_WINDOW_HOURS = 24;

/** El instante a partir del cual un mensaje del cliente todavía habilita texto libre. */
export function freeformWindowCutoff(now: number = Date.now()): string {
  return new Date(now - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
}

/**
 * ¿Se le puede escribir texto libre a esta conversación ahora mismo?
 *
 * Sin mensaje del cliente devuelve false. Falla cerrado a propósito: el costo
 * de equivocarse hacia el "sí" es un mensaje rechazado por Meta que el
 * cliente nunca ve, y del que solo queda una fila en `messages` diciendo que
 * salió.
 */
export function withinFreeformWindow(lastCustomerMessageAt: string | null, now: number = Date.now()): boolean {
  if (!lastCustomerMessageAt) return false;
  return new Date(lastCustomerMessageAt).getTime() > now - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000;
}

/**
 * Nadie dio una respuesta real desde el último mensaje del cliente.
 *
 * Compara `lastReplyAt` contra `lastCustomerMessageAt`, no `lastMessageAt`:
 * hasta el 4/9/2026 comparaba contra `lastMessageAt`, que avanzaba con
 * CUALQUIER mensaje visible —una nota interna, un evento de sistema, la
 * bienvenida automática o un envío que Meta rechazó también lo movían— y
 * apagaba "esperando respuesta" sin que el cliente hubiera recibido nada de
 * nadie. Desde la migración 20260905010000 (T0.1, "La bandeja que no
 * pierde") solo lo apaga una respuesta real de un asesor o la IA. Mismo
 * operador `<=` que usa la columna generada `awaiting_reply` en la base
 * (ver esa migración): `lastReplyAt` null cuenta como "todavía esperando",
 * igual que un `lastReplyAt` que quedó antes del último mensaje del cliente.
 */
export function awaitingReply(conversation: BoardConversation): boolean {
  if (!conversation.lastCustomerMessageAt) return false;
  if (!conversation.lastReplyAt) return true;
  return new Date(conversation.lastReplyAt) <= new Date(conversation.lastCustomerMessageAt);
}

/**
 * ¿Esta conversación es un "pendiente atascado" — nadie contestó y ya pasó
 * la ventana de 24 h?
 *
 * Antes de esto el Dashboard usaba su propio reloj (`minutesInStage`, que
 * mira `lastMessageAt ?? createdAt`): dos fórmulas para la misma frase, dos
 * números que podían contradecirse en pantalla. `isStalePending` unificó el
 * criterio con `withinFreeformWindow(lastCustomerMessageAt)`.
 *
 * Llegó a tener una tercera pata: hasta el 28/8/2026 (tarde) la sección
 * "Esperando +24 h" de `buildInboxSections` (inbox-sections.ts) medía la
 * misma vara, y un test de contrato las mantenía de acuerdo. Esa tarde la
 * reforma le quitó a la bandeja la píldora "Pendientes" entera —con ella se
 * fue esa sección y el test— y el criterio quedó vivo solo acá y en el
 * panel de inicio. La píldora "Pendientes" volvió a la bandeja el
 * 30/8/2026, pero partida por LECTURA (`buildInboxSections`, case
 * "pending"), no por esta ventana: `inbox-sections.ts` ya no es una pata de
 * este contrato. Las patas de hoy —`isStalePending` en memoria,
 * `fetchInboxCounts.pendingStale` y `fetchConversations({pendingWindow})`,
 * ambas en `data.ts`— las amarra `src/lib/ventana-24h-contrato.test.ts`,
 * repuesto ese mismo 30/8/2026.
 */
export function isStalePending(conversation: BoardConversation, now: number = Date.now()): boolean {
  return awaitingReply(conversation) && !withinFreeformWindow(conversation.lastCustomerMessageAt, now);
}

/**
 * Reloj de la cola de reclamos (`ticketQueue`/`buildTicketStats.unanswered`
 * ya no lo usa, ese va por `isStalePending`; queda para ordenar la cola por
 * "quién lleva más tiempo callado" usando el último mensaje visible).
 *
 * YA NO es el reloj del tablero de "Atascados": medía desde `lastMessageAt`,
 * que una nota interna, un evento de sistema o una respuesta de la IA
 * reinician sin que el cliente haya hecho nada (punto 1 del diagnóstico del
 * Frente A, "El reloj dice la verdad", 5/9/2026). El tablero usa
 * `waitingMinutes`, que mide desde `lastCustomerMessageAt` y solo cuenta si
 * de verdad se espera respuesta.
 */
export function minutesInStage(conversation: BoardConversation, now: number): number {
  const since = conversation.lastMessageAt ?? conversation.createdAt;
  return (now - new Date(since).getTime()) / 60000;
}

/**
 * Minutos que el cliente lleva esperando, o `null` si no aplica: la
 * conversación está cerrada (Roberto, tabla de casos del artefacto — lo
 * cerrado ya no está "en camino", igual que `isActive`), no espera respuesta
 * (`!awaitingReply`), o directamente no hay `lastCustomerMessageAt`. El
 * reloj es UNO —`lastCustomerMessageAt`— para las cuatro etapas de la IA, de
 * pared: la IA trabaja las 24 h. Solo en "Con asesor" el tiempo se mide en
 * minutos de horario LABORAL (`businessMinutesBetween`): de noche o domingo
 * un asesor no está atascado, aunque el reloj de pared ya lleve horas
 * corriendo (Ana, misma tabla: horas de pared de sobra pero menos de 60 min
 * laborales).
 *
 * Tenía un parámetro `dayStart` (10/9/2026, "Los números del día") que solo
 * existía para enhebrarlo hasta `stageOf` y decidir si la conversación era
 * `first_contact`. Se fue el mismo día, en la corrida siguiente ("El
 * Recorrido cuenta los números nuevos del día"): `stageOf` ya no toma
 * `dayStart` porque ya nunca devuelve `"first_contact"` (ver su docblock).
 */
export function waitingMinutes(
  conversation: BoardConversation,
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): number | null {
  if (!isActive(conversation)) return null;
  if (!awaitingReply(conversation)) return null;
  if (!conversation.lastCustomerMessageAt) return null;

  const from = new Date(conversation.lastCustomerMessageAt);
  const to = new Date(now);

  if (stageOf(conversation) === "assigned") {
    return businessMinutesBetween(from, to, hours);
  }

  return (now - from.getTime()) / 60000;
}

/**
 * ¿Esta conversación está atascada? Única fórmula (Frente A, definición
 * nueva): tiene que estar esperando respuesta Y su etapa tiene un umbral Y
 * la espera ya lo superó. Si la pelota está del lado del cliente
 * (`waitingMinutes` null) o la etapa nunca se atasca (`stallMinutes` null)
 * no hay atasco posible, esté donde esté. Exportada aparte para que la UI
 * (A4) no reimplemente esta cuenta.
 *
 * Tenía un parámetro `dayStart` (10/9/2026, "Los números del día") para
 * enhebrarlo a `stageOf`; se fue con él en la corrida siguiente ("El
 * Recorrido cuenta los números nuevos del día") — `stageOf` nunca devuelve
 * `"first_contact"`, así que esta función jamás llega a mirar su
 * `stallMinutes: null` a través de acá (`buildJourney` sí lo hace, pero por
 * la vía de `isFirstContact`, no de esta función).
 */
export function isStalled(
  conversation: BoardConversation,
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): boolean {
  const stage = STAGE_DEFINITIONS.find(
    (definition) => definition.id === stageOf(conversation)
  );
  const stallMinutes = stage?.stallMinutes ?? null;
  if (stallMinutes === null) return false;

  const waiting = waitingMinutes(conversation, now, hours);
  return waiting !== null && waiting >= stallMinutes;
}

/**
 * Gemela de `matchesDay` (`inbox-filters.ts`): mismo corte "habló hoy" que
 * ya usa la bandeja (`lastMessageAt >= dayStart`, o sin `lastMessageAt`
 * —conversación recién creada— `createdAt >= dayStart`; `dayStart` nulo deja
 * pasar cualquier fecha). NO se importa de allá: `inbox-filters.ts` ya
 * importa `awaitingReply`/`contactName` de este archivo, así que la vía
 * contraria cerraría un ciclo de imports. Privada a propósito — solo
 * `buildJourney` la necesita; si algún día hace falta en otro lado de este
 * archivo, exportarla ahí es la señal de que el ciclo hay que resolverlo de
 * verdad, moviendo una de las dos funciones.
 */
function matchesDay(
  conversation: { lastMessageAt: string | null; createdAt: string },
  dayStart: string | null
): boolean {
  if (!dayStart) return true;
  const cutoff = Date.parse(dayStart);
  const reference = conversation.lastMessageAt ?? conversation.createdAt;
  const value = Date.parse(reference);
  return !Number.isNaN(value) && value >= cutoff;
}

/** Reloj de orden del Recorrido (10/9/2026): el mismo que ya usa `waitingMinutes`, con los mismos dos respaldos que `matchesDay`. */
function journeyOrderKey(conversation: BoardConversation): number {
  const reference =
    conversation.lastCustomerMessageAt ?? conversation.lastMessageAt ?? conversation.createdAt;
  return new Date(reference).getTime();
}

/**
 * `dayStart` (10/9/2026, opcional, al final para no romper a
 * `dashboard-view.tsx`, que sigue llamando sin él): el corte "habló hoy" que
 * ya usa la bandeja, mismo string que sale de `useInboxDay` — filtra ADEMÁS
 * de `isActive`, en memoria y no en la consulta, porque `ticketQueue` (más
 * abajo, misma página) necesita reclamos de cualquier fecha. Sin `dayStart`
 * (llamador viejo) `matchesDay` deja pasar todo: nada cambia.
 *
 * La columna `first_contact` (corrida "El Recorrido cuenta los números
 * nuevos del día", 10/9/2026) ya no se arma con `stageOf` — se arma con
 * `isFirstContact`, la única de las cinco que puede coincidir con otra: una
 * conversación creada hoy y asignada a un asesor sale en `first_contact` Y
 * en `assigned` a la vez, a propósito. Las otras cuatro columnas siguen
 * siendo mutuamente excluyentes vía `stageOf`.
 */
export function buildJourney(
  conversations: BoardConversation[],
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
  dayStart?: string | null
): JourneyStage[] {
  const active = conversations.filter(isActive).filter((c) => matchesDay(c, dayStart ?? null));

  return STAGE_DEFINITIONS.map((definition) => {
    const inStage =
      definition.id === "first_contact"
        ? active.filter((c) => isFirstContact(c, dayStart))
        : active.filter((c) => stageOf(c) === definition.id);

    // Más nuevo arriba (decisión del operador, 10/9/2026, "Los números del
    // día" — reemplaza el "mayor espera arriba" del 5/9/2026): el punto rojo
    // de atasco y el contador "N atascados" (`stalled`, abajo) siguen
    // marcando la urgencia, así que el orden ya no tenía que hacerlo
    // también. Desempate por `id` para que el orden sea determinista cuando
    // dos conversaciones comparten el mismo instante exacto.
    const sorted = [...inStage].sort((a, b) => {
      const diff = journeyOrderKey(b) - journeyOrderKey(a);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });

    return {
      ...definition,
      conversations: sorted,
      stalled: inStage.filter((c) => isStalled(c, now, hours)).length,
    };
  });
}

/**
 * Cuántas conversaciones ÚNICAS del tablero están atascadas — no cuántas
 * marcas de atasco hay repartidas entre columnas. Nace con la misma corrida
 * que hizo posible que una tarjeta salga en DOS columnas a la vez
 * (`first_contact` + su etapa real, 10/9/2026): sumar `stage.stalled` de las
 * cinco columnas (como hacía `dashboard-view.tsx`) cuenta esa tarjeta dos
 * veces si está atascada. Cuenta sobre el mismo conjunto que arma
 * `buildJourney` (`isActive` + `matchesDay`), no sobre las etapas — así una
 * conversación duplicada en el tablero se cuenta una sola vez acá, sin
 * importar en cuántas columnas aparezca.
 */
export function countStalled(
  conversations: BoardConversation[],
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
  dayStart?: string | null
): number {
  const active = conversations.filter(isActive).filter((c) => matchesDay(c, dayStart ?? null));
  return active.filter((c) => isStalled(c, now, hours)).length;
}

/**
 * Qué se muestra bajo el nombre en la tarjeta: lo más útil de esa etapa.
 * En "clasificando" interesa la intención; en "herramienta", cuál corre. En
 * "Consulta" sin `awaitingReply` la pelota está del lado del cliente —lo que
 * ya respondió la IA no interesa, interesa que sigue en silencio— así que
 * ahí se pinta "sin respuesta del cliente" en vez del `intent`.
 *
 * 10/9/2026, corrida "El Recorrido cuenta los números nuevos del día":
 * `first_contact` deja de tener texto propio — ya no describe un momento
 * del recorrido, describe una cohorte (ver `isFirstContact`), así que la
 * tarjeta de esa columna delega en el detalle de la etapa REAL de la
 * conversación (`stageOf`), la misma que decide en qué otra columna aparece
 * además. No hay recursión infinita: `stageOf` nunca devuelve
 * `"first_contact"`, así que esta rama nunca vuelve a caer en sí misma.
 */
export function stageDetail(conversation: BoardConversation, stage: JourneyStageId): string | null {
  if (stage === "tool_running") return conversation.activeTool;
  if (stage === "classifying") return conversation.intent;
  if (stage === "assigned") return conversation.assignedAgent?.displayName ?? null;
  if (stage === "first_contact") {
    return stageDetail(conversation, stageOf(conversation));
  }
  if (stage === "inquiry" && !awaitingReply(conversation)) return "sin respuesta del cliente";
  return conversation.intent;
}

// ---------------------------------------------------------------------------
// Estadística de reclamos
// ---------------------------------------------------------------------------

export interface TicketCategoryStat {
  label: string;
  total: number;
  open: number;
  resolved: number;
}

export interface TicketAgentStat {
  agent: AgentRef;
  open: number;
}

export interface TicketStats {
  total: number;
  open: number;
  resolved: number;
  /**
   * Reclamos abiertos que además son un "pendiente atascado" —
   * `isStalePending` — bajo el mismo criterio que usa la bandeja para
   * "Esperando +24 h". Ojo: esto solo cuenta RECLAMOS (contactos
   * etiquetados "Reclamo*"), no todos los pendientes atascados del CRM.
   */
  unanswered: number;
  /** Antigüedad media, en horas, de los reclamos abiertos. */
  averageOpenHours: number;
  categories: TicketCategoryStat[];
  byAgent: TicketAgentStat[];
}

function isResolved(conversation: BoardConversation): boolean {
  return conversation.status === "closed";
}

export function buildTicketStats(
  conversations: BoardConversation[],
  now: number,
  ticketTags: TicketTagsByContact
): TicketStats {
  const tickets = conversations.filter((c) => isTicket(c, ticketTags));
  const open = tickets.filter((c) => !isResolved(c));
  const resolved = tickets.filter(isResolved);

  const categories = new Map<string, TicketCategoryStat>();
  for (const ticket of tickets) {
    for (const tag of ticketTagsOf(ticket, ticketTags)) {
      const label = ticketCategory(tag);
      const stat = categories.get(label) ?? { label, total: 0, open: 0, resolved: 0 };
      stat.total += 1;
      if (isResolved(ticket)) stat.resolved += 1;
      else stat.open += 1;
      categories.set(label, stat);
    }
  }

  const agents = new Map<string, TicketAgentStat>();
  for (const ticket of open) {
    const agent = ticket.assignedAgent;
    if (!agent) continue;
    const stat = agents.get(agent.id) ?? { agent, open: 0 };
    stat.open += 1;
    agents.set(agent.id, stat);
  }

  const totalOpenHours = open.reduce(
    (sum, c) => sum + (now - new Date(c.createdAt).getTime()) / 3600000,
    0
  );

  return {
    total: tickets.length,
    open: open.length,
    resolved: resolved.length,
    unanswered: open.filter((c) => isStalePending(c, now)).length,
    averageOpenHours: open.length > 0 ? totalOpenHours / open.length : 0,
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    byAgent: [...agents.values()].sort((a, b) => b.open - a.open),
  };
}

/** Reclamos abiertos ordenados por urgencia: primero los que llevan más tiempo callados. */
export function ticketQueue(
  conversations: BoardConversation[],
  now: number,
  ticketTags: TicketTagsByContact
): BoardConversation[] {
  return conversations
    .filter((c) => isTicket(c, ticketTags) && !isResolved(c))
    .sort((a, b) => minutesInStage(b, now) - minutesInStage(a, now));
}

// ---------------------------------------------------------------------------
// Utilidades de presentación
// ---------------------------------------------------------------------------

/** Estructural a propósito: sirve igual para la fila de bandeja, la venta o la conversación completa. */
export function contactName(conversation: {
  contact: { displayName: string | null; profileName: string | null; phoneNumber: string };
}): string {
  return (
    conversation.contact.displayName ??
    conversation.contact.profileName ??
    conversation.contact.phoneNumber
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Duración compacta pensada para tarjetas estrechas: 8 m, 3 h, 2 d. */
export function compactDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "ahora";
  if (minutes < 60) return `${Math.round(minutes)} m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}
