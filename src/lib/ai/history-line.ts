// ---------------------------------------------------------------------------
// Qué línea de historial arma el CRM para el modelo a partir de una fila de
// `messages` (7/9/2026, medido en producción): `loadHistory` (agent.ts)
// descartaba toda fila con `content` vacío, y el webhook guarda imagen,
// audio, video, documento y sticker con `content = caption ?? null`. Sin pie,
// esas filas eran invisibles para el modelo. Dos casos reales:
//
//   - `cea69118-5d17-4f08-84c6-925755672b87`: un cliente arrancó el chat con
//     un audio y nada más. Sin texto que leer, `loadHistory` devolvía un
//     historial vacío y el turno salía sin rastro (T4 cierra ese hueco por
//     separado).
//   - `7631718e-52bc-4448-99f2-586789c073ff`: el cliente mandó dos fotos y
//     después "Cualquiera de estos en talla L". El "estos" señalaba las
//     fotos, que el modelo nunca vio: las dos filas de foto se descartaban
//     antes de llegar al contexto.
//
// Restricción de diseño (declarada en el brief): `messages.content` NO se
// toca. Es la burbuja del chat (`media-group.tsx`, `quoted-content.tsx`,
// `close-sale-modal.tsx` dependen de que sea SOLO lo que el cliente escribió
// o el pie que mandó). El texto que necesita el modelo para "ver" que algo
// llegó se arma acá, en memoria, como una línea entre corchetes que el
// prompt (sección 7, `MEDIA_RULES` en prompt.ts) le explica al modelo cómo
// leer: nunca la cite, nunca la trate como algo que el cliente escribió. Los
// textos de este archivo tienen que coincidir EXACTAMENTE con lo que
// `MEDIA_RULES` describe.
//
// Módulo PURO a propósito, igual que identity-guard.ts: sin `server-only` y
// sin más import que tipos, para que lo puedan usar tanto agent.ts (servidor)
// como cualquier test sin arrastrar el mundo del SDK de IA.
// ---------------------------------------------------------------------------

/** Las columnas de `messages` que hacen falta para decidir la línea de historial. */
export interface HistoryRow {
  sender_type: string;
  content: string | null;
  is_internal_note: boolean | null;
  message_type: string | null;
}

export interface HistoryLine {
  role: "user" | "assistant";
  content: string;
  /** true solo en las líneas entre corchetes que arma este archivo. */
  marcador: boolean;
}

/** Tipos de multimedia que hoy llegan sin `content` cuando no traen pie. */
type MediaType = "image" | "video" | "audio" | "document" | "sticker";

const MEDIA_TYPES = new Set<string>(["image", "video", "audio", "document", "sticker"]);

/** `content` recortado, o null si queda vacío tras el recorte (equivale a "sin pie"). */
function pie(content: string | null): string | null {
  const recortado = content?.trim();
  return recortado ? recortado : null;
}

function clienteMarker(messageType: MediaType, caption: string | null): string {
  switch (messageType) {
    case "image":
      return caption ? `[El cliente envió una foto. Pie: ${caption}]` : "[El cliente envió una foto sin texto; no puedes verla]";
    case "video":
      return caption ? `[El cliente envió un video. Pie: ${caption}]` : "[El cliente envió un video sin texto; no puedes verlo]";
    case "audio":
      return caption ? `[El cliente envió una nota de voz. Pie: ${caption}]` : "[El cliente envió una nota de voz; no puedes escucharla]";
    case "document":
      // El webhook NO guarda el nombre del archivo (`payload` llega vacío
      // para 'document' en producción, medido 7/9/2026) — el marcador sale
      // sin nombre. Guardar `filename` en `payload` queda fuera de alcance.
      return caption ? `[El cliente envió un documento. Pie: ${caption}]` : "[El cliente envió un documento; no puedes abrirlo]";
    case "sticker":
      return "[El cliente envió un sticker]";
  }
}

const ASESOR_LABEL: Record<MediaType, string> = {
  image: "una foto",
  video: "un video",
  audio: "una nota de voz",
  document: "un documento",
  sticker: "un sticker",
};

