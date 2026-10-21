import type { AgentRole, CartPriceKind, Product } from "@/lib/types";
import { cartTotals, priceCartLines, type PriceableCartItem, type PricedCartLine } from "@/lib/conversation-cart";
import type { LineaCarritoInventario } from "@/lib/inventario-carrito";

/**
 * Presupuestos guardados (21/10/2026, plan "Presupuestos y mensajes rápidos",
 * T3): reglas PURAS de los presupuestos que un asesor guarda por cliente desde
 * el carrito de /inventario o el del chat y reabre después. Sin React ni
 * Supabase; la lectura y la escritura viven en `presupuestos-data.ts`.
 *
 * D1: al reabrir se cobra el precio de HOY. `precioCotizadoUsd` y
 * `totalCotizadoUsd` son solo referencia para mostrar «cotizado $X» junto al
 * total de hoy; nunca se facturan (misma regla D6 de los carritos: una copia
 * de precio se desactualiza en cuanto Saint cambia el precio o el BCV la
 * tasa).
 */

export interface PresupuestoItem {
  id: string;
  productId: string;
  product: Product;
  quantity: number;
  priceKind: CartPriceKind;
  /** Precio unitario vigente al guardar, en dólares. Referencia (D1): nunca se cobra. */
  precioCotizadoUsd: number | null;
}

export interface Presupuesto {
  id: string;
  clienteNombre: string;
  clienteApellido: string;
  contactId: string | null;
  conversationId: string | null;
  origen: "inventario" | "chat";
  nota: string | null;
  /** Referencia (D1); `null` si algún renglón se guardó sin precio. */
  totalCotizadoUsd: number | null;
  /** `null` si el asesor que lo guardó ya no existe (`on delete set null`). */
  createdBy: string | null;
  creadoPorNombre: string | null;
  createdAt: string;
  updatedAt: string;
  items: PresupuestoItem[];
}

/** Un renglón en la forma que espera la RPC `guardar_presupuesto` (`p_items`). */
export interface ItemParaGuardar {
  product_id: string;
  quantity: number;
  price_kind: CartPriceKind;
  precio_cotizado_usd: number | null;
}

/** Los mismos topes que los CHECK de la tabla `presupuestos`. */
export const MAX_NOMBRE_CLIENTE = 80;
export const MAX_NOTA_PRESUPUESTO = 280;

/** Un mensaje por campo inválido, medido sobre el texto recortado (la RPC también lo recorta). */
export function validarDatosPresupuesto(datos: {
  nombre: string;
  apellido: string;
  nota: string;
}): Partial<Record<"nombre" | "apellido" | "nota", string>> {
  const errores: Partial<Record<"nombre" | "apellido" | "nota", string>> = {};
  const nombre = datos.nombre.trim();
  const apellido = datos.apellido.trim();
  const nota = datos.nota.trim();

  if (nombre === "") errores.nombre = "Escribe el nombre del cliente.";
  else if (nombre.length > MAX_NOMBRE_CLIENTE) errores.nombre = `Máximo ${MAX_NOMBRE_CLIENTE} caracteres.`;

  if (apellido === "") errores.apellido = "Escribe el apellido del cliente.";
  else if (apellido.length > MAX_NOMBRE_CLIENTE) errores.apellido = `Máximo ${MAX_NOMBRE_CLIENTE} caracteres.`;

  if (nota.length > MAX_NOTA_PRESUPUESTO) errores.nota = `La nota admite hasta ${MAX_NOTA_PRESUPUESTO} caracteres.`;

  return errores;
}

/**
 * Para precargar el modal desde el contacto del chat: la primera palabra es el
 * nombre y el resto el apellido ("María José Pérez" → "María" / "José Pérez").
 * Es una sugerencia que el asesor corrige; con una sola palabra el apellido
 * queda vacío y el modal lo pide.
 */
export function separarNombreContacto(displayName: string | null): { nombre: string; apellido: string } {
  const palabras = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return { nombre: "", apellido: "" };
  return { nombre: palabras[0], apellido: palabras.slice(1).join(" ") };
}

