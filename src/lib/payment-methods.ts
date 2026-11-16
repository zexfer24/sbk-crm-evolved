// ---------------------------------------------------------------------------
// Formas de pago de contado que Seba le entrega al cliente (Entrega 2 de Seba
// v2, "Los datos del negocio", 16/11/2026, tabla `public.payment_methods`,
// migración 20261116020000). Módulo PURO: tipos y validación del borrador; la
// lectura vive en `data.ts` y las escrituras en `mutations.ts`.
//
// `PaymentMethodConfig` NO es `PaymentMethod` de `types.ts`: ese es el método
// con que se cierra una venta (efectivo, zelle…), otra cosa. Aquí cada forma
// de pago trae el texto que recibe el cliente (los datos para depositar).
//
// Cashea no es una forma de contado (se financia, con sus propios montos en
// `agent_settings`), por eso su clave está reservada.
// ---------------------------------------------------------------------------

export type PaymentMethodCurrency = "VES" | "USD";

export const PAYMENT_METHOD_CURRENCIES: readonly PaymentMethodCurrency[] = ["VES", "USD"];

export const PAYMENT_METHOD_CURRENCY_LABELS: Record<PaymentMethodCurrency, string> = {
  VES: "Bolívares",
  USD: "Dólares",
};

export interface PaymentMethodConfig {
  key: string;
  label: string;
  currency: PaymentMethodCurrency;
  instructions: string;
  sebaEntrega: boolean;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface PaymentMethodDraft {
  key: string;
  label: string;
  currency: PaymentMethodCurrency;
  instructions: string;
  sebaEntrega: boolean;
}

/** Mismo patrón que el CHECK de la tabla. Sin dígitos a propósito: la clave la referencia la herramienta de pago de Seba. */
export const PAYMENT_METHOD_KEY_PATTERN = /^[a-z_]{3,30}$/;
export const PAYMENT_METHOD_LABEL_MAX = 60;
export const PAYMENT_METHOD_INSTRUCTIONS_MAX = 1500;
export const RESERVED_PAYMENT_METHOD_KEYS: readonly string[] = ["cashea"];

export type PaymentMethodErrors = Partial<Record<"key" | "label" | "currency" | "instructions", string>>;

/**
 * `{}` = válido. `existingKeys` solo se pasa al CREAR (para detectar una clave
 * repetida); al editar se omite, porque la clave no cambia nunca. Las
 * longitudes se miden con `.length` de JS (un emoji cuenta 2): la base mide
 * menos o igual, nunca más.
 */
export function validatePaymentMethodDraft(
  draft: PaymentMethodDraft,
  options?: { existingKeys?: readonly string[] }
): PaymentMethodErrors {
  const errors: PaymentMethodErrors = {};

  if (!PAYMENT_METHOD_KEY_PATTERN.test(draft.key)) {
    errors.key = "La clave usa solo minúsculas y guion bajo, entre 3 y 30 caracteres.";
  } else if (RESERVED_PAYMENT_METHOD_KEYS.includes(draft.key)) {
    errors.key = `"${draft.key}" no es una forma de contado: se configura aparte.`;
  } else if (options?.existingKeys?.includes(draft.key)) {
    errors.key = "Ya existe una forma de pago con esa clave.";
  }

  const label = draft.label.trim();
  if (!label) errors.label = "Escribe el nombre de la forma de pago.";
  else if (label.length > PAYMENT_METHOD_LABEL_MAX) errors.label = "El nombre no puede pasar de 60 caracteres.";

  if (!PAYMENT_METHOD_CURRENCIES.includes(draft.currency)) errors.currency = "Elige la moneda.";

  const instructions = draft.instructions.trim();
  if (!instructions) errors.instructions = "Escribe los datos que recibe el cliente.";
  else if (instructions.length > PAYMENT_METHOD_INSTRUCTIONS_MAX) errors.instructions = "El texto no puede pasar de 1500 caracteres.";

  return errors;
}

/**
 * Propone la clave a partir del nombre ("Pago móvil" → "pago_movil"; "Zelle
 * (USD)" → "zelle_usd"). Minúsculas, sin acentos, todo lo que no sea a-z pasa
 * a "_", sin "_" repetidos ni en los bordes, máximo 30. Puede devolver "" o
 * una clave demasiado corta: la valida `validatePaymentMethodDraft`.
 */
export function paymentMethodKeyFromLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // las tildes quedan como marcas combinantes aparte tras NFD
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/g, "");
}

/** El mayor `sortOrder` + 10 (10 si no hay ninguna): la nueva va al final. */
export function nextPaymentMethodSortOrder(methods: readonly Pick<PaymentMethodConfig, "sortOrder">[]): number {
  if (methods.length === 0) return 10;
  return Math.max(...methods.map((m) => m.sortOrder)) + 10;
}