function asesorMarker(messageType: MediaType, caption: string | null): string {
  const base = `[El asesor envió ${ASESOR_LABEL[messageType]}`;
  return caption ? `${base}. Pie: ${caption}]` : `${base}]`;
}

/**
 * Convierte una fila de `messages` en la línea que ve el modelo, o `null` si
 * la fila se salta (comportamiento igual al `loadHistory` de antes para las
 * filas que ya se saltaban).
 */
export function historyLine(row: HistoryRow): HistoryLine | null {
  // Reglas ya vigentes antes de este archivo (ver el comentario de
  // loadHistory en agent.ts): notas internas, eventos de sistema y
  // 'unsupported' nunca entran al contexto del modelo.
  if (row.is_internal_note || row.sender_type === "system" || row.message_type === "unsupported") return null;

  const role: HistoryLine["role"] = row.sender_type === "customer" ? "user" : "assistant";
  const messageType = row.message_type;

  if (messageType && MEDIA_TYPES.has(messageType)) {
    const caption = pie(row.content);
    const content = role === "user" ? clienteMarker(messageType as MediaType, caption) : asesorMarker(messageType as MediaType, caption);
    return { role, content, marcador: true };
  }

  // text, location, contacts, interactive, order, template, system_event,
  // null o cualquier tipo desconocido: `content` tal cual, como siempre.
  return row.content && row.content.trim() ? { role, content: row.content, marcador: false } : null;
}

