import type { Product } from "@/lib/types";

/**
 * Lógica pura de la sección Inventario.
 *
 * El punto de esta sección es que lo que se ve acá es exactamente lo que la
 * herramienta de catálogo de la IA lee en el próximo turno: misma tabla
 * (`products`), sin copia intermedia. Por eso las reglas de visibilidad de
 * abajo replican las de `buildCatalogTool`.
 *
 * Desde el 25/9/2026 (T1, plan "El inventario llega de Saint y no se toca a
 * mano", migración 20260925010000) Saint es el único dueño de nombre,
 * precio, existencia e `is_active`: `saint.sync_products()` los copia cada
 * minuto y la base impide escribirlos desde la app. Lo único que este
 * módulo sigue validando para el formulario es el peso — `parseStockInput`
 * y el resto de la validación de stock/precio ya no tienen sentido y se
 * retiraron.
 */

/** Por debajo o igual a esto, el repuesto se muestra en amarillo. */
export const LOW_STOCK_THRESHOLD = 3;

export type StockLevel = "agotado" | "bajo" | "disponible";

export function stockLevel(product: Product): StockLevel {
  if (product.stockQuantity <= 0) return "agotado";
  if (product.stockQuantity <= LOW_STOCK_THRESHOLD) return "bajo";
  return "disponible";
}

export interface AiVisibility {
  visible: boolean;
  warning: string | null;
}

/**
 * Qué ve la IA de este producto.
 *
 * `buildCatalogTool` consulta con `.eq("is_active", true)`: desactivar un
 * repuesto lo saca del catálogo del modelo por completo. El stock, en
 * cambio, sí viaja al modelo — un repuesto activo en cero se le sigue
 * cotizando al cliente, con stock 0.
 *
 * Desde el 25/9/2026 un `is_active = false` ya no es una decisión que tomó
 * un asesor desde este panel: es lo que copió `saint.sync_products()` — el
 * producto desapareció de Saint, o Saint lo marcó `activo ≠ 1`. El aviso lo
 * dice así, no como "alguien lo desactivó acá".
 */
export function aiVisibility(product: Product): AiVisibility {
  if (!product.isActive) {
    return { visible: false, warning: "Ya no está en Saint: la IA no lo ofrece ni lo cotiza." };
  }
  if (product.stockQuantity <= 0) {
    return { visible: true, warning: "Sin stock: la IA lo sigue cotizando e informa 0 disponibles." };
  }
  return { visible: true, warning: null };
}

/**
 * Cuántos días se muestra el badge "Nuevo desde Saint" (decisión del
 * operador, 24/9/2026): lo que tarda un asesor en cargarle el peso a un
 * producto recién llegado del ERP.
 */
export const NEW_FROM_SAINT_DAYS = 7;

/**
 * Si este producto llegó de Saint hace poco (T2, plan "El inventario llega
 * de Saint y no se toca a mano", 25/9/2026). `saintAddedAt` es null para
 * cualquier producto que nunca se enlazó con Saint (los del seed local, por
 * ejemplo) — nunca es "nuevo" sin ese dato, aunque tampoco sea viejo.
 */
export function isNewFromSaint(
  product: Pick<Product, "saintAddedAt">,
  now: Date = new Date(),
  days = NEW_FROM_SAINT_DAYS
): boolean {
  if (!product.saintAddedAt) return false;
  const elapsedMs = now.getTime() - new Date(product.saintAddedAt).getTime();
  return elapsedMs < days * 24 * 60 * 60 * 1000;
}

/** Precio en bolívares a la tasa dada. Null si todavía no hay tasa que aplicar. */
export function priceInBs(product: Product, rate: number): number | null {
  if (product.currency === "VES") return product.price;
  if (!rate || rate <= 0) return null;
  return Number((product.price * rate).toFixed(2));
}

export interface PriceDisplay {
  /** La cifra grande de la fila. */
  principal: string;
  /** La línea chica en la otra moneda; `null` cuando no hay con qué convertir. */
  pie: string | null;
}

