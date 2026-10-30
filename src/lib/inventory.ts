import type { Product } from "@/lib/types";
import { usdFromBs } from "@/lib/usd-price";

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
 *
 * El pie en dólares de un producto en VES pasa por `usdFromBs` (27/9/2026,
 * plan "El mostrador busca sin salir del chat", D1): antes se dividía y se
 * redondeaba al centavo más cercano con `toFixed(2)`, a veces para abajo.
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
    // `hayTasa` garantiza rate > 0, así que `usdFromBs` no da null acá.
    const usd = usdFromBs(product.price, rate) as number;
    return { principal: `Bs. ${product.price.toFixed(2)}`, pie: `$ ${usd.toFixed(2)}` };
  }

  const bs = priceInBs(product, rate) as number; // hayTasa garantiza que no da null acá
  return { principal: `Bs. ${bs.toFixed(2)}`, pie: `$ ${product.price.toFixed(2)}` };
}

/** Texto cuando SAINT no trae precio divisa (nunca un `$ 0.00`). */
export const TEXTO_SIN_PRECIO_SAINT = "Sin precio en SAINT";

/** Qué pinta la fila / el buscador para el "precio divisa" (Precio1 de SAINT, en USD). */
export type PrecioDivisaDisplay = { estado: "ok"; principal: string } | { estado: "sin_precio" };

/**
 * Precio divisa = `Precio1` de SAINT (30/10/2026, plan "Precio divisa desde
 * SAINT"). Ya viene en dólares, así que NO pasa por `usdFromBs` ni por la tasa
 * BCV. Solo informativo. `null`, no finito, 0 o negativo no son un precio real
 * (SAINT guarda 0 donde no hay dato): "sin_precio", nunca "$ 0.00". Mismo
 * formato "$ 12.35" que el pie de `priceDisplay`.
 */
export function precioDivisaDisplay(product: Pick<Product, "precioDivisaUsd">): PrecioDivisaDisplay {
  const v = product.precioDivisaUsd;
  if (v === null || !Number.isFinite(v) || v <= 0) return { estado: "sin_precio" };
  return { estado: "ok", principal: `$ ${round2(v).toFixed(2)}` };
}

/** Qué pinta la fila para el "precio estándar" (promoción + envío MRW). */
export type StandardPriceDisplay =
  | { estado: "ok"; principal: string; pie: string | null; tarifa: string }
  | { estado: "sin_peso" | "fuera_de_tabla" | "sin_tarifa" };

/** Peso desde el cual la tabla MRW no tiene tarifa (kg). Solo clasifica el motivo; la tarifa la pone la base. */
const PESO_FUERA_DE_TABLA_KG = 80;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Precio estándar = precio promoción (`price`) + tarifa de envío MRW
 * (12/10/2026, plan "Precio promoción y precio estándar (envío MRW)").
 *
 * La tarifa (`shippingFeeUsd`) viene calculada de la base; acá solo se suma,
 * la tabla de rangos no se duplica en TypeScript. Sin tarifa nunca se
 * inventa un número: se devuelve el motivo (sin peso, fuera de la tabla o
 * sin rango) para que la fila diga qué falta.
 *
 * El dólar de un producto en VES pasa por `usdFromBs`, igual que
 * `priceDisplay` (regla del CLAUDE.md: la conversión Bs -> USD vive en una
 * sola función). Se redondea la suma a centavos para quitar el ruido de coma
 * flotante (2,2 + 1,35 = 3,5500000000000003). Sin tasa no se suman monedas
 * distintas: un producto en VES muestra su precio en bolívares y el envío
 * aparte en dólares.
 */
/**
 * ¿Le falta el peso a este repuesto? (12/10/2026) Un peso guardado en 0 es
 * tan "sin cargar" como null: el formulario lo acepta, pero no hay tarifa MRW
 * para 0 kg y por lo tanto tampoco precio estándar. El badge "Sin peso" y
 * `standardPriceDisplay` usan esta función; el filtro y el contador de la base
 * usan la misma regla con `SIN_PESO_FILTRO` (`inventory-data.ts`).
 */
