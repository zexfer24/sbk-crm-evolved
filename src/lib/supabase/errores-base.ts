// ---------------------------------------------------------------------------
// Clasificador PURO de fallos contra la base (T1, plan "Nada se pierde en un
// corte ni en un deploy", 21-22/9/2026).
//
// Historia: un corte de red corto (o un Postgres reiniciando) entre la app y
// PostgREST perdía mensajes del webhook de WhatsApp para siempre —
// `createAdminClient()` no reintentaba nada y el webhook respondía 200 igual
// (ver docs/planes/2026-09-21-nada-se-pierde-en-un-corte-ni-en-un-deploy.md,
// hallazgo 2). Este módulo decide QUÉ es un fallo transitorio de la base y
// CUÁNDO es seguro reintentarlo; `fetch-reintentos.ts` decide qué hacer con
// esa respuesta (esperar, reintentar, loguear).
//
// A propósito SIN imports de `lib/log.ts` ni de nada `server-only`: este
// archivo lo puede importar cualquier módulo que llegue al navegador (por
// ejemplo, uno que solo necesite clasificar un error) sin arrastrar nada del
// servidor. Ver CLAUDE.md, trampa de `human-handled.ts` sobre el mismo
// problema con los imports de servidor.
// ---------------------------------------------------------------------------

/**
 * Forma mínima de una respuesta HTTP ya leída. Nunca el `Response` crudo de
 * `fetch`: leer el cuerpo es async (`response.text()`), y un clasificador
 * puro tiene que quedar sincrónico — quien tenga un `Response` de verdad
 * (`fetch-reintentos.ts`) lo lee con `clone()` ANTES de llamar acá.
 */
export interface RespuestaDeBase {
  status: number;
  cuerpo: string;
}

/** 502/503/504: los tres códigos con los que un proxy (Envoy) o PostgREST
 * dicen "no puedo completar esto ahora", nunca un rechazo de la consulta. */
export const STATUS_HTTP_TRANSITORIOS: readonly number[] = [502, 503, 504];

/** Los tres textos con los que Envoy explica que la petición NUNCA llegó a
 * PostgREST — murió en el proxy, antes del upstream. Es la única prueba de
 * "no hubo ejecución del otro lado" que trae un código HTTP. */
const PATRONES_ENVOY_SIN_LLEGAR = [
  "upstream connect error",
  "disconnect/reset before headers",
  "connection termination",
];

/** Los dos textos con los que Kong (el proxy local, distinto de Envoy de
 * producción) explica que NUNCA llegó a intentar hablar con PostgREST: no
 * pudo resolver el nombre del contenedor, o no pudo elegir a quién mandarle
 * la petición. Misma prueba que `PATRONES_ENVOY_SIN_LLEGAR`, con las
 * palabras de otro proxy. */
const PATRONES_KONG_SIN_LLEGAR = [
  "name resolution failed",
  "failure to get a peer from the ring-balancer",
];

/** Kong respondiendo que SÍ llegó a upstream pero no entendió lo que volvió
 * — un corte real (503, hay que reintentar), pero NO prueba "nunca llegó":
 * a diferencia de los dos patrones de arriba, acá el upstream alcanzó a
 * contestar algo. Queda fuera de `PATRONES_KONG_SIN_LLEGAR` a propósito. */
const PATRONES_KONG_UPSTREAM_RESPONDIO_ALGO = [
  "invalid response was received from the upstream",
];

/** Todo lo que un proxy (Envoy o Kong) puede dejar en el `message` de un
 * fallo transitorio cuando el cuerpo de su respuesta no es el JSON de un
 * `PostgrestError` real. Ver `mensajeDeError` y la nota de cabecera sobre
 * `PostgrestBuilder.ts`. */
const PATRONES_PROXY_SIN_JSON_DE_POSTGREST = [
  ...PATRONES_ENVOY_SIN_LLEGAR,
  ...PATRONES_KONG_SIN_LLEGAR,
  ...PATRONES_KONG_UPSTREAM_RESPONDIO_ALGO,
];

/** Códigos de error de red (Node/undici) que cuentan como "la base no está
 * respondiendo ahora mismo". */
const CODIGOS_RED_TRANSITORIOS = ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"];

/** De los de arriba, los que además PRUEBAN que la conexión nunca se llegó a
 * establecer (no hubo forma de que el pedido se ejecutara del otro lado).
 * `ECONNRESET`/`ETIMEDOUT` quedan afuera a propósito: una conexión que se
 * cae o expira después de abrirse no prueba que PostgREST no haya recibido
 * (y ejecutado) la petición. */
