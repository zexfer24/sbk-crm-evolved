import type { SupabaseClient } from "@supabase/supabase-js";
import type { MotoCatalogSummary, Product, ProductCurrency } from "@/lib/types";
import { orExpression, pgrstLiteral } from "@/lib/ai/pgrst";
import { inventoryPageRange, LOW_STOCK_THRESHOLD, type InventoryParams } from "@/lib/inventory";

/**
 * Consultas de la sección Inventario.
 *
 * Leen la misma tabla `products` que la herramienta de catálogo del agente
 * (`buildCatalogTool`). No hay copia ni caché en el medio: guardar un stock
 * acá cambia lo que la IA cotiza en el siguiente mensaje del cliente.
 */

const PRODUCT_SELECT = `
  id, name, brand, price, currency, stock_quantity, description,
  is_active, updated_at,
  product_compatibility(id, moto_brand, moto_model)
`;

interface RawProduct {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  currency: ProductCurrency;
  stock_quantity: number;
  description: string | null;
  is_active: boolean;
  updated_at: string;
  product_compatibility: { id: string; moto_brand: string; moto_model: string }[] | null;
}

function mapProduct(row: RawProduct): Product {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    price: Number(row.price),
    currency: row.currency,
    stockQuantity: row.stock_quantity,
    description: row.description,
    isActive: row.is_active,
    updatedAt: row.updated_at,
    compatibility: (row.product_compatibility ?? []).map((c) => ({
      id: c.id,
      motoBrand: c.moto_brand,
      motoModel: c.moto_model,
    })),
  };
}

export interface ProductsPage {
  products: Product[];
  total: number;
}

export async function fetchProductsPage(
  supabase: SupabaseClient,
  { query, filter, sort, page }: InventoryParams
): Promise<ProductsPage> {
  let request = supabase.from("products").select(PRODUCT_SELECT, { count: "exact" });

  if (query) {
    // Mismo escapado que usa la herramienta del agente: el filtro `.or()`
    // es un mini-lenguaje y el texto lo escribe una persona.
    const term = pgrstLiteral(`%${query}%`);
    const expression = orExpression([[`name.ilike.${term}`, `brand.ilike.${term}`, `description.ilike.${term}`]]);
    request = request.or(expression);
  }

  // Los cortes de disponibilidad solo tienen sentido sobre lo que la IA ve:
  // un repuesto desactivado no es un agotado por reponer, es uno retirado.
  if (filter === "agotados") {
    request = request.eq("is_active", true).lte("stock_quantity", 0);
  } else if (filter === "bajo-stock") {
    request = request.eq("is_active", true).gt("stock_quantity", 0).lte("stock_quantity", LOW_STOCK_THRESHOLD);
  } else if (filter === "inactivos") {
    request = request.eq("is_active", false);
  }

  if (sort === "stock") request = request.order("stock_quantity", { ascending: true });
  else if (sort === "precio") request = request.order("price", { ascending: false });
  else request = request.order("name", { ascending: true });

  const { from, to } = inventoryPageRange(page);
  const { data, error, count } = await request.range(from, to);
  if (error) throw error;

  const products = ((data ?? []) as unknown as RawProduct[]).map(mapProduct);
  return { products, total: count ?? products.length };
}

export async function fetchProduct(supabase: SupabaseClient, productId: string): Promise<Product | null> {
  const { data, error } = await supabase.from("products").select(PRODUCT_SELECT).eq("id", productId).maybeSingle();
  if (error) throw error;
  return data ? mapProduct(data as unknown as RawProduct) : null;
}

/**
 * Contadores globales del inventario, calculados en la base.
 *
 * Se piden con `head: true`: PostgREST devuelve solo el conteo, sin traer
 * una sola fila. Son cifras del catálogo entero, no de la página visible.
 */
export interface InventoryTotals {
  productos: number;
  activos: number;
  agotados: number;
  bajos: number;
}

export async function fetchInventoryTotals(supabase: SupabaseClient): Promise<InventoryTotals> {
  const countOnly = () => supabase.from("products").select("id", { count: "exact", head: true });

  const [productos, activos, agotados, bajos] = await Promise.all([
    countOnly(),
    countOnly().eq("is_active", true),
    countOnly().eq("is_active", true).lte("stock_quantity", 0),
    countOnly().eq("is_active", true).gt("stock_quantity", 0).lte("stock_quantity", LOW_STOCK_THRESHOLD),
  ]);

  for (const result of [productos, activos, agotados, bajos]) {
    if (result.error) throw result.error;
  }

  return {
    productos: productos.count ?? 0,
    activos: activos.count ?? 0,
    agotados: agotados.count ?? 0,
    bajos: bajos.count ?? 0,
  };
}

/**
 * Tamaño del catálogo clon de motos.
 *
 * Estas tablas se importan del ERP y no se editan desde el CRM. Se muestran
 * para que se vea de un vistazo con cuánto cuenta la IA para resolver
 * compatibilidades y jerga venezolana ("el pañal", "la corona").
 */
export async function fetchMotoCatalogSummary(supabase: SupabaseClient): Promise<MotoCatalogSummary> {
  async function count(table: string): Promise<number> {
    const { count: rows, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    // Si el catálogo clon todavía no está cargado en este entorno, la
    // sección debe abrir igual mostrando ceros, no reventar.
    if (error) return 0;
    return rows ?? 0;
  }

  const [engineFamilies, commercialModels, modelEngineLinks, motorRules, modelRules, searchSynonyms] =
    await Promise.all([
      count("familias_motor"),
      count("modelos_comerciales"),
      count("modelo_motor_nexo"),
      count("repuesto_compatibilidad_motor"),
      count("repuesto_compatibilidad_modelo"),
      count("sinonimos_busqueda"),
    ]);

  return {
    engineFamilies,
    commercialModels,
    modelEngineLinks,
    compatibilityRules: motorRules + modelRules,
    searchSynonyms,
  };
}

/**
 * Repuestos activos que coinciden con lo que teclea el asesor.
 *
 * Lo usa el buscador del cierre de venta. Solo trae activos porque son los
 * que la empresa está vendiendo hoy: un repuesto retirado del catálogo no
 * debería poder colarse en una venta nueva.
 */
export async function searchActiveProducts(
  supabase: SupabaseClient,
  query: string,
  limit = 8
): Promise<Product[]> {
  const text = query.trim();
  if (!text) return [];

  const term = pgrstLiteral(`%${text}%`);
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .or(orExpression([[`name.ilike.${term}`, `brand.ilike.${term}`]]))
    .order("name", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as unknown as RawProduct[]).map(mapProduct);
}
