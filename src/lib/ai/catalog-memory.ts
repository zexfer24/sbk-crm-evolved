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
  /** Clave del producto por el que ya se hizo la pregunta de filtro, o `null`. */
  preguntaHechaPara: string | null;
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

/** ¿`value` tiene la forma de `PedidoCatalogo`? Protege contra un JSON viejo o corrupto en la clave. */
function esPedidoCatalogo(value: unknown): value is PedidoCatalogo {
  if (typeof value !== "object" || value === null) return false;
  const { ultimoQuery, moto, cilindrada, preguntaHechaPara } = value as Record<string, unknown>;
  return (
    (ultimoQuery === null || typeof ultimoQuery === "string") &&
    esGruposDeTexto(moto) &&
    esGruposDeTexto(cilindrada) &&
    (preguntaHechaPara === null || typeof preguntaHechaPara === "string")
  );
}

/**
 * El pedido guardado de esta conversación, o `null` si no hay: nunca se
 * escribió, venció, la clave está corrupta o Redis no respondió (nunca lanza).
 */
export async function leerPedido(conversationId: string): Promise<PedidoCatalogo | null> {
  try {
    const raw = await getRedis().get(pedidoKey(conversationId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return esPedidoCatalogo(parsed) ? parsed : null;
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
