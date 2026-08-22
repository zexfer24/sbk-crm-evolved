import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerConversationRow,
  CustomerDetail,
  CustomerPurchase,
  CustomerSummary,
  DealStatus,
  Note,
} from "@/lib/types";
import { mapContact, type RawContact } from "@/lib/data";
import { orExpression, pgrstLiteral } from "@/lib/ai/pgrst";
import { pageRange, summarizeCustomerActivity, type CustomerParams } from "@/lib/customers";

/**
 * Consultas de la sección Clientes.
 *
 * Vive aparte de `data.ts` a propósito: esas consultas giran alrededor del
 * hilo de conversación, y estas alrededor de la persona. Compartir el
 * mapeo del contacto (`mapContact`) alcanza para no duplicar nada.
 *
 * Todo se resuelve en el servidor —búsqueda, filtro y paginación— porque la
 * lista de clientes crece con cada número nuevo que escribe: traerla entera
 * al navegador funciona el primer mes y deja de funcionar después.
 */

const CONTACT_SELECT = `
  id, phone_number, display_name, profile_name, avatar_url,
  cedula_type, cedula_number, state, city, address, created_at,
  contact_tags(tag:tags(id, label, color))
`;

interface RawConversationRow {
  id: string;
  contact_id: string;
  deal_status: DealStatus;
  deal_closed_at: string | null;
  last_message_at: string | null;
  deal_verified: boolean;
  order: { id: string; total_amount: number; currency: string; purchased_at: string } | null;
}

function mapConversationRow(row: RawConversationRow): CustomerConversationRow {
  return {
    id: row.id,
    dealStatus: row.deal_status,
    dealClosedAt: row.deal_closed_at,
    lastMessageAt: row.last_message_at,
    orderTotal: row.order ? Number(row.order.total_amount) : null,
    orderCurrency: row.order?.currency ?? null,
    orderPurchasedAt: row.order?.purchased_at ?? null,
  };
}

/**
 * PostgREST corta cada respuesta en 1000 filas sin avisar. La lista de
 * compradores se usa para filtrar, así que un corte silencioso escondería
 * clientes: se pagina hasta agotarla, igual que hace `fetchMessages`.
 */
const BUYER_PAGE_SIZE = 1000;

/**
 * Ids de contactos con al menos una venta que sigue cerrada.
 *
 * Se mira `conversations`, no `orders`: `returnSale` y `deleteSale` cambian
 * el estado de la conversación pero dejan viva la fila de la orden, así que
 * preguntarle a `orders` contaría devoluciones y ventas eliminadas.
 *
 * A partir de unos pocos miles de compradores esta lista deja de caber
 * cómoda en la URL del filtro; llegado ese punto toca una vista en la base.
 */
async function fetchBuyerContactIds(supabase: SupabaseClient): Promise<string[]> {
  const ids = new Set<string>();
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("conversations")
      .select("contact_id")
      .eq("deal_status", "won")
      .order("contact_id", { ascending: true })
      .range(from, from + BUYER_PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as { contact_id: string }[];
    for (const row of page) ids.add(row.contact_id);

    if (page.length < BUYER_PAGE_SIZE) break;
    from += BUYER_PAGE_SIZE;
  }

  return [...ids];
}

export interface CustomersPage {
  customers: CustomerSummary[];
  /** Total de clientes que cumplen el filtro, no solo los de esta página. */
  total: number;
}

export async function fetchCustomersPage(
  supabase: SupabaseClient,
  { query, filter, sort, page }: CustomerParams
): Promise<CustomersPage> {
  let request = supabase.from("contacts").select(CONTACT_SELECT, { count: "exact" });

  // Una búsqueda y el filtro de datos incompletos son dos disyunciones a la
  // vez; hay que distribuirlas en un solo `.or()` (ver `orExpression`).
  const groups: string[][] = [];

  if (query) {
    const term = pgrstLiteral(`%${query}%`);
    groups.push([
      `display_name.ilike.${term}`,
      `profile_name.ilike.${term}`,
      `phone_number.ilike.${term}`,
      `cedula_number.ilike.${term}`,
    ]);
  }

  if (filter === "datos-incompletos") {
    groups.push(["cedula_number.is.null", "address.is.null"]);
  }

  const expression = orExpression(groups);
  if (expression) request = request.or(expression);

  if (filter === "compradores" || filter === "sin-compras") {
    const buyers = await fetchBuyerContactIds(supabase);

    if (filter === "compradores") {
      // Sin compradores no hay nada que mostrar, y `.in()` con lista vacía
      // no es una consulta válida en PostgREST.
      if (buyers.length === 0) return { customers: [], total: 0 };
      request = request.in("id", buyers);
    } else if (buyers.length > 0) {
      request = request.not("id", "in", `(${buyers.join(",")})`);
    }
  }

  request =
    sort === "nombre"
      ? request
          .order("display_name", { ascending: true, nullsFirst: false })
          .order("profile_name", { ascending: true, nullsFirst: false })
      : request.order("created_at", { ascending: false });

  const { from, to } = pageRange(page);
  const { data, error, count } = await request.range(from, to);
  if (error) throw error;

  const contacts = ((data ?? []) as unknown as RawContact[]).map(mapContact);
  if (contacts.length === 0) return { customers: [], total: count ?? 0 };

  // Un solo viaje más por los datos comerciales de los clientes de ESTA
  // página: son decenas de filas, no el historial completo del negocio.
  const activityByContact = await fetchActivityFor(
    supabase,
    contacts.map((contact) => contact.id)
  );

  return {
    customers: contacts.map((contact) => ({
      contact,
      activity: summarizeCustomerActivity(activityByContact.get(contact.id) ?? []),
    })),
    total: count ?? contacts.length,
  };
}

