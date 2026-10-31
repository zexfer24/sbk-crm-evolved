import type { SupabaseClient } from "@supabase/supabase-js";
import { assertRowsAffected } from "@/lib/config-write";
import { mapProduct, PRODUCT_SELECT, type RawProduct } from "@/lib/inventory-data";
import {
  validarDatosPresupuesto,
  type ItemParaGuardar,
  type Presupuesto,
  type PresupuestoItem,
} from "@/lib/presupuestos";

/**
 * Lectura y escritura de los presupuestos guardados (21/10/2026, plan
 * "Presupuestos y mensajes rápidos", T3; migración `20261021010000`). Corre en
 * el navegador: los errores se relanzan para que el llamador muestre el toast,
 * nunca se usa `lib/log.ts`.
 *
 * Los permisos viven en la RLS, no aquí: ve todo el equipo (la caja también),
 * y solo el autor o un supervisor/admin cambia o borra. Un UPDATE/DELETE que
 * la política ignora afecta 0 filas SIN error (CLAUDE.md, 28/9/2026), por eso
 * cada borrado pide `.select("id")` y la RPC convierte su UPDATE vacío en
 * `42501`.
 */

export const PRESUPUESTO_AJENO_MESSAGE = "Solo quien guardó este presupuesto o un supervisor puede cambiarlo.";
export const PRESUPUESTO_NO_ENCONTRADO_MESSAGE = "Este presupuesto ya no existe o no es tuyo.";

/** Postgres `insufficient_privilege`: lo que `guardar_presupuesto` lanza si el presupuesto es ajeno o ya no existe. */
const CODIGO_SIN_PERMISO = "42501";

/** Más que de sobra para la lista; el buscador filtra en memoria sobre estos. */
const LIMITE_PRESUPUESTOS = 200;

interface RawPresupuestoItem {
  id: string;
  product_id: string;
  quantity: number;
  price_kind: string;
  precio_cotizado_usd: number | string | null;
  created_at: string;
  product: RawProduct;
}

interface RawPresupuesto {
  id: string;
  cliente_nombre: string;
  cliente_apellido: string;
  contact_id: string | null;
  conversation_id: string | null;
  origen: string;
  nota: string | null;
  total_cotizado_usd: number | string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  creador: { full_name: string | null; display_name: string | null } | null;
  items: RawPresupuestoItem[] | null;
}

function numeroONull(valor: number | string | null): number | null {
  return valor === null ? null : Number(valor);
}

function mapItem(row: RawPresupuestoItem, supabase: SupabaseClient): PresupuestoItem {
  return {
    id: row.id,
    productId: row.product_id,
    product: mapProduct(row.product, supabase),
    quantity: row.quantity,
    // Defensivo: solo "estandar" cobra el envío; cualquier otra cosa es promoción.
    priceKind: row.price_kind === "estandar" ? "estandar" : "promocion",
    precioCotizadoUsd: numeroONull(row.precio_cotizado_usd),
  };
}

function mapPresupuesto(row: RawPresupuesto, supabase: SupabaseClient): Presupuesto {
  // La base no garantiza el orden del embed: por fecha de alta y, como los
  // renglones de un mismo guardado comparten `created_at`, el id desempata.
  const items = [...(row.items ?? [])].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return {
    id: row.id,
    clienteNombre: row.cliente_nombre,
    clienteApellido: row.cliente_apellido,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    origen: row.origen === "chat" ? "chat" : "inventario",
    nota: row.nota,
    totalCotizadoUsd: numeroONull(row.total_cotizado_usd),
    createdBy: row.created_by,
    creadoPorNombre: row.creador?.full_name ?? row.creador?.display_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => mapItem(item, supabase)),
  };
}

/**
 * Los presupuestos del equipo, el más recién cambiado primero. Con `contactId`
 * solo los de ese cliente (el panel del chat).
 */
export async function fetchPresupuestos(
  supabase: SupabaseClient,
  opciones: { contactId?: string } = {},
): Promise<Presupuesto[]> {
  let consulta = supabase.from("presupuestos").select(
    `id, cliente_nombre, cliente_apellido, contact_id, conversation_id, origen, nota, total_cotizado_usd,
     created_by, created_at, updated_at,
     creador:agents!presupuestos_created_by_fkey(full_name, display_name),
     items:presupuesto_items(id, product_id, quantity, price_kind, precio_cotizado_usd, created_at,
       product:products(${PRODUCT_SELECT}))`,
  );
  if (opciones.contactId) consulta = consulta.eq("contact_id", opciones.contactId);

  const { data, error } = await consulta.order("updated_at", { ascending: false }).limit(LIMITE_PRESUPUESTOS);
  if (error) throw error;
  return ((data ?? []) as unknown as RawPresupuesto[]).map((row) => mapPresupuesto(row, supabase));
}

export interface GuardarPresupuestoInput {
  /** `null` crea uno nuevo; con id REEMPLAZA el nombre, la nota y los renglones del existente. */
  id: string | null;
  clienteNombre: string;
  clienteApellido: string;
  contactId: string | null;
  conversationId: string | null;
  origen: "inventario" | "chat";
  nota: string | null;
  items: ItemParaGuardar[];
}

/**
 * Guarda (o reemplaza) un presupuesto y sus renglones en UNA llamada atómica
 * (`guardar_presupuesto`). Valida antes de tocar la base y devuelve el id.
 */
export async function guardarPresupuesto(supabase: SupabaseClient, input: GuardarPresupuestoInput): Promise<string> {
  const nombre = input.clienteNombre.trim();
  const apellido = input.clienteApellido.trim();
  const nota = (input.nota ?? "").trim();

  const errores = validarDatosPresupuesto({ nombre, apellido, nota });
  const primerError = errores.nombre ?? errores.apellido ?? errores.nota;
  if (primerError) throw new Error(primerError);
  if (input.items.length === 0) throw new Error("El presupuesto no tiene artículos.");

  const { data, error } = await supabase.rpc("guardar_presupuesto", {
    p_id: input.id,
    p_cliente_nombre: nombre,
    p_cliente_apellido: apellido,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId,
    p_origen: input.origen,
    p_nota: nota === "" ? null : nota,
    p_items: input.items,
  });
  if (error) {
    if (error.code === CODIGO_SIN_PERMISO) throw new Error(PRESUPUESTO_AJENO_MESSAGE);
    throw error;
  }
  return data as string;
}

/** Borra un presupuesto (sus renglones caen por `on delete cascade`). Lanza si la RLS lo ignoró o ya no existe. */
export async function borrarPresupuesto(supabase: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await supabase.from("presupuestos").delete().eq("id", id).select("id");
  if (error) throw error;
  assertRowsAffected(data, PRESUPUESTO_NO_ENCONTRADO_MESSAGE);
}

/**
 * «Borrar todos mis presupuestos» (D3): solo los del asesor, filtrado por
 * `created_by` del lado del cliente — un supervisor igual podría borrar los
 * ajenos uno por uno, pero este botón nunca los toca. Devuelve cuántos; cero
 * es válido (no tenía ninguno) y no lanza.
 */
export async function borrarMisPresupuestos(supabase: SupabaseClient, agentId: string): Promise<number> {
  const { data, error } = await supabase.from("presupuestos").delete().eq("created_by", agentId).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
