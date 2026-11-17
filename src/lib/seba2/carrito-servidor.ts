import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { LineaDeCarrito } from "./tipos";

/**
 * Escribe en el carrito de la conversación (`conversation_cart_items`) lo que Seba
 * v2 armó durante el turno (17/11/2026). Corre con el cliente admin: el carrito
 * normal se escribe desde el navegador (`addToCart`, `mutations.ts`) y no se puede
 * importar acá.
 *
 * Reglas:
 *  - Si el producto ya está en el carrito, solo se corrigen cantidad y tipo de
 *    precio. El `origin` NO se toca: un renglón que puso el asesor desde el
 *    inventario sigue siendo del asesor aunque Seba lo reitere.
 *  - Si no está, se inserta con `origin = 'seba'` (permitido por la migración
 *    20261117010000).
 *  - Nunca borra: un renglón que el asesor agregó o que Seba ya no menciona se
 *    queda. Vaciar el carrito es decisión del asesor al cerrar la venta.
 *  - La tabla no guarda precio a propósito (se factura el vigente), así que acá
 *    tampoco se manda ninguno.
 *
 * LANZA si la base devuelve error: el turno decide qué hacer (aquí no se traga
 * nada, para que un carrito que no se guardó no parezca guardado).
 */

/** Violación de unicidad de Postgres: el asesor agregó el mismo producto entre la lectura y el insert. */
const UNIQUE_VIOLATION = "23505";

type CartUpdate = Pick<
  Database["public"]["Tables"]["conversation_cart_items"]["Update"],
  "quantity" | "price_kind"
>;

export async function escribirCarritoDeSeba(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  lineas: LineaDeCarrito[]
): Promise<void> {
  if (lineas.length === 0) return;

  // Si el modelo repite un producto, gana la última mención (la más reciente).
  const porProducto = new Map<string, LineaDeCarrito>();
  for (const linea of lineas) porProducto.set(linea.productId, linea);
  const productIds = [...porProducto.keys()];

  const { data: existentes, error: errorLectura } = await supabase
    .from("conversation_cart_items")
    .select("id, product_id, origin")
    .eq("conversation_id", conversationId)
    .in("product_id", productIds);
  if (errorLectura) throw new Error(errorLectura.message);

  const yaEstan = new Set((existentes ?? []).map((fila) => fila.product_id));

  async function actualizar(linea: LineaDeCarrito): Promise<void> {
    const cambios: CartUpdate = { quantity: linea.cantidad, price_kind: linea.priceKind };
    const { error } = await supabase
      .from("conversation_cart_items")
      .update(cambios)
      .eq("conversation_id", conversationId)
      .eq("product_id", linea.productId);
    if (error) throw new Error(error.message);
  }

  for (const linea of porProducto.values()) {
    if (yaEstan.has(linea.productId)) await actualizar(linea);
  }

  const nuevas = [...porProducto.values()].filter((linea) => !yaEstan.has(linea.productId));
  if (nuevas.length === 0) return;

  const { error: errorInsert } = await supabase.from("conversation_cart_items").insert(
    nuevas.map((linea) => ({
      conversation_id: conversationId,
      product_id: linea.productId,
      quantity: linea.cantidad,
      price_kind: linea.priceKind,
      origin: "seba",
    }))
  );

  if (!errorInsert) return;
  if (errorInsert.code !== UNIQUE_VIOLATION) throw new Error(errorInsert.message);

  // Carrera: un asesor agregó alguno de estos productos justo ahora y el lote
  // entero se rechazó. Se resuelve línea por línea: la que de verdad no existe se
  // inserta, la que ya apareció se actualiza (un update sobre una fila inexistente
  // no daría error y la línea se perdería sin aviso).
  for (const linea of nuevas) {
    const { error } = await supabase.from("conversation_cart_items").insert({
      conversation_id: conversationId,
      product_id: linea.productId,
      quantity: linea.cantidad,
      price_kind: linea.priceKind,
      origin: "seba",
    });
    if (!error) continue;
    if (error.code !== UNIQUE_VIOLATION) throw new Error(error.message);
    await actualizar(linea);
  }
}