async function fetchActivityFor(
  supabase: SupabaseClient,
  contactIds: string[]
): Promise<Map<string, CustomerConversationRow[]>> {
  const { data, error } = await supabase
    .from("conversations")
    .select(
      `id, contact_id, deal_status, deal_closed_at, last_message_at, deal_verified,
       order:orders(id, total_amount, currency, purchased_at)`
    )
    .in("contact_id", contactIds);

  if (error) throw error;

  const byContact = new Map<string, CustomerConversationRow[]>();
  for (const row of (data ?? []) as unknown as RawConversationRow[]) {
    const list = byContact.get(row.contact_id) ?? [];
    list.push(mapConversationRow(row));
    byContact.set(row.contact_id, list);
  }
  return byContact;
}

interface RawPurchaseRow {
  id: string;
  contact_id: string;
  deal_status: DealStatus;
  deal_closed_at: string | null;
  last_message_at: string | null;
  deal_verified: boolean;
  order: {
    id: string;
    total_amount: number;
    currency: string;
    purchased_at: string;
    order_items: { description: string; quantity: number; unit_price: number }[] | null;
  } | null;
}

interface RawNoteRow {
  id: string;
  contact_id: string;
  content: string;
  created_at: string;
  agent: {
    id: string;
    display_name: string;
    full_name: string | null;
    avatar_url: string | null;
    role: "agent" | "supervisor" | "admin";
    is_active: boolean;
  } | null;
}

export async function fetchCustomerDetail(
  supabase: SupabaseClient,
  contactId: string
): Promise<CustomerDetail | null> {
  const { data: contactRow, error: contactError } = await supabase
    .from("contacts")
    .select(CONTACT_SELECT)
    .eq("id", contactId)
    .maybeSingle();

  if (contactError) throw contactError;
  if (!contactRow) return null;

  const [{ data: conversationRows, error: conversationError }, { data: noteRows, error: noteError }] =
    await Promise.all([
      supabase
        .from("conversations")
        .select(
          `id, contact_id, deal_status, deal_closed_at, last_message_at, deal_verified,
           order:orders(id, total_amount, currency, purchased_at,
             order_items(description, quantity, unit_price))`
        )
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false, nullsFirst: false }),
      supabase
        .from("notes")
        .select(
          `id, contact_id, content, created_at,
           agent:agents(id, display_name, full_name, avatar_url, role, is_active)`
        )
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
    ]);

  if (conversationError) throw conversationError;
  if (noteError) throw noteError;

  const rows = (conversationRows ?? []) as unknown as RawPurchaseRow[];

  const purchases: CustomerPurchase[] = rows
    .filter((row) => row.deal_status === "won" && row.order !== null)
    .map((row) => ({
      orderId: row.order!.id,
      conversationId: row.id,
      purchasedAt: row.order!.purchased_at ?? row.deal_closed_at ?? "",
      totalAmount: Number(row.order!.total_amount),
      currency: row.order!.currency,
      verified: row.deal_verified,
      items: (row.order!.order_items ?? []).map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: Number(item.unit_price),
      })),
    }))
    .sort((a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime());

  const conversations = rows.map((row) =>
    mapConversationRow({
      id: row.id,
      contact_id: row.contact_id,
      deal_status: row.deal_status,
      deal_closed_at: row.deal_closed_at,
      last_message_at: row.last_message_at,
      deal_verified: row.deal_verified,
      order: row.order
        ? {
            id: row.order.id,
            total_amount: row.order.total_amount,
            currency: row.order.currency,
            purchased_at: row.order.purchased_at,
          }
        : null,
    })
  );

  const notes: Note[] = ((noteRows ?? []) as unknown as RawNoteRow[]).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    content: row.content,
    createdAt: row.created_at,
    agent: row.agent
      ? {
          id: row.agent.id,
          displayName: row.agent.display_name,
          fullName: row.agent.full_name,
          avatarUrl: row.agent.avatar_url,
          role: row.agent.role,
          isActive: row.agent.is_active,
        }
      : null,
  }));

  return {
    contact: mapContact(contactRow as unknown as RawContact),
    activity: summarizeCustomerActivity(conversations),
    purchases,
    conversations,
    notes,
  };
}
