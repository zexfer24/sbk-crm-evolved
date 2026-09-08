import type { Contact, InvoiceCustomerSnapshot, InvoiceItem, InvoiceStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Las bases de la factura (T5, plan "Seis frentes del buzón", 8/9/2026).
//
// Módulo puro a propósito —sin `SupabaseClient` de por medio— para poder
// probar el cálculo de totales y el armado del snapshot sin levantar nada.
// `src/lib/invoices-data.ts` lee de la base; `src/lib/mutations.ts` escribe.
// ---------------------------------------------------------------------------

/** "SBK-000001", "SBK-123456": el correlativo con ceros a la izquierda que ve el cliente. */
export function formatInvoiceNumber(number: number): string {
  return `SBK-${String(number).padStart(6, "0")}`;
}

/**
 * Datos del emisor para el encabezado de la hoja. RIF, dirección, teléfono y
 * ciudad quedan en null: son datos fiscales que el operador todavía no
 * decidió (serie, si aplica IVA, RIF exacto). `invoice-sheet.tsx` los pinta
 * como "Por definir" mientras sigan siendo null —nunca se inventa un dato
 * fiscal para que la hoja "se vea completa".
 */
export const INVOICE_ISSUER: {
  name: string;
  rif: string | null;
  address: string | null;
  phone: string | null;
  city: string | null;
} = {
  name: "SBK Motorcycles",
  rif: null,
  address: null,
  phone: null,
  city: null,
};

/** IVA pendiente de decisión del operador: 0 hasta que la defina. */
export const DEFAULT_TAX_RATE = 0;

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Borrador",
  issued: "Emitida",
  void: "Anulada",
};

// ---------------------------------------------------------------------------
// Totales, redondeados a centavos.
//
// Sumar en USD de coma flotante deja totales como 1.0049999999999999 (caso
// real: tres renglones de $0.335 cada uno — 0.335 * 3 en JS no da 1.005).
// La corrección: cada renglón se redondea a SU PROPIO centavo antes de
// sumar, todo en centavos enteros, y recién al final se divide por 100 una
// sola vez. Así el total nunca depende del orden en que se sumen los
// renglones ni arrastra el error de redondeo de coma flotante.
// ---------------------------------------------------------------------------

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

function lineAmountCents(unitPrice: number, quantity: number): number {
  return toCents(unitPrice) * quantity;
}

/** El importe de un renglón (precio unitario × cantidad), redondeado a centavos. */
export function computeLineAmount(unitPrice: number, quantity: number): number {
  return fromCents(lineAmountCents(unitPrice, quantity));
}

export interface InvoiceTotalsInput {
  unitPrice: number;
  quantity: number;
}

export interface InvoiceTotals {
  subtotal: number;
  taxAmount: number;
  total: number;
}

export function computeInvoiceTotals(items: InvoiceTotalsInput[], taxRate: number): InvoiceTotals {
  const subtotalCents = items.reduce((sum, item) => sum + lineAmountCents(item.unitPrice, item.quantity), 0);
  const taxCents = Math.round(subtotalCents * taxRate);
  const totalCents = subtotalCents + taxCents;

  return {
    subtotal: fromCents(subtotalCents),
    taxAmount: fromCents(taxCents),
    total: fromCents(totalCents),
  };
}

export interface InvoiceDraftItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface BuildInvoiceDraftInput {
  /** Solo hace falta el id de la conversación —el resto de `Sale` no se usa acá. */
  sale: { id: string };
  orderId: string;
  orderItems: InvoiceDraftItemInput[];
  contact: Contact;
  /** Null si no se pudo leer la tasa ese día: la factura se genera igual. */
  bcvRate: number | null;
  taxRate?: number;
}

/** Lo que hace falta para insertar una factura: el snapshot ya armado y los montos ya calculados. */
export interface InvoiceDraft {
  conversationId: string;
  orderId: string;
  contactId: string;
  customer: InvoiceCustomerSnapshot;
  items: InvoiceItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  currency: "USD";
  bcvRate: number | null;
}

/**
 * Arma el borrador de una factura a partir de una venta ya cerrada.
 *
 * `customer`/`items` quedan copiados en objetos nuevos —nunca el `Contact` ni
 * los `orderItems` que llegaron por parámetro— porque son el snapshot que
 * explica la migración: si después editan el contacto o el producto, la
 * factura ya generada no se entera.
 */
export function buildInvoiceDraft(input: BuildInvoiceDraftInput): InvoiceDraft {
  const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;

  const items: InvoiceItem[] = input.orderItems.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: computeLineAmount(item.unitPrice, item.quantity),
  }));

  const totals = computeInvoiceTotals(items, taxRate);

  const customer: InvoiceCustomerSnapshot = {
    displayName: input.contact.displayName ?? input.contact.profileName ?? "Cliente sin nombre registrado",
    phoneNumber: input.contact.phoneNumber,
    cedulaType: input.contact.cedulaType,
    cedulaNumber: input.contact.cedulaNumber,
    state: input.contact.state,
    city: input.contact.city,
    address: input.contact.address,
  };

  return {
    conversationId: input.sale.id,
    orderId: input.orderId,
    contactId: input.contact.id,
    customer,
    items,
    subtotal: totals.subtotal,
    taxRate,
    taxAmount: totals.taxAmount,
    total: totals.total,
    currency: "USD",
    bcvRate: input.bcvRate,
  };
}
