import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRef, Invoice, InvoiceCustomerSnapshot, InvoiceItem, InvoiceStatus } from "@/lib/types";

/**
 * Consultas de Facturas (T5, plan "Seis frentes del buzón", 8/9/2026).
 *
 * Vive aparte de `data.ts` por el mismo motivo que `customers-data.ts`: gira
 * alrededor de un objeto propio —la factura, que es un snapshot congelado—
 * no del hilo de conversación. `mapInvoice`/`INVOICE_SELECT` se exportan
 * para que `mutations.ts` los reuse al devolver la factura recién insertada
 * o actualizada, en vez de volver a pedirla.
 */

export const INVOICE_SELECT = `
  id, number, conversation_id, order_id, contact_id, customer, items,
  subtotal, tax_rate, tax_amount, total, currency, bcv_rate, status,
  issued_at, voided_at, notes, created_at, updated_at,
  issued_by:agents!invoices_issued_by_fkey(id, display_name)
`;

interface RawIssuedBy {
  id: string;
  display_name: string;
}

export interface RawInvoice {
  id: string;
  number: number;
  conversation_id: string | null;
  order_id: string | null;
  contact_id: string;
  customer: InvoiceCustomerSnapshot;
  items: InvoiceItem[];
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  currency: Invoice["currency"];
  bcv_rate: number | string | null;
  status: InvoiceStatus;
  issued_at: string | null;
  voided_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  issued_by: RawIssuedBy | null;
}

function mapIssuedBy(row: RawIssuedBy | null): AgentRef | null {
  return row ? { id: row.id, displayName: row.display_name } : null;
}

/**
 * `subtotal`/`tax_amount`/`total`/`bcv_rate` viajan como `numeric` de
 * Postgres: PostgREST los sirve como string cuando pierden precisión de
 * `number` de JS, así que se pasan por `Number()` igual que hace `mapSale`
 * con `order.total_amount`.
 */
export function mapInvoice(row: RawInvoice): Invoice {
  return {
    id: row.id,
    number: Number(row.number),
    conversationId: row.conversation_id,
    orderId: row.order_id,
    contactId: row.contact_id,
    customer: row.customer,
    items: row.items,
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    total: Number(row.total),
    currency: row.currency,
    bcvRate: row.bcv_rate === null ? null : Number(row.bcv_rate),
    status: row.status,
    issuedAt: row.issued_at,
    issuedBy: mapIssuedBy(row.issued_by),
    voidedAt: row.voided_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Las facturas de una venta, más reciente primero (una venta anulada y refacturada puede tener más de una). */
export async function fetchInvoicesForSale(supabase: SupabaseClient, conversationId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return ((data ?? []) as unknown as RawInvoice[]).map(mapInvoice);
}

/** Una factura por id, para la hoja imprimible. Null si no existe (la página responde 404). */
export async function fetchInvoice(supabase: SupabaseClient, id: string): Promise<Invoice | null> {
  const { data, error } = await supabase.from("invoices").select(INVOICE_SELECT).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return mapInvoice(data as unknown as RawInvoice);
}

interface RawOrderItem {
  description: string;
  quantity: number;
  unit_price: number | string;
}

export interface OrderItemForInvoice {
  description: string;
  quantity: number;
  unitPrice: number;
}

/** Los renglones de una orden, en la forma mínima que necesita `buildInvoiceDraft` (src/lib/invoices.ts). */
export async function fetchOrderItems(supabase: SupabaseClient, orderId: string): Promise<OrderItemForInvoice[]> {
  const { data, error } = await supabase
    .from("order_items")
    .select("description, quantity, unit_price")
    .eq("order_id", orderId);
  if (error) throw error;

  return ((data ?? []) as unknown as RawOrderItem[]).map((row) => ({
    description: row.description,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price),
  }));
}
