import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// Tasa oficial del BCV, leída directo de bcv.org.ve (sin servicios de
// terceros). El BCV no publica esto en un formato ordenado: hay que leer su
// página web tal cual la ve un humano, así que si le cambian el diseño esto
// se puede romper — por eso nunca se deja sin respuesta al cliente: si la
// lectura en vivo falla, se usa la última tasa guardada.
// ---------------------------------------------------------------------------

const BCV_URL = "https://www.bcv.org.ve/";

/** "775,33560000" -> 775.3356 (formato venezolano: coma decimal). */
function parseVenezuelanNumber(raw: string): number {
  return Number(raw.trim().replace(/\./g, "").replace(",", "."));
}

async function fetchLiveBcvRate(): Promise<number> {
  const res = await fetch(BCV_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LiminalCRM/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`bcv.org.ve respondió ${res.status} al pedir la tasa.`);
  }

  const html = await res.text();
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
  return rate;
}

export interface BcvRate {
  rate: number;
  rateDate: string;
  /** true cuando la lectura en vivo falló y se está usando la última tasa guardada. */
  isStale: boolean;
}

/**
 * Tasa BCV (Bs por USD) cacheada por día. Si ya hay una tasa guardada para
 * hoy, la usa sin salir a la red. Si no, intenta leerla en vivo y la guarda;
 * si la lectura falla, cae a la última tasa que haya en la base en vez de
 * romper el turno del agente.
 */
export async function getBcvRate(supabase: SupabaseClient<Database>): Promise<BcvRate> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: cached } = await supabase
    .from("exchange_rates")
    .select("rate_date, usd_to_ves")
    .eq("rate_date", today)
    .maybeSingle();

  if (cached) {
    return { rate: Number(cached.usd_to_ves), rateDate: cached.rate_date, isStale: false };
  }

  try {
    const rate = await fetchLiveBcvRate();
    await supabase.from("exchange_rates").upsert({ rate_date: today, usd_to_ves: rate, source: "bcv.org.ve" });
    return { rate, rateDate: today, isStale: false };
  } catch (err) {
    console.error("No se pudo leer la tasa BCV en vivo, se usa la última guardada:", err);

    const { data: latest } = await supabase
      .from("exchange_rates")
      .select("rate_date, usd_to_ves")
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest) {
      throw new Error("No hay ninguna tasa BCV guardada y la lectura en vivo falló. No se puede cotizar en bolívares.");
    }
    return { rate: Number(latest.usd_to_ves), rateDate: latest.rate_date, isStale: true };
  }
}
