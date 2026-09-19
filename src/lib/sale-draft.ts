import type { CedulaType, PaymentMethod } from "@/lib/types";

// ---------------------------------------------------------------------------
// Los nueve campos obligatorios de "Cerrar venta" (T5, plan "Nada sin leer,
// un solo catálogo y la factura Saint", 18/9/2026, D9-D11).
//
// Historia: hasta esta corrida el modal solo exigía nombre, carrito y método
// de pago (toast + botón deshabilitado); cédula, estado, ciudad, dirección
// y comprobante eran opcionales, y no existía ningún campo para el número de
// la factura del sistema administrativo del negocio (Saint). El cliente
// pidió los nueve como obligatorios de una vez: "Nombre, Número de WhatsApp,
// Cédula, Estado, Ciudad, Dirección, Método de pago, Número de factura Saint
// y comprobante de pago".
//
// D10 pide validación POR CAMPO en vez de un botón mudo: esta función es
// pura (sin React, sin Supabase) para poder correr dos veces con la MISMA
// regla — una vez en el modal, al intentar guardar, y otra vez dentro de
// `closeSaleWithContactInfo` (`mutations.ts`) como segunda barrera antes de
// escribir nada en la base.
// ---------------------------------------------------------------------------

/**
 * Todo lo que hace falta para cerrar una venta. `itemCount` (los repuestos
 * del carrito) NO es uno de los nueve campos de D11 —esa regla ("al menos
 * un repuesto") es previa a este plan y sigue viviendo aparte, en
 * `close-sale-modal.tsx`, con su propio aviso, porque el carrito no tiene un
 * único campo de formulario al que atarle un mensaje— pero viaja acá porque
 * el borrador representa TODO el estado que el modal junta antes de guardar.
 */
export interface SaleDraft {
  displayName: string;
  whatsappNumber: string;
  cedulaType: CedulaType | "";
  cedulaNumber: string;
  state: string;
  city: string;
  address: string;
  paymentMethod: PaymentMethod | "";
  saintInvoiceNumber: string;
  paymentProofUrl: string | null;
  itemCount: number;
}

/**
 * Las claves de `validateSaleDraft`. Cédula (tipo + número) cuenta como UN
 * solo campo, tal como pide D11 ("cédula = tipo V/E + número de 5 a 10
 * dígitos"): dos inputs en la interfaz, un solo mensaje de error.
 *
 * El ORDEN de las claves de este objeto es significativo: `close-sale-modal.tsx`
 * recorre `Object.keys(SALE_FIELD_LABELS)` para decidir cuál es "el primer
 * campo inválido" a enfocar (D10), y ese orden tiene que calzar con el orden
 * visual de los campos en el formulario.
 */
export type SaleField =
  | "displayName"
  | "whatsappNumber"
  | "cedula"
  | "state"
  | "city"
  | "address"
  | "paymentMethod"
  | "saintInvoiceNumber"
  | "paymentProofUrl";

export const SALE_FIELD_LABELS: Record<SaleField, string> = {
  displayName: "Nombre",
  whatsappNumber: "Número de WhatsApp",
  cedula: "Cédula",
  state: "Estado",
  city: "Ciudad",
  address: "Dirección",
  paymentMethod: "Método de pago",
  saintInvoiceNumber: "Número de factura Saint",
  paymentProofUrl: "Comprobante de pago",
};

const CEDULA_NUMBER_PATTERN = /^\d{5,10}$/;

/** D11: cédula = tipo V/E + número de 5 a 10 dígitos. Esto valida solo el número. */
export function isValidCedulaNumber(value: string): boolean {
  return CEDULA_NUMBER_PATTERN.test(value.trim());
}

/**
 * D11: "factura Saint no vacía, ≤ 40 caracteres, se guarda recortada".
 * Recorta los extremos y colapsa espacios internos repetidos a uno solo —el
 * CHECK de la base (`orders_saint_invoice_number_check`, migración
 * 20260918020000) solo exige `= btrim(...)`, sin colapsar; esta función hace
 * un poco más para que "00123   ABC" no llegue con espacios dobles a Saint.
 */
export function normalizeSaint(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Valida el borrador campo por campo y devuelve un mensaje por cada uno que
 * falle, en el ORDEN de `SALE_FIELD_LABELS` (ver su docblock: el modal
 * depende de ese orden para enfocar "el primero inválido"). Un borrador sin
 * errores devuelve `{}`.
 */
export function validateSaleDraft(draft: SaleDraft): Partial<Record<SaleField, string>> {
  const errors: Partial<Record<SaleField, string>> = {};

  if (!draft.displayName.trim()) {
    errors.displayName = "El nombre del cliente es obligatorio.";
  }

  if (!draft.whatsappNumber.trim()) {
    errors.whatsappNumber = "Falta el número de WhatsApp del cliente.";
  }

  if (!draft.cedulaType) {
    errors.cedula = "Elige si la cédula es V o E.";
  } else if (!isValidCedulaNumber(draft.cedulaNumber)) {
    errors.cedula = "La cédula debe tener entre 5 y 10 dígitos.";
  }

  if (!draft.state) {
    errors.state = "Elige un estado.";
  }

  if (!draft.city.trim()) {
    errors.city = "La ciudad es obligatoria.";
  }

  if (!draft.address.trim()) {
    errors.address = "La dirección es obligatoria.";
  }

  if (!draft.paymentMethod) {
    errors.paymentMethod = "Elige con qué pagó el cliente.";
  }

  const saint = normalizeSaint(draft.saintInvoiceNumber);
  if (!saint) {
    errors.saintInvoiceNumber = "El número de factura Saint es obligatorio.";
  } else if (saint.length > 40) {
    errors.saintInvoiceNumber = "El número de factura Saint no puede superar los 40 caracteres.";
  }

  if (!draft.paymentProofUrl) {
    errors.paymentProofUrl = "Elige o sube un comprobante de pago.";
  }

  return errors;
}