/**
 * Qué par de cifras pinta la fila de Inventario (19/9/2026, "El precio se
 * lee en bolívares"): el operador pidió el bolívar arriba y el dólar abajo,
 * al revés de lo que salió el 10/9/2026 (USD arriba, "Bs. …" chico). El
 * precio deja de editarse desde acá en la misma corrida (llega de fuera, a
 * `products`), así que este helper reemplaza a `parsePriceInput`/
 * `commitPrice` como única lógica de precio que queda en el componente.
 *
 * No se apoya solo en `priceInBs`: para un producto en VES esa función
 * devuelve el precio tal cual SIN mirar la tasa (ya está en bolívares), pero
 * acá hace falta saber si hay tasa de verdad para poder convertir el pie a
 * dólares — por eso la pregunta "¿hay tasa?" se hace antes, aparte.
 */
export function priceDisplay(product: Product, rate: number): PriceDisplay {
  const hayTasa = rate > 0;

  if (!hayTasa) {
    // Sin tasa no hay con qué convertir: se muestra la moneda real del
    // producto arriba y no se inventa un número en el pie.
    const simbolo = product.currency === "VES" ? "Bs." : "$";
    return { principal: `${simbolo} ${product.price.toFixed(2)}`, pie: null };
  }

  if (product.currency === "VES") {
    return { principal: `Bs. ${product.price.toFixed(2)}`, pie: `$ ${(product.price / rate).toFixed(2)}` };
  }

  const bs = priceInBs(product, rate) as number; // hayTasa garantiza que no da null acá
  return { principal: `Bs. ${bs.toFixed(2)}`, pie: `$ ${product.price.toFixed(2)}` };
}

// ---------------------------------------------------------------------------
// Validación de la edición en línea
//
// Se escribe directo sobre lo que la IA va a leer, así que el formulario no
// puede dejar pasar un peso con basura. El precio salió de este grupo el
// 19/9/2026 ("El precio se lee en bolívares"): ya no se edita desde acá, ver
// `priceDisplay` más arriba. El stock salió el 25/9/2026 ("El inventario
// llega de Saint y no se toca a mano"): `parseStockInput`/`updateProductStock`
// se borraron porque la base ya no deja escribir `stock_quantity` desde la
// app — Saint es el único dueño. El peso es el único campo que sigue
// editándose desde acá.
// ---------------------------------------------------------------------------

export type ParseResult<T = number> = { ok: true; value: T } | { ok: false; error: string };

/** Tope del peso: de sobra para cualquier repuesto de moto, y calza con `numeric(8,3)`. */
export const MAX_WEIGHT_KG = 9999.999;

/**
 * Peso en kilos que Cashea exige para el envío gratis (T4, 8/9/2026).
 *
 * A diferencia de stock, acá vacío es un valor válido: significa "todavía
 * sin cargar" (`value: null`), no un error. El resto de las reglas repiten
 * el patrón que tenía `parsePriceInput` (borrada el 19/9/2026, "El precio se
 * lee en bolívares": el precio dejó de editarse desde acá): coma o punto
 * decimal, sin negativos, con un tope de decimales — acá tres, porque un
 * tornillo puede pesar gramos.
 */
export function parseWeightInput(raw: string): ParseResult<number | null> {
  const text = raw.trim().replace(",", ".");
  if (!text) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,3})?$/.test(text)) {
    return { ok: false, error: "Usa un peso positivo en kilos, con hasta tres decimales." };
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "Ese peso no es un número." };
  if (value > MAX_WEIGHT_KG) return { ok: false, error: `Ese peso es demasiado grande (máximo ${MAX_WEIGHT_KG} kg).` };
  return { ok: true, value };
}

/** El borrador del campo: vacío si no hay peso cargado, si no con los 3 decimales fijos. */
export function formatWeightInput(weightKg: number | null): string {
  return weightKg === null ? "" : weightKg.toFixed(3);
}

