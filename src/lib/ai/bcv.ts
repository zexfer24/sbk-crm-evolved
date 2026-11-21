import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { daysBetween, shouldRefetchBcv, venezuelaDate } from "@/lib/bcv-schedule";
import { fetchBcvHtml } from "@/lib/ai/bcv-fetch";
import { leerEstadoBcv, registrarIntentoBcv } from "@/lib/ai/bcv-status";
import { alertaDeTasa, type BcvAlerta, type BcvEstadoLectura } from "@/lib/bcv-alerta";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Tasa oficial del BCV, leída directo de bcv.org.ve (sin servicios de
// terceros). El BCV no publica esto en un formato ordenado: hay que leer su
// página web tal cual la ve un humano, así que si le cambian el diseño esto
// se puede romper — por eso nunca se deja sin respuesta al cliente: si la
// lectura en vivo falla, se usa la última tasa guardada.
//
// La página trae dos datos, no uno: el número y la fecha desde la que rige
// ("Fecha Valor"). Se leen los dos. El BCV suele publicar por la tarde la
// tasa del día hábil siguiente, y sin la fecha no habría forma de saberlo.
// ---------------------------------------------------------------------------

/** Exportada para el simulacro del cron (`?simulacro=aia`), que prueba la misma URL que se lee. */
export const BCV_URL = "https://www.bcv.org.ve/";

/** "775,33560000" -> 775.3356 (formato venezolano: coma decimal). */
function parseVenezuelanNumber(raw: string): number {
  return Number(raw.trim().replace(/\./g, "").replace(",", "."));
}

export interface LiveBcvRate {
  rate: number;
  /**
   * Fecha desde la que rige, según la propia página (YYYY-MM-DD), o `null`
   * si la página no la trajo. Hasta el 24/9/2026 acá se inventaba la fecha
   * de hoy (`?? venezuelaDate()`): con la lectura de las 18:00 el BCV ya
   * publica la tasa de MAÑANA, y guardarla como si rigiera desde hoy pisaría
   * la tasa buena del día en curso. `getBcvRate` decide qué hacer con un
   * `null` (nunca lo escribe a ciegas).
   */
  valueDate: string | null;
}

/**
 * Extrae la "Fecha Valor" que el BCV publica junto a las tasas. Viene en un
 * atributo `content` con la fecha en ISO y el huso de Venezuela, que es más
 * fiable que interpretar el texto "Lunes, 24 Agosto 2026" en español.
 */
function parseValueDate(html: string): string | null {
  const match = html.match(/Fecha Valor:[\s\S]{0,200}?content="(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

async function fetchLiveBcvRate(): Promise<LiveBcvRate> {
  // Por qué no se usa `fetch` acá: ver el encabezado de bcv-fetch.ts (el BCV
  // sirve su certificado sin la cadena intermedia).
  const html = await fetchBcvHtml(BCV_URL);
  const block = html.match(/id="dolar"[\s\S]{0,600}?<\/div>\s*<\/div>/);
  if (!block) {
    throw new Error("No se encontró el bloque de la tasa USD en bcv.org.ve (¿le cambiaron el diseño a la página?).");
  }

  const match = block[0].match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/);
  if (!match) {
    throw new Error("No se pudo leer el número de la tasa dentro del bloque USD de bcv.org.ve.");
  }

  const rate = parseVenezuelanNumber(match[1]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Tasa BCV leída pero inválida: "${match[1]}".`);
  }

  return { rate, valueDate: parseValueDate(html) };
}

export interface BcvRate {
  rate: number;
  /** Fecha desde la que rige la tasa, según el BCV. */
  rateDate: string;
  /** true cuando la lectura en vivo falló y se está usando la última tasa guardada. */
  isStale: boolean;
  /**
   * true SOLO cuando esta llamada salió de verdad a la red y guardó una tasa
   * nueva. `false` cubre tres casos distintos a propósito: no tocaba leer
   * todavía (horario no cumplido), tocaba leer pero la ventana de fallo
   * frenó el intento, o la lectura falló y se devolvió lo guardado.
   */
  refreshed: boolean;
  /**
   * Alerta de "la tasa lleva demasiado sin actualizarse" (T3, 21/11/2026):
   * no-null cuando el último ÉXITO registrado de lectura del BCV tiene más
   * de 8 h (`alertaDeTasa`, `bcv-alerta.ts`). Es independiente de `isStale`:
   * el 19/11/2026 se cargó la tasa a mano en `exchange_rates` y con eso
   * `isStale` quedó en false mientras la lectura llevaba dos días rota; esta
   * alerta mira el estado de la LECTURA (`bcv_fetch_status`), no la fila de
   * la tasa. Siempre `null` tras un refresco exitoso y cuando el estado no
   * existe (tabla aún sin migrar): ahí la app se comporta como antes.
   */
  alerta: BcvAlerta | null;
}

/**
 * Ventana de silencio tras un fallo del BCV, para no repetir el intento (y su
 * timeout de red, ver `TIMEOUT_MS` en `bcv-fetch.ts`) en cada request de la
 * bandeja mientras el BCV está caído.
 *
 * En memoria del proceso, NO en Redis: hay un solo contenedor `app`, un fallo
 * de Redis no debería poder frenar la tasa, y perder la marca en un reinicio
 * solo cuesta un intento de más. El cron (`/api/cron/bcv-refresh`) la ignora
 * con `ignoreFailureBackoff: true` porque reintentar cada minuto no bloquea a
 * ningún request de un agente.
 */
export const BCV_FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * Fallos seguidos a partir de los cuales el log sube a `error`
 * (`bcv_sin_actualizar`). El cron reintenta cada minuto, así que 240 son
 * ~4 h sin una lectura buena: ya se perdió el horario de las 00/06/12/18 que
 * tocaba. Se avisa UNA vez, justo al cruzar el umbral, no en cada minuto.
 */
export const BCV_FALLOS_PARA_ALERTA = 240;

/** Mientras dura una racha, el `warn` se repite cada tantos fallos seguidos. */
const FALLOS_ENTRE_AVISOS = 60;

let lastFailureAt: number | null = null;

// Contador de respaldo, solo si `bcv_fetch_status` no está disponible (el
// código se despliega ANTES que la migración, o la tabla falla): con la tabla
// el contador vive en la base y sobrevive a los reinicios; sin ella, esto da
// el mismo umbral y la misma regla de aviso dentro del proceso.
let fallosEnMemoria = 0;
let errorEnMemoria: string | null = null;

/** Solo para tests: la ventana de fallo y el contador de respaldo son variables de módulo, y un test que las deje encendidas contamina al siguiente. */
export function resetBcvFailureBackoffForTests(): void {
  lastFailureAt = null;
  fallosEnMemoria = 0;
  errorEnMemoria = null;
}

interface CachedBcvRow {
  rate_date: string;
  usd_to_ves: number;
}

interface ResultadoDelIntento {
  fallosSeguidos: number;
  fallosPrevios: number;
  errorPrevio: string | null;
}

/**
 * Anota el intento en `bcv_fetch_status` y, si esa tabla no responde, en el
 * contador de memoria del proceso. Nunca lanza: registrar no puede demorar ni
 * romper la respuesta de la tasa (se espera, pero todo va envuelto).
 */
async function registrarIntento(ok: boolean, motivo: string | null): Promise<ResultadoDelIntento> {
  let registro: ResultadoDelIntento | null = null;
  try {
    registro = await registrarIntentoBcv(ok, motivo);
  } catch {
    registro = null;
  }

  if (registro) {
    // La base manda: el contador de respaldo no debe arrastrar una racha vieja
    // si la tabla aparece (o reaparece) a mitad de vida del proceso.
    fallosEnMemoria = 0;
    errorEnMemoria = null;
    return registro;
  }

  const fallosPrevios = fallosEnMemoria;
  const errorPrevio = errorEnMemoria;
  if (ok) {
    fallosEnMemoria = 0;
    errorEnMemoria = null;
    return { fallosSeguidos: 0, fallosPrevios, errorPrevio };
  }
  fallosEnMemoria = fallosPrevios + 1;
  errorEnMemoria = motivo;
  return { fallosSeguidos: fallosEnMemoria, fallosPrevios, errorPrevio };
}

/**
 * Une el manejo de "la lectura en vivo no sirvió" en todas sus formas: una
 * excepción de verdad (red, TLS, HTML sin el bloque esperado), la página que
 * respondió pero sin "Fecha Valor" y el upsert que la base rechazó. Todas
 * cuentan para la ventana de fallo, todas se registran y todas devuelven la
 * fila guardada si existe.
 *
 * El log ya no grita en cada intento: hasta el 21/11/2026 era un
 * `console.error` por minuto (1.400 al día) con la lectura rota, y por eso
 * nadie lo leyó en dos días. Ahora: un `warn` al primer fallo, o si cambia el
 * motivo, o cada 60 seguidos; y un único `error` al llegar a
 * `BCV_FALLOS_PARA_ALERTA`.
 */
async function reportFailedFetch(
  cached: CachedBcvRow | null,
  motivo: string,
  estado: BcvEstadoLectura | null,
  ahora: Date
): Promise<BcvRate> {
  lastFailureAt = Date.now();

  const { fallosSeguidos, errorPrevio } = await registrarIntento(false, motivo);

  if (!cached) {
    log.error("bcv_sin_tasa_guardada", { motivo });
    throw new Error("No hay ninguna tasa BCV guardada y la lectura en vivo falló. No se puede cotizar en bolívares.");
  }

  // La antigüedad va en el aviso porque es lo que distingue "el BCV tardó un
  // segundo de más" de "llevamos días cotizando con una tasa muerta".
  const diasDeAntiguedad = daysBetween(cached.rate_date, venezuelaDate());

  if (fallosSeguidos === 1 || motivo !== errorPrevio || fallosSeguidos % FALLOS_ENTRE_AVISOS === 0) {
    log.warn("bcv_lectura_fallida", { fallosSeguidos, motivo, tasaDe: cached.rate_date, diasDeAntiguedad });
  }

  if (fallosSeguidos === BCV_FALLOS_PARA_ALERTA) {
    log.error("bcv_sin_actualizar", {
      fallosSeguidos,
      ultimoExito: estado?.lastSuccessAt ?? null,
      motivo,
      tasaDe: cached.rate_date,
    });
  }

  // El estado se leyó ANTES de este intento: se le suma lo que acaba de pasar
  // para que la alerta muestre el error de ahora y no el de hace un minuto.
  const estadoConEsteIntento: BcvEstadoLectura | null = estado
    ? {
        ...estado,
        lastFailureAt: ahora.toISOString(),
        lastError: motivo,
        consecutiveFailures: fallosSeguidos,
      }
    : null;

  return {
    rate: Number(cached.usd_to_ves),
    rateDate: cached.rate_date,
    isStale: true,
    refreshed: false,
    alerta: alertaDeTasa(estadoConEsteIntento, ahora),
  };
}

/**
 * Tasa BCV (Bs por USD) vigente ahora mismo.
 *
 * Hasta el 24/9/2026 se releía como mucho una vez por día calendario
 * (`fetched_on`). Ese día la única lectura fue a las 07:08, antes de que el
 * BCV publicara la tasa de mañana (suele salir por la tarde), y a las 23:53
 * el chip seguía mostrando la tasa vieja con la nueva ya disponible. Ahora se
 * relee contra cuatro horarios fijos por día (`BCV_READ_HOURS`,
 * `bcv-schedule.ts`), comparando el último horario cumplido contra el
 * instante exacto en que se leyó por última vez (`fetched_at`), no contra un
 * día calendario.
 *
 * Si la lectura en vivo falla —o el BCV no publicó "Fecha Valor" esta
 * vez—, se usa la última tasa guardada en vez de romper el turno del
 * agente, y no se vuelve a intentar por `BCV_FAILURE_BACKOFF_MS` (salvo
 * `opts.ignoreFailureBackoff`, que usa el cron).
 *
 * Cada intento REAL a la red (y solo esos: no cuando no tocaba leer ni
 * cuando la ventana de fallo lo frenó) deja su resultado en
 * `bcv_fetch_status`, y la respuesta trae `alerta` cuando el último éxito
 * tiene más de 8 h (T3, 21/11/2026; ver `BcvRate.alerta`). Si esa tabla
 * todavía no existe, la tasa se lee exactamente igual que antes.
 */
export async function getBcvRate(
  supabase: SupabaseClient<Database>,
  opts: { ignoreFailureBackoff?: boolean } = {}
): Promise<BcvRate> {
  // Dos consultas separadas a propósito: "qué tasa uso" (la de mayor
  // rate_date) y "cuándo leí por última vez" (el fetched_at más reciente).
  // Normalmente son la misma fila, pero no hay que depender de eso — un
  // upsert que llegue con un rate_date menor al ya guardado (la tasa del
  // sábado sigue rigiendo el lunes) dejaría la fila "más nueva" con una
  // lectura vieja si se leyera una sola columna de una sola fila. La tercera
  // lectura (el estado de la lectura) viaja en paralelo y nunca lanza.
  const [{ data: cached }, { data: lastFetch }, estado] = await Promise.all([
    supabase.from("exchange_rates").select("rate_date, usd_to_ves").order("rate_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("exchange_rates").select("fetched_at").order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
    leerEstadoBcv(supabase),
  ]);

  const ahora = new Date();
  const lastFetchedAt = lastFetch?.fetched_at ? new Date(lastFetch.fetched_at) : null;

  if (cached && !shouldRefetchBcv(ahora, lastFetchedAt)) {
    return {
      rate: Number(cached.usd_to_ves),
      rateDate: cached.rate_date,
      isStale: false,
      refreshed: false,
      alerta: alertaDeTasa(estado, ahora),
    };
  }

  // Toca leer, pero si el BCV falló hace poco no hay que volver a golpearlo
  // (ni hacer esperar al request de un agente el timeout de bcv-fetch.ts) —
  // salvo que hubiera una fila guardada de la que valga la pena salir: sin
  // nada guardado no hay nada que devolver, así que se intenta igual.
  if (
    cached &&
    lastFailureAt !== null &&
    Date.now() - lastFailureAt < BCV_FAILURE_BACKOFF_MS &&
    !opts.ignoreFailureBackoff
  ) {
    return {
      rate: Number(cached.usd_to_ves),
      rateDate: cached.rate_date,
      isStale: true,
      refreshed: false,
      alerta: alertaDeTasa(estado, ahora),
    };
  }

  let motivoDelFallo: string;
  let lectura: LiveBcvRate | null = null;

  try {
    const live = await fetchLiveBcvRate();

    if (live.valueDate === null) {
      // La lectura salió bien pero sin fecha de vigencia: no hay forma de
      // saber si esta tasa rige HOY o desde mañana. Guardarla con la fecha
      // de hoy (lo que se hacía hasta el 24/9/2026) podía pisar la tasa
      // buena del día en curso con la del día siguiente. Se trata como
      // cualquier otra lectura fallida: se devuelve lo guardado y se anota
      // en la ventana de fallo.
      log.warn("bcv_sin_fecha_valor", { rate: live.rate });
      motivoDelFallo = "La página del BCV no trajo «Fecha Valor».";
    } else {
      const { error: upsertError } = await supabase.from("exchange_rates").upsert({
        rate_date: live.valueDate,
        usd_to_ves: live.rate,
        source: "bcv.org.ve",
        // Ya no decide nada (la regla de relectura mira `fetched_at`), pero se
        // sigue escribiendo para no dejar la columna a medias.
        fetched_on: venezuelaDate(),
        // Sin esto la regla por horario volvía a leer en cada request: la
        // columna tiene `default now()`, así que un upsert que no la tocara
        // solo guardaba cuándo NACIÓ la fila — medido el 24/9/2026, la fila
        // decía 19/9 con lecturas exitosas posteriores de por medio.
        fetched_at: new Date().toISOString(),
      });

      if (upsertError) {
        // Hasta el 21/11/2026 este error no se miraba: una tasa leída que la
        // base rechazaba (permiso, red) se daba por guardada y `refreshed`
        // salía en true sin que la fila hubiera cambiado.
        motivoDelFallo = `No se pudo guardar la tasa leída: ${errorText(upsertError)}`;
      } else {
        lectura = live;
        motivoDelFallo = "";
      }
    }
  } catch (err) {
    motivoDelFallo = errorText(err);
  }

  if (lectura && lectura.valueDate !== null) {
    lastFailureAt = null;
    const { fallosPrevios } = await registrarIntento(true, null);
    if (fallosPrevios > 0) {
      log.info("bcv_lectura_recuperada", { fallosPrevios });
    }
    return { rate: lectura.rate, rateDate: lectura.valueDate, isStale: false, refreshed: true, alerta: null };
  }

  return reportFailedFetch(cached, motivoDelFallo, estado, ahora);
}