const CODIGOS_RED_SIN_CONEXION = ["ECONNREFUSED", "EAI_AGAIN"];

/** Prefijos de código Postgres/PostgREST que son "la base no está
 * disponible ahora", no un rechazo de la consulta: `08*` (connection
 * exception), `53*` (falta de recursos), `57P*` (el servidor se está
 * apagando/reiniciando) y `PGRST00*` (PostgREST sin conexión a la base). */
const PREFIJOS_CODIGO_TRANSITORIO = ["08", "53", "57P", "PGRST00"];

const METODOS_IDEMPOTENTES = ["GET", "HEAD"];

function esRespuestaDeBase(valor: unknown): valor is RespuestaDeBase {
  return (
    typeof valor === "object" &&
    valor !== null &&
    typeof (valor as { status?: unknown }).status === "number" &&
    typeof (valor as { cuerpo?: unknown }).cuerpo === "string"
  );
}

function calzaAlguno(texto: string, patrones: readonly string[]): boolean {
  return patrones.some((patron) => texto.includes(patron));
}

function cuerpoCalzaEnvoy(cuerpo: string): boolean {
  return calzaAlguno(cuerpo, PATRONES_ENVOY_SIN_LLEGAR);
}

/**
 * El `message` de un objeto de error, cuando es un string. Existe para leer
 * la forma que arma `postgrest-js` cuando el proxy (Envoy o Kong) devuelve
 * un 502/503/504 cuyo cuerpo NO es el JSON de un `PostgrestError` real:
 * `PostgrestBuilder.processResponse` (node_modules/@supabase/postgrest-js/
 * src/PostgrestBuilder.ts:544-567) intenta `JSON.parse(body)` y, si el
 * cuerpo no es JSON, cae al `catch` y arma `error = { message: body }` — SIN
 * ninguna clave `code`; si el cuerpo SÍ es JSON pero solo trae
 * `{"message": "..."}` (el caso de Kong en local, que no imita el formato
 * de error de PostgREST), `error = JSON.parse(body)` tampoco trae `code`.
 * Historia (22/9/2026): con PostgREST parado en local, el webhook leyó
 * `{ code: "", message: "name resolution failed" }` — `code` vacío, nada
 * que clasificar por prefijo — y `esFalloTransitorioDeBase` daba `false`,
 * así que el webhook respondía 200 en vez de 503 y Meta nunca reentregaba
 * el lote perdido.
 */