export function sinPeso(weightKg: number | null): boolean {
  return weightKg === null || weightKg <= 0;
}

/**
 * Por qué no hay precio estándar (12/10/2026): nunca un número incompleto.
 * `sin_peso` NO está acá desde el 13/10/2026: para quien puede editar es un
 * botón que lleva al campo de peso, y para caja es un dato («Sin peso
 * cargado»); los otros dos motivos no tienen acción posible desde la fila.
 * Desde el 14/10/2026 la comparten la fila de Inventario y la búsqueda del
 * chat (`inventory-lookup.tsx`), para que el motivo se lea igual en las dos.
 */
export const MOTIVO_SIN_ESTANDAR = {
  fuera_de_tabla: "Más de 80 kg: fuera de la tabla MRW",
  sin_tarifa: "Sin tarifa MRW para este peso",
} as const;

/**
 * Los números del precio estándar, sin formato (14/10/2026): promoción +
 * tarifa MRW, en dólares y en bolívares. Es la ÚNICA aritmética del estándar:
 * la usan la fila de Inventario y la búsqueda del chat (`standardPriceDisplay`,
 * que solo le da formato) y el carrito del chat (`priceCartLines`, que cobra
 * con estos números). Antes la suma vivía dentro de `standardPriceDisplay`
 * como texto; para cobrarla hacía falta el número, y duplicarla habría dejado
 * dos sumas que se pueden separar.
 *
 * `null` si el producto no tiene tarifa (nunca un número incompleto). Cada
 * monto es `null` cuando no se puede expresar sin mezclar monedas: sin tasa,
 * un producto en VES no tiene dólar ni bolívares estándar (el envío es en
 * dólares y el precio en bolívares), y uno en USD no tiene bolívares.
 */
export function standardPriceAmounts(
  product: Product,
  rate: number
): { usd: number | null; bs: number | null } | null {
  const fee = product.shippingFeeUsd;
  if (fee === null) return null;

  if (!(rate > 0)) {
    if (product.currency === "VES") return { usd: null, bs: null };
    return { usd: round2(product.price + fee), bs: null };
  }

  if (product.currency === "VES") {
    // `rate > 0` garantiza que `usdFromBs` no da null acá.
    const usd = round2((usdFromBs(product.price, rate) as number) + fee);
    const bs = product.price + round2(fee * rate);
    return { usd, bs };
  }

  const usd = round2(product.price + fee);
  return { usd, bs: round2(usd * rate) };
}

/**
 * El motivo en texto de un estándar que no se puede calcular (14/10/2026): lo
 * leen la búsqueda del chat y el carrito de la conversación, para que el
 * botón «Estándar» deshabilitado diga lo mismo que dice la fila de Inventario.
 */
export function motivoSinEstandar(estado: "sin_peso" | "fuera_de_tabla" | "sin_tarifa"): string {
  return estado === "sin_peso" ? "Sin peso cargado" : MOTIVO_SIN_ESTANDAR[estado];
}