/** true si `text` es uno de los marcadores que arma `historyLine`, no algo que el cliente o el asesor escribieron. */
export function isHistoryMarker(text: string): boolean {
  return /^\[(El cliente|El asesor) envió /.test(text);
}

// ---------------------------------------------------------------------------
// Racha de adjuntos sin texto (Tarea 6, "La voz cercana y la espera visible",
// 14/9/2026, decisión 5): 494 fotos y 117 audios en 72 h, y la IA repitiendo
// "¿qué repuesto buscas?" hasta 10 veces sin que nadie contara cuántas veces
// ya lo había preguntado. `history-line.ts` ya marcaba cada adjunto; lo que
// faltaba era contar la racha para que `agent.ts` supiera cuándo dejar de
// insistir y pasar el caso.
//
// Los cuatro literales de abajo tienen que coincidir EXACTAMENTE con los que
// arma `clienteMarker` más arriba en este archivo (mismo acoplamiento que ya
// advierte el comentario de cabecera del módulo) — son constantes, nunca
// llevan pie, así que compararlas por igualdad es más simple y más seguro que
// otro regex. El sticker se deja fuera a propósito: un sticker no es un
// pedido (decisión 5 del plan), así que ni cuenta como adjunto ni corta la
// racha por sí solo — mismo trato que el resto del código le da a los
// marcadores del asesor (no son "una pregunta").
// ---------------------------------------------------------------------------

/** Tipo (en español, para el resumen que lee un asesor) de cada marcador "sin pie" que SÍ cuenta como adjunto pendiente. */
const SIN_PIE_MARKERS: Record<string, string> = {
  "[El cliente envió una foto sin texto; no puedes verla]": "una foto",
  "[El cliente envió un video sin texto; no puedes verlo]": "un video",
  "[El cliente envió una nota de voz; no puedes escucharla]": "una nota de voz",
  "[El cliente envió un documento; no puedes abrirlo]": "un documento",
};

/**
 * El literal exacto que arma `clienteMarker` para "sticker" (sin variante con
 * pie). `mediaStreakWithoutText` ya lo trata aparte —no está en
 * `SIN_PIE_MARKERS`, así que un sticker corta la racha sin contar como
 * adjunto pendiente— y `customerBurst` (T3, corrección del 19/9/2026,
 * hallazgo 8) lo usa para lo mismo con el mismo criterio: un sticker no es un
 * pedido, y tampoco es una respuesta a nada.
 */
const CUSTOMER_STICKER_MARKER = "[El cliente envió un sticker]";

/**
 * Forma mínima que necesita `mediaStreakWithoutText`/`customerBurst`: tanto
 * `HistoryLine` (este archivo) como el `ModelMessage` que arma `loadHistory`
 * en agent.ts calzan sin adaptar nada — los dos tienen `role`/`content` de
 * sobra.
 *
 * `createdAt` (T3, corrección del 19/9/2026, `code-review high` sobre el
 * plan "Seba sale sin pisar a nadie", hallazgo 4): opcional a propósito.
 * `ModelMessage` (el tipo del SDK de IA) no trae fecha — es el tipo que viaja
 * hasta `agent.generate`, y ningún consumidor de esa forma tiene por qué
 * cargar con un campo que no le sirve —, así que `agent.ts` arma, SOLO para
 * `customerBurst`, un arreglo paralelo que junta cada mensaje con su
 * `created_at` de la fila real. Una entrada sin `createdAt` (undefined, o un
 * string que no parsea) se trata de forma conservadora: ver el docblock de
 * `customerBurst`.
 */
interface StreakEntry {
  role: string;
  content: unknown;
  createdAt?: string | null;
}

export interface MediaStreak {
  /** Cuántos marcadores "sin pie" seguidos, contando desde el final, sin ningún texto de cliente en el medio. */
  adjuntos: number;
  /** true si entre esos adjuntos la IA (o un asesor) ya escribió algo que no es, a su vez, un marcador de media saliente. */
  yaPreguntamos: boolean;
  /** El tipo (en español) de cada adjunto contado, del más viejo al más nuevo — para el resumen que lee el asesor al escalar. */
  tipos: string[];
}

/**
 * Cuenta, desde el mensaje más reciente hacia atrás, cuántos adjuntos del
 * cliente llegaron seguidos sin ningún texto — ni un pie en el propio
 * adjunto, ni un mensaje de texto posterior. Se detiene en la primera línea
 * de cliente que SÍ trae texto (un mensaje normal, o un marcador con pie: si
 * puso un pie, ya escribió lo que hacía falta) o en un sticker (no es un
 * pedido, decisión 5 del plan: ni cuenta ni corta la racha por las buenas,
 * simplemente no es del tipo que este conteo busca).
 *
 * `agent.ts` usa el resultado para decidir si vale la pena volver a
 * preguntar "¿qué es esto?" una vez más, o si ya toca pasarle el caso a un
 * asesor (ver `runTurnPhases`).
 */
export function mediaStreakWithoutText(history: StreakEntry[]): MediaStreak {
  let adjuntos = 0;
  let yaPreguntamos = false;
  const tipos: string[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const content = typeof message.content === "string" ? message.content : null;

    if (message.role === "user") {
      const tipo = content !== null ? SIN_PIE_MARKERS[content] : undefined;
      if (tipo) {
        adjuntos++;
        tipos.unshift(tipo);
        continue;
      }
      // Cualquier otra línea de cliente —texto real, un marcador CON pie, o
      // un sticker— cierra la racha acá: ya hay algo que leer, o (sticker) no
      // hay un pedido que perseguir.
      break;
    }

    // Línea del asesor/IA: un marcador de media saliente ("[El asesor envió
    // una foto]") no es una pregunta —mismo criterio que `alreadyRedirected`/
    // `alreadySentPlaybook` en agent.ts—; cualquier otro texto sí lo es.
    if (content !== null && isHistoryMarker(content)) continue;
    yaPreguntamos = true;
  }

  return { adjuntos, yaPreguntamos, tipos };
}

// ---------------------------------------------------------------------------
// T3, plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo nuevo de la
// inspección pre-despliegue, fila A3 de la tabla del plan): la cola agrupa
// ráfagas de mensajes seguidos antes de correr un turno (CLAUDE.md, "La
// respuesta llega en siete segundos") — un cliente que escribe "Precio del
// casco LS2" y, dos segundos después, "Buenas tardes" le llega al turno como
// DOS líneas de cliente sin nada del CRM entre medio. `lastCustomerMessage`
// (agent.ts) solo mira la ÚLTIMA de esas líneas: leía nomás "Buenas tardes"
// y dos guardas del turno lo trataban como si el cliente solo hubiera
// saludado —
//
//   - `soloSaludo` (agent.ts): mandaba el saludo de Seba y daba el turno por
//     terminado, sin fase 0/1 ni tool loop, dejando la pregunta sin contestar.
//   - la guarda de cortesía tras escalada abierta (agent.ts): "¿tienen la
//     bomba de aceite?" + "gracias" con una escalada abierta callaba el
//     turno ENTERO, no solo la cortesía.
//
// `customerBurst` es el arreglo: junta TODA la ráfaga final del cliente, no
// solo la última línea, para que las dos guardas puedan exigir que CADA
// línea de la ráfaga —no solo la de más atrás— sea saludo o cortesía.
//
// Corrección del 19/9/2026 (`code-review high` sobre el plan, hallazgos 4 y
// 8 — la primera versión de esta función, arriba en el historial de este
// archivo, no tenía ninguna de las dos):
//
//   - Hallazgo 4: la primera versión no acotaba la ráfaga por tiempo —
//     retrocedía hasta la última línea del ASISTENTE, sin mirar el reloj.
//     Caso real: un cliente escribe "¿ya me atienden?", nadie contesta
//     (`pausada`), el chat se cierra; DÍAS después el cliente reabre con
//     "hola". Como no hubo ninguna línea del asistente en el medio (el chat
//     estaba cerrado, no silenciado por una respuesta), la ráfaga vieja
//     seguía "pegada" a la nueva: ["¿ya me atienden?", "hola"] no es solo
//     saludo, y Seba habría redactado sobre un mensaje de hace días que
//     quedó sin respuesta A PROPÓSITO. `CUSTOMER_BURST_GAP_MINUTES` corta la
//     ráfaga por un hueco de tiempo entre líneas consecutivas, no solo por
//     una respuesta del CRM en el medio.
//   - Hallazgo 8: un sticker del cliente ("[El cliente envió un sticker]")
//     hacía fallar el `every(isCourtesyOnly)` de la guarda de cortesía —
//     "gracias" + sticker de pulgar con una escalada abierta ya no la
//     callaba, y la IA mandaba una segunda despedida encima de la primera.
//     Un sticker no es ni saludo ni cortesía ni una pregunta (decisión 5 del
//     plan "La voz cercana y la espera visible", 14/9/2026, la misma que ya
//     sigue `mediaStreakWithoutText`): se salta, sin contar como línea de la
//     ráfaga ni cortarla — ver `CUSTOMER_STICKER_MARKER`.
// ---------------------------------------------------------------------------

/**
 * Hueco máximo, en minutos, entre dos líneas consecutivas del cliente para
 * que sigan siendo la MISMA ráfaga. La cola agrupa ráfagas de mensajes
 * seguidos en cuestión de SEGUNDOS (CLAUDE.md, "La respuesta llega en siete
 * segundos": 2-6 s de silencio antes de correr el turno), así que 10 minutos
 * es una holgura generosa — cualquier hueco mayor es, de verdad, una
 * conversación distinta en el tiempo, no la misma ráfaga.
 */
export const CUSTOMER_BURST_GAP_MINUTES = 10;

/** `value` como epoch-ms, o `null` si no es un string parseable — nunca `NaN`. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Las líneas del CLIENTE consecutivas desde el final del historial, en orden
 * CRONOLÓGICO (la más vieja primero), hasta la primera línea —yendo hacia
 * atrás— que no sea del cliente: una respuesta de la IA o de un asesor corta
 * la ráfaga, porque ya hay algo dicho después de ese silencio y lo que venga
 * después es, de verdad, una ráfaga nueva. Además (hallazgo 4, 19/9/2026) se
 * corta por TIEMPO: dos líneas de cliente seguidas —sin nada del CRM entre
 * medio, pero separadas por más de `CUSTOMER_BURST_GAP_MINUTES`— tampoco son
 * la misma ráfaga.
 *
 * La línea más NUEVA (la última del historial, si es del cliente) siempre
 * entra, tenga o no `createdAt` — no hay contra qué medir un hueco todavía.
 * A partir de ahí, cada línea más vieja se compara contra la marca de tiempo
 * de la última línea YA aceptada: si a cualquiera de las dos —la nueva ya
 * aceptada, o la que se está evaluando— le falta una fecha parseable, la
 * decisión es conservadora y la ráfaga se corta ahí mismo (mejor perder una
 * línea legítima sin fecha que arrastrar un mensaje de hace días que quedó
 * sin responder a propósito: `pausada`, `mensaje_previo_a_devolucion`,
 * `cortesia_tras_escalada`, un chat cerrado).
 *
 * Un marcador de media ("[El cliente envió una foto sin texto; no puedes
 * verla]") entra a la ráfaga como una línea más, sin tratamiento especial:
 * no hace falta descartarlo acá porque no es ni saludo ni cortesía, así que
 * cualquier guarda que exija que TODA la ráfaga lo sea ya lo descarta sola
 * (y el turno sigue de largo, dejando que `MEDIA_RULES`/la racha de adjuntos
 * de más arriba hagan su trabajo). Un STICKER es la única excepción
 * (hallazgo 8, 19/9/2026): se salta sin contar como línea ni cortar la
 * ráfaga — ni siquiera actualiza la marca de tiempo de referencia, como si
 * nunca hubiera estado ahí. Una ráfaga que queda vacía porque lo único que
 * había era un sticker se comporta igual que antes de esta función existir
 * (cuando `lastCustomerMessage` daba `null` para un marcador): ninguna de
 * las dos guardas de `agent.ts` dispara con la ráfaga vacía, así que un
 * sticker solo NO se trata como "el cliente solo saludó" ni como cortesía.
 *
 * Historial vacío, o el historial termina en una línea que no es del
 * cliente, da `[]`. Comparte forma con `mediaStreakWithoutText`: acepta
 * tanto `HistoryLine` (este archivo) como el `ModelMessage` de `loadHistory`
 * (agent.ts) sin adaptar nada — `createdAt` es opcional, ver `StreakEntry`.
 */
export function customerBurst(history: StreakEntry[]): string[] {
  const rafaga: string[] = [];
  let referencia: number | null = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "user") break;
    if (typeof message.content !== "string") break;

    // Hallazgo 8: un sticker no cuenta ni corta — se lo salta tal cual,
    // sin tocar `referencia` (la línea de atrás se sigue midiendo contra la
    // última línea REAL ya aceptada, no contra el sticker que no lo es).
    if (message.content === CUSTOMER_STICKER_MARKER) continue;

    const actual = parseTimestamp(message.createdAt);
    if (rafaga.length > 0) {
      // No es la línea más nueva: hace falta poder medir el hueco. Sin
      // fecha en cualquiera de las dos puntas, la decisión es conservadora
      // (hallazgo 4): cortar acá.
      if (actual === null || referencia === null) break;
      if ((referencia - actual) / 60000 > CUSTOMER_BURST_GAP_MINUTES) break;
    }

    rafaga.unshift(message.content);
    referencia = actual;
  }

  return rafaga;
}

