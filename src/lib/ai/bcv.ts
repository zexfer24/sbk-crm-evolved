import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { shouldRefetchBcv, venezuelaDate } from "@/lib/bcv-schedule";
import { fetchBcvHtml } from "@/lib/ai/bcv-fetch";

// ---------------------------------------------------------------------------
// Tasa oficial del BCV, leída directo de bcv.org.ve (sin servicios de
// terceros). El BCV no publica esto en un formato ordenado: hay que leer su
// página web tal cual la ve un humano, así que si le cambian el diseño esto
// se puede romper — por eso nunca se deja sin respuesta al cliente: si la
// lectura en vivo falla, se usa la última tasa guardada.
//
// La página trae dos datos, no uno: el número y la fecha desde la que rige
// ("Fecha Valor"). Se leen los dos. Un sábado el número que aparece ya es el
// del lunes siguiente, y sin la fecha no habría forma de saberlo.
// ---------------------------------------------------------------------------

const BCV_URL = "https://www.bcv.org.ve/";

/** "775,33560000" -> 775.3356 (formato venezolano: coma decimal). */
function parseVenezuelanNumber(raw: string): number {
  return Number(raw.trim().replace(/\./g, "").replace(",", "."));
}

export interface LiveBcvRate {
  rate: number;
  /** Fecha desde la que rige, según la propia página (YYYY-MM-DD). */
  valueDate: string;
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

  // Si un día la página deja de traer la fecha, la tasa sigue sirviendo: se
  // le atribuye el día de hoy, que es lo que se hacía antes de leerla.
  const valueDate = parseValueDate(html) ?? venezuelaDate();

  return { rate, valueDate };
}

export interface BcvRate {
  rate: number;
  /** Fecha desde la que rige la tasa, según el BCV. */
  rateDate: string;
  /** true cuando la lectura en vivo falló y se está usando la última tasa guardada. */
  isStale: boolean;
}

/**
 * Tasa BCV (Bs por USD) vigente ahora mismo.
 *
 * El BCV publica de lunes a sábado, y lo que publica el sábado es la tasa que
 * rige el lunes. Así que el sábado se lee y esa misma tasa vale sábado,
 * domingo y lunes; el domingo no se sale a la red porque no hay nada nuevo, y
 * el lunes sí, porque es cuando puede cambiar. Esa decisión vive en
 * `shouldRefetchBcv`, que mira cuándo se leyó por última vez.
 *
 * Si la lectura en vivo falla, se usa la última tasa guardada en vez de
 * romper el turno del agente.
 */
export async function getBcvRate(supabase: SupabaseClient<Database>): Promise<BcvRate> {
  const today = venezuelaDate();

  // La última tasa que tengamos, por fecha de vigencia. El sábado esta fila
  // ya puede ser la del lunes: por eso el refresco se decide con `fetched_on`
  // (cuándo la leímos) y no con `rate_date` (desde cuándo rige).
  const { data: cached } = await supabase
    .from("exchange_rates")
    .select("rate_date, usd_to_ves, fetched_on")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cached && !shouldRefetchBcv(today, cached.fetched_on)) {
    return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: false };
  }

  try {
    const { rate, valueDate } = await fetchLiveBcvRate();
    await supabase.from("exchange_rates").upsert({
      rate_date: valueDate,
      usd_to_ves: rate,
      source: "bcv.org.ve",
      fetched_on: today,
    });
    return { rate, rateDate: valueDate, isStale: false };
  } catch (err) {
    console.error("No se pudo leer la tasa BCV en vivo, se usa la última guardada:", err);

    if (!cached) {
      throw new Error("No hay ninguna tasa BCV guardada y la lectura en vivo falló. No se puede cotizar en bolívares.");
    }
    return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: true };
  }
}
