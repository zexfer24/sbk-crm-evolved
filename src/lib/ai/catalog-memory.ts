import "server-only";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// T3a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): la memoria del pedido de catálogo.
//
// El estudio del VPS (1.027 turnos, 25-28/9/2026) encontró que Seba no
// recordaba lo que el cliente ya había pedido: contestaba "24" (la respuesta
// a "¿qué medida?") buscando un "24" suelto, y repetía la pregunta de filtro
// porque nadie anotaba que ya la había hecho. Este módulo guarda, por
// conversación y en Redis, lo mínimo para que `buscarRepuesto` (tools.ts)
// resuelva las dos cosas:
//
//   - `ultimoQuery`: el último pedido CON producto ("aceite inca", "asiento
//     sbr"), acumulado. Una respuesta suelta ("20w50", "Talla M", "24") se
//     combina con él en vez de buscarse sola.
//   - `moto` / `cilindrada`: la moto que el cliente ya dio, para que la
//     respuesta suelta no la pierda.
//   - `preguntaHechaPara`: la clave del producto por el que ya se hizo la
//     pregunta de filtro — "una sola pregunta por pedido".
//   - (A2 T5, 30/9/2026) `anio` y `preguntaTipo`: el año de la moto y QUÉ se
//     preguntó ("moto" o "producto"). Tras la pregunta por la moto, un número
//     de dos dígitos es el año y la respuesta entera es la moto; tras la del
//     producto, sigue siendo una medida. Las claves anteriores a A2 (sin
//     esos dos campos) se siguen leyendo.
//
// TTL de 6 horas, igual que la marca "visto hasta" (`turn-seen.ts`): un
// pedido que el cliente dejó ayer no debe contaminar una consulta de hoy, y
// el TTL evita que Redis acumule claves de conversaciones muertas. El TTL
// nunca decide nada por sí solo: vencido, todo se comporta como si nunca
// hubiera habido memoria.
//
// `leerPedido`/`guardarPedido` NUNCA lanzan (mismo criterio que
// `readSeen`/`writeSeen`): sin `REDIS_URL` o con Redis caído la herramienta
// se comporta como antes de esta tarea —sin memoria: la respuesta suelta se
// busca sola y la pregunta puede repetirse—, con un `log.warn` que usa
// `errorText` (CLAUDE.md: nunca `err instanceof Error ? … : String(err)`).
// ---------------------------------------------------------------------------

/** Seis horas, en segundos. */
export const CATALOGO_PEDIDO_TTL_SECONDS = 6 * 60 * 60;

export interface PedidoCatalogo {
  /** El último pedido con producto, acumulado, o `null` si todavía no hubo ninguno. */
  ultimoQuery: string | null;
  /** Grupos de moto CON NOMBRE que el cliente ya dio (`[["sbr"]]`). */
  moto: string[][];
  /** Cilindrada suelta que el cliente ya dio (`[["200"]]`). */
  cilindrada: string[][];
  /**
   * A2 T5 (30/9/2026): el año de la moto que el cliente ya dio (`[["2024"]]`).
   * Solo ordena la búsqueda y jamás es un término del producto. Los objetos
   * guardados antes de A2 no lo traen: se leen como `[]`.
   */
  anio: string[][];
  /** Clave del producto por el que ya se hizo la pregunta de filtro, o `null`. */
  preguntaHechaPara: string | null;
  /**
   * A2 T5 (30/9/2026): QUÉ se preguntó ("moto" = `PREGUNTA_FILTRO`, "producto"
   * = `PREGUNTA_FILTRO_PRODUCTO`), o `null`. Decide cómo se lee la respuesta
   * suelta: un número de 2 dígitos tras la pregunta por la MOTO es el año; tras
   * la pregunta por el PRODUCTO sigue siendo una medida. Los objetos viejos no
   * lo traen: se leen como `null`.
   */
  preguntaTipo: "moto" | "producto" | null;
}

function pedidoKey(conversationId: string): string {
  return `catalogo:pedido:${conversationId}`;
}

function esGruposDeTexto(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((grupo) => Array.isArray(grupo) && grupo.every((alt) => typeof alt === "string"))
  );
}

/**
 * El pedido con su forma completa, o `null` si `value` no la tiene: protege
 * contra un JSON corrupto en la clave. Un objeto anterior a A2 (sin `anio` ni
 * `preguntaTipo`) se acepta con los dos en su valor neutro; uno con esos campos
 * mal formados NO se adivina.
 */
function comoPedidoCatalogo(value: unknown): PedidoCatalogo | null {
  if (typeof value !== "object" || value === null) return null;
  const { ultimoQuery, moto, cilindrada, anio, preguntaHechaPara, preguntaTipo } = value as Record<string, unknown>;
  if (!(ultimoQuery === null || typeof ultimoQuery === "string")) return null;
  if (!esGruposDeTexto(moto) || !esGruposDeTexto(cilindrada)) return null;
  if (!(preguntaHechaPara === null || typeof preguntaHechaPara === "string")) return null;
  if (anio !== undefined && !esGruposDeTexto(anio)) return null;
  if (preguntaTipo !== undefined && preguntaTipo !== null && preguntaTipo !== "moto" && preguntaTipo !== "producto") {
    return null;
  }
  return {
    ultimoQuery,
    moto,
    cilindrada,
    anio: anio ?? [],
    preguntaHechaPara,
    preguntaTipo: preguntaTipo ?? null,
  };
}

/**
 * El pedido guardado de esta conversación, o `null` si no hay: nunca se
 * escribió, venció, la clave está corrupta o Redis no respondió (nunca lanza).
 */
export async function leerPedido(conversationId: string): Promise<PedidoCatalogo | null> {
  try {
    const raw = await getRedis().get(pedidoKey(conversationId));
    if (raw === null) return null;
    return comoPedidoCatalogo(JSON.parse(raw) as unknown);
  } catch (err) {
    log.warn("catalogo_pedido_no_legible", { conversationId, detail: errorText(err) });
    return null;
  }
}

/** Deja el pedido de esta conversación, con TTL de 6 h. Nunca lanza. */
export async function guardarPedido(conversationId: string, pedido: PedidoCatalogo): Promise<void> {
  try {
    await getRedis().set(pedidoKey(conversationId), JSON.stringify(pedido), "EX", CATALOGO_PEDIDO_TTL_SECONDS);
  } catch (err) {
    log.warn("catalogo_pedido_no_escrito", { conversationId, detail: errorText(err) });
  }
}