// ---------------------------------------------------------------------------
// T1, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026, "lo ya respondido no se vuelve a responder"): `customerBurst`
// solo mira las líneas de cliente CONSECUTIVAS desde el final del historial —
// si el turno anterior alcanzó a contestar algo, la ráfaga queda vacía y dos
// guardas de agent.ts (la de cortesía tras escalada, que exige
// `rafagaCliente.length > 0`, y `soloSaludo`) dejan de disparar aunque el
// cliente haya preguntado algo real antes de esa respuesta.
//
// Caso real medido en producción el 22/9/2026 (hora VET): 15:24:14 cliente
// "Buenas tardes"; 15:24:24 "Llegaron las tapas de la Rk 200"; 15:24:26 "?";
// 15:24:28 "Coño negro"; 15:24:33 escalada; 15:24:38 y 15:24:43 Seba
// responde; 15:24:44 cliente "Color *"; 15:24:53 "Vale"; 15:24:54 "Gracias";
// 15:24:59 Seba responde. El turno de las 15:25:06 carga el historial YA
// TERMINADO en la respuesta de las 15:24:59: `customerBurst` da `[]` (no
// termina en el cliente) y fase 0 compara contra el ÚLTIMO mensaje del
// cliente ("Gracias") sin ver que "Color *"/"Vale" quedaron sin atender —
// manda el escenario "Gracias" encima de una escalada abierta.
//
// La marca "visto hasta" (`turn-seen.ts`, Redis) recuerda, por conversación,
// cuál fue la línea de cliente más nueva que el ÚLTIMO turno que atendió de
// verdad llegó a cargar — esa línea (y cualquier otra con el mismo
// `created_at` de segundo, ver `SeenMarker`) ya fue vista y NO cuenta como
// pendiente. `pendingCustomerLines` recupera todas las líneas de cliente
// MÁS NUEVAS que la marca, sin importar cuántas respuestas del asistente
// queden en el medio. Para el caso de arriba: si un turno anterior dejó la
// marca en "Color *" (15:24:44) —la última línea que ese turno llegó a
// ver—, el turno de las 15:25:06 recupera ["Vale", "Gracias"] (las dos
// líneas MÁS NUEVAS que "Color *"), y la guarda de cortesía tras escalada
// dispara porque las dos son cortesía. Si en cambio la marca ya llegara
// hasta "Gracias" (porque un turno más reciente la contestó), no quedaría
// nada pendiente y el turno se cerraría con `turno_sin_mensaje_nuevo`.
//
// El caso inverso (dos, mismo plan): si un turno YA contestó ciertas líneas
// y otro turno para la MISMA conversación sigue en cola (una ráfaga que
// llegó mientras el primero redactaba), la marca que deja el primero hace
// que el segundo no vuelva a tratar esas líneas como pendientes.
// ---------------------------------------------------------------------------