export function standardPriceDisplay(product: Product, rate: number): StandardPriceDisplay {
  const fee = product.shippingFeeUsd;
  if (fee === null) {
    const peso = product.weightKg;
    if (peso === null || sinPeso(peso)) return { estado: "sin_peso" };
    if (peso >= PESO_FUERA_DE_TABLA_KG) return { estado: "fuera_de_tabla" };
    return { estado: "sin_tarifa" };
  }

  const tarifa = `$ ${fee.toFixed(2)}`;
  const amounts = standardPriceAmounts(product, rate) as { usd: number | null; bs: number | null };

  if (amounts.usd === null) {
    // Sin tasa y en bolívares: no se suman monedas distintas.
    return {
      estado: "ok",
      principal: `Bs. ${product.price.toFixed(2)}`,
      pie: `+ $ ${fee.toFixed(2)} envío`,
      tarifa,
    };
  }

  if (amounts.bs === null) {
    // Sin tasa y en dólares: la suma es en dólares y no hay equivalente en bolívares.
    return { estado: "ok", principal: `$ ${amounts.usd.toFixed(2)}`, pie: null, tarifa };
  }

  return { estado: "ok", principal: `Bs. ${amounts.bs.toFixed(2)}`, pie: `$ ${amounts.usd.toFixed(2)}`, tarifa };
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
/**
 * `existencia` (13/10/2026, plan "Inventario y caja", T4) es el orden POR
 * DEFECTO del filtro «Sin peso» —lo que más hay en el mostrador primero—, no
 * una píldora más: ningún botón de la barra de orden lo ofrece. Se eligió un
 * valor nuevo del orden, con default por filtro (`ordenPorDefecto`), en lugar
 * de un `sortExplicit` aparte: así `params.sort` siempre dice cómo se ordena
 * la lista y `fetchProductsPage` no necesita saber de dónde salió.
 */
export type InventorySort = "nombre" | "stock" | "precio" | "existencia";

const FILTERS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos", "sin-peso"];
const SORTS: InventorySort[] = ["nombre", "stock", "precio", "existencia"];

/**
 * El orden que rige cuando la URL no trae `orden`: «Sin peso» abre por
 * existencia (de mayor a menor), los demás filtros por nombre. Un orden
 * escrito en la URL —incluido «nombre»— siempre gana.
 */
export function ordenPorDefecto(filter: InventoryFilter): InventorySort {
  return filter === "sin-peso" ? "existencia" : "nombre";
}

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
  existencia: "Más existencia primero",
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
  const rawFilter = first(raw.filtro);
  const sort = first(raw.orden);
  const page = Number(first(raw.page));
  const filter = FILTERS.includes(rawFilter as InventoryFilter) ? (rawFilter as InventoryFilter) : "todos";

  return {
    query: (first(raw.q) ?? "").trim(),
    filter,
    sort: SORTS.includes(sort as InventorySort) ? (sort as InventorySort) : ordenPorDefecto(filter),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * La URL omite el orden solo cuando es el default DEL FILTRO. Por eso bajo
 * «Sin peso» el orden «nombre» sí se escribe (`orden=nombre`): si se omitiera,
 * `parseInventoryParams` lo leería de vuelta como «existencia» y la píldora
 * «Por nombre» no haría nada.
 */
export function inventoryHref({ query, filter, sort, page }: InventoryParams): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filter !== "todos") params.set("filtro", filter);
  if (sort !== ordenPorDefecto(filter)) params.set("orden", sort);
  if (page > 1) params.set("page", String(page));

  const qs = params.toString();
  return qs ? `/inventario?${qs}` : "/inventario";
}

/**
 * Enlace de una píldora de filtro: cambia el filtro, reinicia la página y NO
 * arrastra el orden por defecto del filtro anterior. Sin esto, pasar de
 * «Sin peso» (orden implícito: existencia) a «Todos» escribiría
 * `orden=existencia`, y pasar de «Todos» (nombre implícito) a «Sin peso»
 * escribiría `orden=nombre`, que apagaría el default nuevo. Un orden que el
 * asesor eligió a mano (cualquiera distinto del default del filtro actual)
 * sí sobrevive al cambio.
 */
export function inventoryFilterHref(params: InventoryParams, filter: InventoryFilter): string {
  const elegidoAMano = params.sort !== ordenPorDefecto(params.filter);
  return inventoryHref({
    ...params,
    filter,
    sort: elegidoAMano ? params.sort : ordenPorDefecto(filter),
    page: 1,
  });
}

export function inventoryPageRange(page: number, size: number = INVENTORY_PAGE_SIZE): { from: number; to: number } {
  const from = (page - 1) * size;
  return { from, to: from + size - 1 };
}

export function inventoryTotalPages(count: number, size: number = INVENTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(count / size));
}

/**
 * A qué página hay que redirigir cuando la pedida no existe, o `null` si está
 * bien (13/10/2026). Un enlace viejo, o un filtro que acorta la lista, dejaba
 * `?page=` más allá de la última página: PostgREST contestaba 416 y la pantalla
 * reventaba. Con resultados manda a la última página; sin resultados, a la 1.
 */
export function paginaFueraDeRango(page: number, total: number): number | null {
  if (total <= 0) return page > 1 ? 1 : null;
  const ultima = inventoryTotalPages(total);
  return page > ultima ? ultima : null;
}