function mensajeDeError(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

/**
 * El código de error de red, venga directo (`err.code`, forma clásica de
 * Node) o dentro de `err.cause` (forma con la que undici envuelve los fallos
 * de conexión detrás del `TypeError: fetch failed` que lanza `fetch`).
 */
function codigoDeRed(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;

  const directo = (err as { code?: unknown }).code;
  if (typeof directo === "string") return directo;

  const causa = (err as { cause?: unknown }).cause;
  if (typeof causa === "object" && causa !== null) {
    const codigoCausa = (causa as { code?: unknown }).code;
    if (typeof codigoCausa === "string") return codigoCausa;
  }
  return undefined;
}

function esFetchFailedAmbiguo(err: unknown): boolean {
  // `fetch` de undici lanza siempre este mismo TypeError para cualquier
  // fallo de red; cuando no trae un `cause.code` reconocible igual cuenta
  // como transitorio (es un corte de red, no un rechazo de la petición),
  // pero no prueba nada sobre si la petición llegó al otro lado.
  return err instanceof TypeError && err.message === "fetch failed";
}

function codigoPostgrest(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function codigoEsTransitorio(code: string): boolean {
  return PREFIJOS_CODIGO_TRANSITORIO.some((prefijo) => code.startsWith(prefijo));
}

/**
 * `true` si `fallo` describe un corte de la base (red caída, Postgres
 * reiniciando, PostgREST sin conexión) y no un rechazo de la consulta.
 * `23505` (violación de unicidad), `42501` (RLS) o un 400 de validación
 * nunca son transitorios, tengan la forma que tengan.
 *
 * Acepta DOS formas en el mismo parámetro (la firma real es "error o
 * respuesta"): un objeto de error (`TypeError` de red, `PostgrestError`, o
 * cualquier `{ code }`/`{ message }` suelto) o una `RespuestaDeBase` ya
 * leída (`{ status, cuerpo }`). Se distinguen por forma, no por un
 * parámetro aparte, porque los dos llamadores (`fetch-reintentos.ts` sobre
 * un `Response` de verdad, el webhook sobre el `error` que le devuelve
 * supabase-js) tienen cada uno solo una de las dos.
 */
export function esFalloTransitorioDeBase(fallo: unknown): boolean {
  if (esRespuestaDeBase(fallo)) {
    // Cualquier 502/503/504 es un corte de la base: con el cuerpo de Envoy
    // es un proxy que no pudo conectar; sin él, puede ser PostgREST mismo
    // devolviendo un `PGRST00x` en el JSON del cuerpo (no se parsea acá,
    // el status ya alcanza). La diferencia importa para `esReintentoSeguro`,
    // no para esta clasificación.
    return STATUS_HTTP_TRANSITORIOS.includes(fallo.status);
  }

  const codigoRed = codigoDeRed(fallo);
  if (codigoRed && CODIGOS_RED_TRANSITORIOS.includes(codigoRed)) return true;
  if (esFetchFailedAmbiguo(fallo)) return true;

  const codigoPg = codigoPostgrest(fallo);
  if (codigoPg && codigoEsTransitorio(codigoPg)) return true;

  // `code` vacío o ausente (el proxy no dejó un JSON de PostgREST real, ver
  // `mensajeDeError`): clasificar por el TEXTO del proxy en `message`.
  const mensaje = mensajeDeError(fallo);
  if (mensaje && calzaAlguno(mensaje, PATRONES_PROXY_SIN_JSON_DE_POSTGREST)) return true;

  return false;
}

function esMetodoIdempotente(method: string): boolean {
  return METODOS_IDEMPOTENTES.includes(method.toUpperCase());
}

/**
 * `true` si `fallo` PRUEBA, por sí mismo, que la petición nunca llegó al
 * upstream: ni Envoy pudo abrir la conexión hacia PostgREST (los tres
 * patrones de "antes de las cabeceras"), ni Kong pudo siquiera resolver el
 * nombre o elegir a quién mandarle la petición ("name resolution failed",
 * "failure to get a peer from the ring-balancer"), ni el sistema operativo
 * pudo conectar en absoluto (`ECONNREFUSED`/`EAI_AGAIN`). `ECONNRESET`,
 * `ETIMEDOUT`, un "fetch failed" sin `cause.code` y el "invalid response was
 * received from the upstream" de Kong (que SÍ llegó a upstream, solo no
 * entendió la respuesta) quedan afuera: son transitorios, pero AMBIGUOS —
 * la petición pudo haber llegado y ejecutarse, y solo se perdió la
 * respuesta.
 */
function pruebaQueNuncaLlegoAlUpstream(fallo: unknown): boolean {
  if (esRespuestaDeBase(fallo)) {
    return STATUS_HTTP_TRANSITORIOS.includes(fallo.status) && cuerpoCalzaEnvoy(fallo.cuerpo);
  }
  const codigoRed = codigoDeRed(fallo);
  if (codigoRed !== undefined && CODIGOS_RED_SIN_CONEXION.includes(codigoRed)) return true;

  const mensaje = mensajeDeError(fallo);
  if (mensaje && calzaAlguno(mensaje, [...PATRONES_ENVOY_SIN_LLEGAR, ...PATRONES_KONG_SIN_LLEGAR])) {
    return true;
  }
  return false;
}

/**
 * `true` si es seguro reintentar `method` tras `fallo`. Dos condiciones
 * alternativas, sobre un fallo que YA es transitorio
 * (`esFalloTransitorioDeBase`):
 *
 * (a) el método es idempotente (`GET`/`HEAD`): repetirlo no duplica nada.
 * (b) el fallo prueba que la petición nunca llegó al upstream
 *     (`pruebaQueNuncaLlegoAlUpstream`): un `POST`/`PATCH`/`DELETE` que
 *     nunca salió de Envoy tampoco pudo ejecutarse en PostgREST.
 *
 * Un `POST` con `ECONNRESET`/`ETIMEDOUT`/"fetch failed" ambiguo NO es
 * seguro: PostgREST pudo haber ejecutado el INSERT y perderse solo la
 * respuesta — reintentarlo duplicaría la fila (caso real: una fila
 * duplicada en `agent_turns` infla `agent_spend_today()`, que es la suma
 * con la que `agent_can_run()` apaga a Seba por tope de gasto).
 */
export function esReintentoSeguro(method: string, fallo: unknown): boolean {
  if (!esFalloTransitorioDeBase(fallo)) return false;
  if (esMetodoIdempotente(method)) return true;
  return pruebaQueNuncaLlegoAlUpstream(fallo);
}