/**
 * Lo que guarda `turn-seen.ts` en Redis: hasta qué mensaje del cliente vio
 * el último turno que atendió de verdad esta conversación.
 *
 * `hasta` es el `created_at` (ISO) — con precisión de SEGUNDO, porque es la
 * marca de tiempo de Meta — de la línea de cliente más nueva que ese turno
 * cargó. `ids` son los `id` de `messages` que comparten exactamente ese
 * `created_at`: dos fragmentos del cliente en el mismo segundo no se
 * distinguen por fecha, así que hace falta el id para no tratar como
 * "pendiente" uno que ya se vio.
 */
export interface SeenMarker {
  hasta: string;
  ids: string[];
}

/**
 * Forma que necesitan `pendingCustomerLines`/`latestCustomerMarker`: lo mismo
 * que `StreakEntry` (mismo motivo: acepta tanto `HistoryLine` como el
 * `ModelMessage` que arma `loadHistory` en agent.ts) más el `id` real de la
 * fila de `messages` — hace falta para desempatar dos fragmentos con el
 * mismo `created_at` de segundo. `agent.ts` arma este arreglo con el mismo
 * zip que ya usa para `customerBurst`, sumando un tercer arreglo paralelo
 * (`historyIds`, mismo índice) que `loadHistory` arma en el mismo bucle que
 * `createdAt`.
 */
