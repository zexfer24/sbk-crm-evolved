import type { Contact, CustomerActivity, CustomerConversationRow } from "@/lib/types";

/**
 * Lógica pura de la sección Clientes: cómo se lee la URL, cómo se pagina y
 * cómo se resume lo comercial de un cliente. Sin Supabase y sin React, para
 * que las reglas que importan —sobre todo qué cuenta como gasto— se puedan
 * probar sin levantar nada.
 */

// ---------------------------------------------------------------------------
// Nombre, cédula y ubicación
// ---------------------------------------------------------------------------

/**
 * Mismo criterio que `contactName` de dashboard.ts, pero sobre el contacto
 * suelto: en Clientes no siempre hay una conversación de la que colgarse.
 */
export function customerName(contact: Contact): string {
  return contact.displayName ?? contact.profileName ?? contact.phoneNumber;
}

export function formatCedula(contact: Contact): string | null {
  if (!contact.cedulaType || !contact.cedulaNumber) return null;
  return `${contact.cedulaType}-${contact.cedulaNumber}`;
}

export function customerLocation(contact: Contact): string | null {
  const parts = [contact.city, contact.state].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Un perfil está incompleto si le falta algo de lo que hace falta para
 * despachar: la cédula o la dirección. Es el criterio del filtro
 * "datos incompletos" y del aviso en la ficha.
 */
export function isProfileIncomplete(contact: Contact): boolean {
  const tieneCedula = Boolean(contact.cedulaType && contact.cedulaNumber);
  const tieneDireccion = Boolean(contact.address && contact.address.trim());
  return !tieneCedula || !tieneDireccion;
}

// ---------------------------------------------------------------------------
// Resumen comercial
// ---------------------------------------------------------------------------

const EMPTY_ACTIVITY: CustomerActivity = {
  totalSpentUsd: 0,
  purchaseCount: 0,
  lastPurchaseAt: null,
  lastMessageAt: null,
  conversationCount: 0,
  latestConversationId: null,
  hasNonUsdPurchases: false,
};

function timeOf(iso: string | null): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Cuánto compró y cuándo habló un cliente, a partir de sus conversaciones.
 *
 * Solo cuenta lo que sigue cerrado (`deal_status = 'won'`). Es deliberado:
 * `returnSale` y `deleteSale` marcan la conversación como devuelta o la
 * sacan del feed, pero **no borran la fila de `orders`**. Sumar `orders`
 * directo contaría devoluciones y ventas eliminadas como gasto del cliente.
 */
export function summarizeCustomerActivity(rows: CustomerConversationRow[]): CustomerActivity {
  if (rows.length === 0) return { ...EMPTY_ACTIVITY };

  let totalSpentUsd = 0;
  let purchaseCount = 0;
  let hasNonUsdPurchases = false;
  let lastPurchase: { iso: string; time: number } | null = null;
  let lastMessage: { iso: string; time: number } | null = null;
  let latest: { id: string; time: number } | null = null;

  for (const row of rows) {
    if (row.dealStatus === "won" && row.orderTotal !== null) {
      purchaseCount += 1;
      if (row.orderCurrency === "USD" || row.orderCurrency === null) {
        totalSpentUsd += row.orderTotal;
      } else {
        hasNonUsdPurchases = true;
      }

      // La orden trae su propia fecha; si faltara, la del cierre sirve igual.
      const iso = row.orderPurchasedAt ?? row.dealClosedAt;
      const time = timeOf(iso);
      if (iso && time !== null && (lastPurchase === null || time > lastPurchase.time)) {
        lastPurchase = { iso, time };
      }
    }

    const messageTime = timeOf(row.lastMessageAt);
    if (row.lastMessageAt && messageTime !== null && (lastMessage === null || messageTime > lastMessage.time)) {
      lastMessage = { iso: row.lastMessageAt, time: messageTime };
    }
    if (messageTime !== null && (latest === null || messageTime > latest.time)) {
      latest = { id: row.id, time: messageTime };
    }
  }

  return {
    totalSpentUsd: Number(totalSpentUsd.toFixed(2)),
    purchaseCount,
    lastPurchaseAt: lastPurchase?.iso ?? null,
    lastMessageAt: lastMessage?.iso ?? null,
    conversationCount: rows.length,
    // Un contacto puede tener conversaciones sin un solo mensaje fechado
    // (se creó el hilo y nunca escribió). Igual hay que poder abrir una.
    latestConversationId: latest?.id ?? rows[0].id,
    hasNonUsdPurchases,
  };
}

// ---------------------------------------------------------------------------
// Estado de la lista, leído de la URL
//
// La búsqueda vive en la URL y no en el estado de React: se comparte, se
// recarga sin perderla y el servidor puede resolverla sin JavaScript.
// ---------------------------------------------------------------------------

export type CustomerFilter = "todos" | "compradores" | "sin-compras" | "datos-incompletos";
export type CustomerSort = "recientes" | "nombre";

const FILTERS: CustomerFilter[] = ["todos", "compradores", "sin-compras", "datos-incompletos"];
const SORTS: CustomerSort[] = ["recientes", "nombre"];

export const CUSTOMER_FILTER_LABELS: Record<CustomerFilter, string> = {
  todos: "Todos",
  compradores: "Compradores",
  "sin-compras": "Sin compras",
  "datos-incompletos": "Datos incompletos",
};

export const CUSTOMER_SORT_LABELS: Record<CustomerSort, string> = {
  recientes: "Más recientes",
  nombre: "Por nombre",
};

export const CUSTOMERS_PAGE_SIZE = 40;

export interface CustomerParams {
  query: string;
  filter: CustomerFilter;
  sort: CustomerSort;
  page: number;
}

/** Next entrega `string | string[] | undefined` por parámetro. */
type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCustomerParams(raw: RawParams): CustomerParams {
  const filter = first(raw.filtro);
  const sort = first(raw.orden);
  const page = Number(first(raw.page));

  return {
    query: (first(raw.q) ?? "").trim(),
    filter: FILTERS.includes(filter as CustomerFilter) ? (filter as CustomerFilter) : "todos",
    sort: SORTS.includes(sort as CustomerSort) ? (sort as CustomerSort) : "recientes",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Arma el enlace a la lista dejando fuera todo lo que ya es el valor por defecto. */
export function customersHref({ query, filter, sort, page }: CustomerParams): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filter !== "todos") params.set("filtro", filter);
  if (sort !== "recientes") params.set("orden", sort);
  if (page > 1) params.set("page", String(page));

  const qs = params.toString();
  return qs ? `/clientes?${qs}` : "/clientes";
}

export function pageRange(page: number, size: number = CUSTOMERS_PAGE_SIZE): { from: number; to: number } {
  const from = (page - 1) * size;
  return { from, to: from + size - 1 };
}

export function totalPages(count: number, size: number = CUSTOMERS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(count / size));
}
