import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { daysBetween, shouldRefetchBcv, venezuelaDate } from "@/lib/bcv-schedule";
import { fetchBcvHtml } from "@/lib/ai/bcv-fetch";
import { BCV_LEAF_EXPIRES_ON } from "@/lib/ai/bcv-intermediate-ca";
import { log } from "@/lib/log";

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

const BCV_URL = "https://www.bcv.org.ve/";

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

let lastFailureAt: number | null = null;

/** Solo para tests: la ventana de fallo es una variable de módulo, y un test que la deje encendida contamina al siguiente. */
export function resetBcvFailureBackoffForTests(): void {
  lastFailureAt = null;
}

interface CachedBcvRow {
  rate_date: string;
  usd_to_ves: number;
}

/**
 * Une el manejo de "la lectura en vivo no sirvió" en sus dos formas: una
 * excepción de verdad (red caída, HTML sin el bloque esperado) y la página
 * que respondió pero sin "Fecha Valor". Las dos cuentan para la ventana de
 * fallo y las dos devuelven la fila guardada si existe.
 */
function reportFailedFetch(cached: CachedBcvRow | null, err?: unknown): BcvRate {
  lastFailureAt = Date.now();

  if (!cached) {
    console.error(
      "[BCV] Lectura en vivo fallida y no hay ninguna tasa guardada: no se puede cotizar en bolívares.",
      err
    );
    throw new Error("No hay ninguna tasa BCV guardada y la lectura en vivo falló. No se puede cotizar en bolívares.");
  }

  // El aviso lleva la antigüedad porque es lo que distingue "el BCV tardó un
  // segundo de más" de "llevamos días cotizando con una tasa muerta". Sin ese
  // número, los dos casos se leen igual en el log — y el segundo pasó tres
  // días sin que nadie lo notara.
  const staleDays = daysBetween(cached.rate_date, venezuelaDate());
  console.error(
    `[BCV] Lectura en vivo fallida: se cotiza con la tasa del ${cached.rate_date}` +
      `, ${staleDays} día(s) de antigüedad.` +
      (staleDays >= 2
        ? ` ATENCIÓN: son precios viejos. Si se repite, revisar la cadena TLS` +
          ` (src/lib/ai/bcv-intermediate-ca.ts; la hoja del BCV caduca ${BCV_LEAF_EXPIRES_ON}).`
        : ""),
    err
  );

  return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: true, refreshed: false };
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
  // lectura vieja si se leyera una sola columna de una sola fila.
  const [{ data: cached }, { data: lastFetch }] = await Promise.all([
    supabase.from("exchange_rates").select("rate_date, usd_to_ves").order("rate_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("exchange_rates").select("fetched_at").order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const lastFetchedAt = lastFetch?.fetched_at ? new Date(lastFetch.fetched_at) : null;

  if (cached && !shouldRefetchBcv(new Date(), lastFetchedAt)) {
    return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: false, refreshed: false };
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
    return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: true, refreshed: false };
  }

  try {
    const { rate, valueDate } = await fetchLiveBcvRate();

    if (valueDate === null) {
      // La lectura salió bien pero sin fecha de vigencia: no hay forma de
      // saber si esta tasa rige HOY o desde mañana. Guardarla con la fecha
      // de hoy (lo que se hacía hasta el 24/9/2026) podía pisar la tasa
      // buena del día en curso con la del día siguiente. Se trata como
      // cualquier otra lectura fallida: se devuelve lo guardado y se anota
      // en la ventana de fallo.
      log.warn("bcv_sin_fecha_valor", { rate });
      return reportFailedFetch(cached);
    }

    await supabase.from("exchange_rates").upsert({
      rate_date: valueDate,
      usd_to_ves: rate,
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

    lastFailureAt = null;
    return { rate, rateDate: valueDate, isStale: false, refreshed: true };
  } catch (err) {
    return reportFailedFetch(cached, err);
  }
}