interface PendingEntry extends StreakEntry {
  id?: string | null;
}

/**
 * Las líneas de CLIENTE más nuevas que la marca `seen`, en orden
 * CRONOLÓGICO, sin importar si hay líneas del asistente en el medio — a
 * diferencia de `customerBurst`, que corta en la primera línea (yendo desde
 * el final hacia atrás) que no sea del cliente.
 *
 * `seen === null` (sin Redis, o conversación nunca vista por un turno que
 * haya escrito la marca): el resultado es EXACTAMENTE `customerBurst(history)`
 * — sin marca no hay de dónde sacar "hasta dónde ya se contestó", así que se
 * conserva la regla de siempre.
 *
 * Con `seen` presente, una línea de cliente entra si:
 *   - su `createdAt` es POSTERIOR a `seen.hasta`, o
 *   - es el MISMO segundo (`createdAt === seen.hasta`) y su `id` NO está en
 *     `seen.ids` (el empate de segundo que describe `SeenMarker`).
 *
 * Un STICKER se salta igual que en `customerBurst`: no es un pedido, no
 * cuenta como línea pendiente ni corta nada. Y, igual que `customerBurst`,
 * el resultado se acota por `CUSTOMER_BURST_GAP_MINUTES` entre líneas
 * PENDIENTES consecutivas —yendo de la más nueva hacia atrás—: dos preguntas
 * sueltas separadas por más de diez minutos, aunque las dos sean
 * posteriores a la marca, no son la misma ráfaga.
 *
 * Una línea sin `createdAt` parseable es conservadora, mismo criterio que
 * `customerBurst` (hallazgo 4, 19/9/2026): NO cuenta como pendiente, salvo
 * que sea la última línea de TODO el historial (no solo la última de
 * cliente) — no hay nada más nuevo contra qué compararla, así que
 * descartarla dejaría un mensaje real sin contestar por un dato que falta.
 */