export function nombreCompletoPresupuesto(p: Pick<Presupuesto, "clienteNombre" | "clienteApellido">): string {
  return `${p.clienteNombre} ${p.clienteApellido}`.trim();
}

/** Sin acentos ni mayúsculas. Propio de este módulo: no depende del buscador de mensajes rápidos. */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * El buscador de la lista: cada palabra escrita debe aparecer en «nombre
 * apellido» (sin acentos ni mayúsculas, en cualquier orden); `soloDe` deja
 * solo los de ese autor. Sin texto ni autor devuelve la lista tal cual.
 */
export function filtrarPresupuestos(
  lista: Presupuesto[],
  filtro: { texto: string; soloDe: string | null },
): Presupuesto[] {
  const palabras = normalizar(filtro.texto).split(/\s+/).filter(Boolean);
  return lista.filter((p) => {
    if (filtro.soloDe !== null && p.createdBy !== filtro.soloDe) return false;
    if (palabras.length === 0) return true;
    const nombre = normalizar(nombreCompletoPresupuesto(p));
    return palabras.every((palabra) => nombre.includes(palabra));
  });
}

/**
 * ¿Puede cambiar o borrar este presupuesto? El autor, o un supervisor/admin
 * (D2). Es solo para pintar o esconder el botón: la barrera real es la RLS de
 * `presupuestos` (`presupuestos_update`/`presupuestos_delete`).
 */
export function puedeEditarPresupuesto(
  p: Pick<Presupuesto, "createdBy">,
  agente: { id: string; role: AgentRole },
): boolean {
  if (agente.role === "supervisor" || agente.role === "admin") return true;
  return p.createdBy !== null && p.createdBy === agente.id;
}

/**
 * Los renglones de un carrito ya con precio, listos para `guardar_presupuesto`.
 * `precio_cotizado_usd` es el precio unitario vigente (referencia, D1); un
 * renglón sin precio guarda `null` y deja el total del presupuesto en `null`.
 */
export function renglonesParaGuardar(lineas: PricedCartLine<PriceableCartItem>[]): ItemParaGuardar[] {
  return lineas.map((linea) => ({
    product_id: linea.item.product.id,
    quantity: linea.item.quantity,
    price_kind: linea.item.priceKind ?? "promocion",
    precio_cotizado_usd: linea.unitPriceUsd,
  }));
}

/** Las líneas del carrito de /inventario al reabrir un presupuesto. El precio cotizado queda como referencia. */
export function lineasDePresupuesto(p: Presupuesto): LineaCarritoInventario[] {
  return p.items.map((item) => ({
    product: item.product,
    quantity: item.quantity,
    quotedPriceUsd: item.precioCotizadoUsd,
    priceKind: item.priceKind,
  }));
}

/**
 * «Cotizado vs hoy» del total: `null` si no hay nada que avisar —el presupuesto
 * se guardó sin total, hoy algún renglón no tiene precio (falta la tasa o la
 * tarifa MRW: no se compara contra un total a medias) o la diferencia es menor
 * a medio centavo—.
 */
export function comparacionTotal(p: Presupuesto, bcvRate: number): { cotizadoUsd: number; hoyUsd: number } | null {
  if (p.totalCotizadoUsd === null) return null;
  const lineas = priceCartLines(lineasDePresupuesto(p), bcvRate);
  const totales = cartTotals(lineas);
  if (totales.unpricedCount > 0) return null;
  if (Math.abs(p.totalCotizadoUsd - totales.usd) < 0.005) return null;
  return { cotizadoUsd: p.totalCotizadoUsd, hoyUsd: totales.usd };
}

/** «cotizado $84.90»: el mismo formato de dólares del resumen del carrito (`cartSummaryText`). */
export function etiquetaComparacion(comparacion: { cotizadoUsd: number }): string {
  return `cotizado $${comparacion.cotizadoUsd.toFixed(2)}`;
}
