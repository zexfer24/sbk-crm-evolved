import type { Product } from "@/lib/types";

/**
 * Lógica pura de la sección Inventario.
 *
 * El punto de esta sección es que lo que se ve acá es exactamente lo que la
 * herramienta de catálogo de la IA lee en el próximo turno: misma tabla
 * (`products`), sin copia intermedia ni sincronización. Por eso las reglas
 * de visibilidad de abajo replican las de `buildCatalogTool`.
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
 */
export function aiVisibility(product: Product): AiVisibility {
  if (!product.isActive) {
    return { visible: false, warning: "Desactivado: la IA no lo ofrece ni lo cotiza." };
  }
  if (product.stockQuantity <= 0) {
    return { visible: true, warning: "Sin stock: la IA lo sigue cotizando e informa 0 disponibles." };
  }
  return { visible: true, warning: null };
}

/** Precio en bolívares a la tasa dada. Null si todavía no hay tasa que aplicar. */
export function priceInBs(product: Product, rate: number): number | null {
  if (product.currency === "VES") return product.price;
  if (!rate || rate <= 0) return null;
  return Number((product.price * rate).toFixed(2));
}

// ---------------------------------------------------------------------------
// Validación de la edición en línea
//
// Se escribe directo sobre lo que la IA va a leer, así que el formulario no
// puede dejar pasar un stock negativo ni un precio con basura.
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

export function parseStockInput(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Escribe cuántas unidades hay." };
  if (!/^\d+$/.test(text)) return { ok: false, error: "El stock son unidades enteras, sin decimales ni signos." };

  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { ok: false, error: "Ese número es demasiado grande." };
  return { ok: true, value };
}

export function parsePriceInput(raw: string): ParseResult {
  // Acá el precio se escribe con coma: "25,50". La base guarda punto.
  const text = raw.trim().replace(",", ".");
  if (!text) return { ok: false, error: "Escribe el precio." };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: "Usa un precio positivo con hasta dos decimales." };
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "Ese precio no es un número." };
  return { ok: true, value };
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
  valorUsd: number;
  hasNonUsdPrices: boolean;
}

export function summarizeInventory(products: Product[]): InventorySummary {
  let activos = 0;
  let agotados = 0;
  let bajos = 0;
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
  }

  return { total: products.length, activos, agotados, bajos, valorUsd: Number(valorUsd.toFixed(2)), hasNonUsdPrices };
}

// ---------------------------------------------------------------------------
// Estado de la lista, leído de la URL
// ---------------------------------------------------------------------------

export type InventoryFilter = "todos" | "agotados" | "bajo-stock" | "inactivos";
export type InventorySort = "nombre" | "stock" | "precio";

const FILTERS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos"];
const SORTS: InventorySort[] = ["nombre", "stock", "precio"];

export const INVENTORY_FILTER_LABELS: Record<InventoryFilter, string> = {
  todos: "Todos",
  agotados: "Agotados",
  "bajo-stock": "Bajo stock",
  inactivos: "Desactivados",
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