export function pendingCustomerLines(history: PendingEntry[], seen: SeenMarker | null): string[] {
  if (seen === null) return customerBurst(history);

  const hastaMs = parseTimestamp(seen.hasta);
  const idsVistos = new Set(seen.ids);

  const pendientes: { content: string; ms: number | null }[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role !== "user") continue;
    if (typeof message.content !== "string") continue;
    // Mismo criterio que customerBurst (hallazgo 8): un sticker no es un
    // pedido, se salta sin contar como línea.
    if (message.content === CUSTOMER_STICKER_MARKER) continue;

    const ms = parseTimestamp(message.createdAt);
    let esPendiente: boolean;
    if (ms === null) {
      // Conservador: solo cuenta si es la última línea de TODO el historial.
      esPendiente = i === history.length - 1;
    } else if (hastaMs === null) {
      // Defensivo: `turn-seen.ts` nunca escribe un `hasta` que no parsee,
      // pero si algún día lo hiciera, tratar la marca como si no existiera
      // es más seguro que descartar la ráfaga entera por un dato corrupto.
      esPendiente = true;
    } else {
      esPendiente = ms > hastaMs || (ms === hastaMs && !idsVistos.has(message.id ?? ""));
    }

    if (esPendiente) pendientes.push({ content: message.content, ms });
  }

  // Mismo corte por hueco que customerBurst, pero sobre los PENDIENTES: dos
  // preguntas sueltas separadas por más de CUSTOMER_BURST_GAP_MINUTES no son
  // la misma ráfaga aunque las dos sean posteriores a la marca.
  const resultado: string[] = [];
  let referencia: number | null = null;
  for (let i = pendientes.length - 1; i >= 0; i--) {
    const candidato = pendientes[i];
    if (resultado.length > 0) {
      if (candidato.ms === null || referencia === null) break;
      if ((referencia - candidato.ms) / 60000 > CUSTOMER_BURST_GAP_MINUTES) break;
    }
    resultado.unshift(candidato.content);
    referencia = candidato.ms;
  }

  return resultado;
}

/**
 * La marca que hay que dejar en Redis cuando un turno SÍ atendió de verdad
 * lo que vio: la línea de cliente más nueva del historial que cargó ese
 * turno (`hasta`), y los `id` de todas las líneas de cliente que comparten
 * exactamente ese `created_at` de segundo (`ids` — el empate que resuelve
 * `pendingCustomerLines`).
 *
 * `null` si el historial no trae ninguna línea de cliente con `createdAt`
 * parseable — no hay nada que marcar como visto (agent.ts simplemente no
 * escribe la marca en ese caso).
 */
export function latestCustomerMarker(history: PendingEntry[]): SeenMarker | null {
  let hastaMs: number | null = null;
  let hasta: string | null = null;

  for (const message of history) {
    if (message.role !== "user") continue;
    if (typeof message.content !== "string") continue;
    const ms = parseTimestamp(message.createdAt);
    if (ms === null) continue;
    if (hastaMs === null || ms > hastaMs) {
      hastaMs = ms;
      hasta = message.createdAt as string;
    }
  }

  if (hasta === null || hastaMs === null) return null;

  const ids = history
    .filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        parseTimestamp(message.createdAt) === hastaMs
    )
    .map((message) => message.id)
    .filter((id): id is string => typeof id === "string");

  return { hasta, ids };
}