// ---------------------------------------------------------------------------
// Resumen de la página visible
// ---------------------------------------------------------------------------

export interface InventorySummary {
  total: number;
  /** Cuántos ve la IA ahora mismo. */
  activos: number;
  agotados: number;
  bajos: number;
  /** Activos sin peso cargado — lo que Cashea necesita para calcular el envío gratis. */
  withoutWeight: number;
  valorUsd: number;
  hasNonUsdPrices: boolean;
}

export function summarizeInventory(products: Product[]): InventorySummary {
  let activos = 0;
  let agotados = 0;
  let bajos = 0;
  let withoutWeight = 0;
  let valorUsd = 0;
  let hasNonUsdPrices = false;

  for (const product of products) {
    if (product.currency !== "USD") hasNonUsdPrices = true;
    else valorUsd += product.price * Math.max(0, product.stockQuantity);

    // Un producto desactivado no entra en las cuentas de disponibilidad: no
    // existe para la IA, así que no es un agotado que haya que reponer.
    if (!product.isActive) continue;
    activos += 1;

    const level = stockLevel(product);
    if (level === "agotado") agotados += 1;
    if (level === "bajo") bajos += 1;
    if (product.weightKg === null) withoutWeight += 1;
  }

  return {
    total: products.length,
    activos,
    agotados,
    bajos,
    withoutWeight,
    valorUsd: Number(valorUsd.toFixed(2)),
    hasNonUsdPrices,
  };
}

// ---------------------------------------------------------------------------
// Estado de la lista, leído de la URL
// ---------------------------------------------------------------------------

export type InventoryFilter = "todos" | "agotados" | "bajo-stock" | "inactivos" | "sin-peso";
export type InventorySort = "nombre" | "stock" | "precio";

const FILTERS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos", "sin-peso"];
const SORTS: InventorySort[] = ["nombre", "stock", "precio"];

/**
 * `inactivos` pasó de "Desactivados" a "Fuera de Saint" el 25/9/2026 ("El
 * inventario llega de Saint y no se toca a mano"): un `is_active = false` ya
 * no es una decisión que tomó un asesor desde este panel, es lo que copió
 * `saint.sync_products()` — el producto desapareció de la fuente, o Saint lo
 * marcó `activo ≠ 1`. "Desactivados" sugería una acción manual que ya no
 * existe acá.
 */
export const INVENTORY_FILTER_LABELS: Record<InventoryFilter, string> = {
  todos: "Todos",
  agotados: "Agotados",
  "bajo-stock": "Bajo stock",
  inactivos: "Fuera de Saint",
  "sin-peso": "Sin peso",
};

export const INVENTORY_SORT_LABELS: Record<InventorySort, string> = {
  nombre: "Por nombre",
  stock: "Menos stock primero",
  precio: "Más caros primero",
};

export const INVENTORY_PAGE_SIZE = 40;

export interface InventoryParams {
  query: string;
  filter: InventoryFilter;
  sort: InventorySort;
  page: number;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseInventoryParams(raw: RawParams): InventoryParams {
  const filter = first(raw.filtro);
  const sort = first(raw.orden);
  const page = Number(first(raw.page));

  return {
    query: (first(raw.q) ?? "").trim(),
    filter: FILTERS.includes(filter as InventoryFilter) ? (filter as InventoryFilter) : "todos",
    sort: SORTS.includes(sort as InventorySort) ? (sort as InventorySort) : "nombre",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function inventoryHref({ query, filter, sort, page }: InventoryParams): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filter !== "todos") params.set("filtro", filter);
  if (sort !== "nombre") params.set("orden", sort);
  if (page > 1) params.set("page", String(page));

  const qs = params.toString();
  return qs ? `/inventario?${qs}` : "/inventario";
}

export function inventoryPageRange(page: number, size: number = INVENTORY_PAGE_SIZE): { from: number; to: number } {
  const from = (page - 1) * size;
  return { from, to: from + size - 1 };
}

export function inventoryTotalPages(count: number, size: number = INVENTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(count / size));
}
