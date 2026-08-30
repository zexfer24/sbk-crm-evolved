import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TAG_FILTER_CONTACT_LIMIT, fetchConversations, fetchTagsInUse } from "@/lib/data";

// ---------------------------------------------------------------------------
// La barra de etiquetas de la bandeja se deducía de `conversations` en
// memoria (`inbox-sidebar.tsx:499`, las ~30 filas de la ventana cargada), así
// que una etiqueta aplicada a un chat fuera de esa ventana no aparecía nunca
// — y la IA suele etiquetar conversaciones que atiende sola, más abajo en la
// lista. Este archivo prueba las dos mitades del arreglo de datos:
//
//   1. `fetchTagsInUse`: las etiquetas salen de la base, no de la ventana.
//   2. `tagId` en `fetchConversations`: el filtro por etiqueta se resuelve en
//      el servidor, por `contact_id` (no con un embed filtrado que recortara
//      los OTROS chips de color de la conversación — la trampa que esta
//      entrega evita a propósito).
// ---------------------------------------------------------------------------

interface RawTagRow {
  id: string;
  label: string;
  color: string;
  contact_tags: { contact_id: string }[];
}

/** El fake de la tabla `tags`: entiende el embed `contact_tags!inner(contact_id)`. */
function createFakeTags(rows: RawTagRow[]) {
  return {
    select(query: string) {
      // Simula el `!inner` de PostgREST: solo las etiquetas con al menos un
      // vínculo, cada una en UNA fila (no una por vínculo) — igual que se
      // comprobó contra la base local el 30/8/2026. Cuando el `select` no
      // pide el embed (como `fetchTags`), no hay filtro que aplicar.
      const conFiltro = query.includes("contact_tags");
      const filtradas = conFiltro ? rows.filter((r) => r.contact_tags.length > 0) : rows;
      return {
        order(column: string) {
          const sorted = [...filtradas].sort((a, b) =>
            (a as unknown as Record<string, string>)[column] <
            (b as unknown as Record<string, string>)[column]
              ? -1
              : 1
          );
          return Promise.resolve({ data: sorted, error: null });
        },
      };
    },
  };
}

describe("fetchTagsInUse", () => {
  const rows: RawTagRow[] = [
    { id: "t-vip", label: "VIP", color: "purple", contact_tags: [] }, // sin usar
    {
      id: "t-bbk",
      label: "BBK",
      color: "blue",
      contact_tags: [{ contact_id: "c-1" }],
    },
    {
      id: "t-nuevo",
      label: "Nuevo",
      color: "green",
      contact_tags: [{ contact_id: "c-5" }],
    },
  ];

  it("devuelve solo las etiquetas con al menos un contacto, ordenadas por label", async () => {
    const client = { from: () => createFakeTags(rows) } as unknown as SupabaseClient;

    const result = await fetchTagsInUse(client);

    expect(result.map((t) => t.label)).toEqual(["BBK", "Nuevo"]);
  });

  it("una etiqueta existente pero sin usar no aparece", async () => {
    const client = { from: () => createFakeTags(rows) } as unknown as SupabaseClient;

    const result = await fetchTagsInUse(client);

    expect(result.find((t) => t.id === "t-vip")).toBeUndefined();
  });

  /**
   * Red de seguridad del `Set` de `fetchTagsInUse`: aunque PostgREST no
   * debería repetir la etiqueta (un `!inner` sobre una relación to-many
   * devuelve una fila por padre, comprobado contra la base local), el fake
   * simula acá el caso en que SÍ llegaran dos filas para la misma etiqueta
   * (dos vínculos con dos contactos distintos) — el resultado tiene que
   * seguir siendo uno solo.
   */
  it("no duplica una etiqueta aunque lleguen dos filas para ella", async () => {
    const dosVinculos: RawTagRow[] = [
      {
        id: "t-moroso",
        label: "Moroso",
        color: "red",
        contact_tags: [{ contact_id: "c-3" }, { contact_id: "c-9" }],
      },
    ];
    // Fake deliberadamente más simple: entrega la fila de la etiqueta DOS
    // veces, una por vínculo, para forzar la rama de deduplicación.
    const client = {
      from: () => ({
        select: () => ({
          order: () =>
            Promise.resolve({
              data: [dosVinculos[0], dosVinculos[0]],
              error: null,
            }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await fetchTagsInUse(client);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-moroso");
  });
});

// ---------------------------------------------------------------------------
// `tagId` en `fetchConversations`.
// ---------------------------------------------------------------------------

interface ContactTagLink {
  contact_id: string;
  tag_id: string;
}

interface ConvRow {
  id: string;
  status: "open" | "closed";
  assigned_agent_id: string | null;
  awaiting_reply: boolean;
  has_reply: boolean;
  unread_count: number;
  manually_unread: boolean;
  ai_enabled: boolean;
  deal_status: null;
  deal_closed_at: null;
  deal_payment_proof_url: null;
  order: null;
  deal_verified: boolean;
  deal_verified_at: null;
  deal_payment_method: null;
  deal_closed_by: null;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_direction: null;
  last_message_status: null;
  created_at: string;
  journey_stage: null;
  intent: null;
  active_tool: null;
  welcome_sent_at: null;
  contact: {
    id: string;
    phone_number: string;
    display_name: string;
    profile_name: null;
    avatar_url: null;
    cedula_type: null;
    cedula_number: null;
    state: null;
    city: null;
    address: null;
    contact_tags: { tag: { id: string; label: string; color: string } }[];
  };
  channel: {
    id: string;
    label: string;
    phone_number: string;
    phone_number_id: string;
    status: "connected";
  };
  assigned_agent: null;
}

function makeConv(
  id: string,
  contactId: string,
  tags: { id: string; label: string; color: string }[]
): ConvRow {
  return {
    id,
    status: "open",
    assigned_agent_id: null,
    awaiting_reply: false,
    has_reply: false,
    unread_count: 0,
    manually_unread: false,
    ai_enabled: true,
    deal_status: null,
    deal_closed_at: null,
    deal_payment_proof_url: null,
    order: null,
    deal_verified: false,
    deal_verified_at: null,
    deal_payment_method: null,
    deal_closed_by: null,
    last_customer_message_at: null,
    last_message_at: `2026-08-30T10:00:0${id.slice(-1)}.000000+00:00`,
    last_message_preview: `preview ${id}`,
    last_message_direction: null,
    last_message_status: null,
    created_at: "2026-08-30T09:00:00.000000+00:00",
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    contact: {
      id: contactId,
      phone_number: "58400000000",
      display_name: `Cliente ${contactId}`,
      profile_name: null,
      avatar_url: null,
      cedula_type: null,
      cedula_number: null,
      state: null,
      city: null,
      address: null,
      contact_tags: tags.map((tag) => ({ tag })),
    },
    channel: {
      id: "canal-1",
      label: "Principal",
      phone_number: "584120000000",
      phone_number_id: "pnid",
      status: "connected",
    },
    assigned_agent: null,
  };
}

/**
 * Fake que enruta por nombre de tabla: `contact_tags` (resolución del
 * `tagId`, `.select("contact_id").eq("tag_id", …).limit(…)`) y `conversations`
 * (la consulta de lista de siempre, acotada por `contact_id` con `.in()`).
 * No reproduce el cursor completo de `data-conversations.test.ts` — acá
 * alcanza con `order`/`in`/`range` porque lo que se prueba es el filtro por
 * etiqueta, no la paginación, que ya tiene su propia batería de tests.
 */
function createFakeSupabase(links: ContactTagLink[], conversations: ConvRow[]) {
  const contactTagsCalls: {
    tagId: string;
    limit: number | undefined;
    orden?: { column: string; ascending: boolean };
  }[] = [];
  const conversationsInCalls: string[][] = [];

  const client = {
    from(table: string) {
      if (table === "contact_tags") {
        return {
          select() {
            return {
              eq(_column: string, tagId: string) {
                // El `.order()` va antes del `.limit()`: solo importa cuando la
                // etiqueta pasa el tope, y ahí decide QUÉ contactos quedan
                // afuera. Acá se registra para poder afirmar que la consulta
                // lo pide; el orden de `links` ya viene dado por el test.
                const conOrden = {
                  order(column: string, opciones: { ascending: boolean }) {
                    contactTagsCalls.push({ tagId, limit: undefined, orden: { column, ...opciones } });
                    return {
                      limit(n: number) {
                        const ultima = contactTagsCalls[contactTagsCalls.length - 1];
                        ultima.limit = n;
                        const data = links
                          .filter((l) => l.tag_id === tagId)
                          .slice(0, n)
                          .map((l) => ({ contact_id: l.contact_id }));
                        return Promise.resolve({ data, error: null });
                      },
                    };
                  },
                };
                return conOrden;
              },
            };
          },
        };
      }

      if (table === "conversations") {
        return {
          select() {
            let contactIdFilter: string[] | null = null;
            const chain = {
              order() {
                return chain;
              },
              in(column: string, values: string[]) {
                if (column === "contact_id") {
                  contactIdFilter = values;
                  conversationsInCalls.push(values);
                }
                return chain;
              },
              range(from: number, to: number) {
                const filtered = contactIdFilter
                  ? conversations.filter((c) => contactIdFilter!.includes(c.contact.id))
                  : conversations;
                return Promise.resolve({
                  data: filtered.slice(from, to + 1),
                  error: null,
                });
              },
            };
            return chain;
          },
        };
      }

      throw new Error(`tabla no soportada por el fake: "${table}"`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    contactTagsCalls,
    conversationsInCalls,
  };
}

describe("fetchConversations con tagId", () => {
  const tagVip = { id: "t-vip", label: "VIP", color: "purple" };
  const tagBbk = { id: "t-bbk", label: "BBK", color: "blue" };

  const links: ContactTagLink[] = [
    { contact_id: "c-1", tag_id: tagVip.id },
    { contact_id: "c-3", tag_id: tagVip.id },
  ];

  const conversations: ConvRow[] = [
    makeConv("conv-a", "c-1", [tagVip]), // contacto c-1: tiene VIP
    makeConv("conv-b", "c-2", []), // contacto c-2: no tiene ninguna etiqueta
    makeConv("conv-c", "c-3", [tagVip, tagBbk]), // contacto c-3: VIP y BBK
  ];

  it("trae solo las conversaciones de contactos con esa etiqueta", async () => {
    const { client, contactTagsCalls } = createFakeSupabase(links, conversations);

    const result = await fetchConversations(client, { tagId: tagVip.id });

    expect(result.map((c) => c.id).sort()).toEqual(["conv-a", "conv-c"]);
    // El tope y su orden viajan juntos a propósito: un `limit` sin `order` deja
    // que Postgres elija qué contactos quedan afuera cuando la etiqueta lo
    // supera, y esa elección puede cambiar entre dos consultas seguidas.
    expect(contactTagsCalls).toEqual([
      {
        tagId: tagVip.id,
        limit: TAG_FILTER_CONTACT_LIMIT,
        orden: { column: "created_at", ascending: false },
      },
    ]);
  });

  /**
   * La trampa que esta entrega evita a propósito: filtrar con un embed
   * interno filtrado (`contact:contacts!inner(contact_tags!inner(...))`)
   * recorta los HIJOS al que casó, y cada fila volvería con SOLO la etiqueta
   * filtrada. El camino elegido (resolver `contact_id` aparte y pasarlo por
   * `contactIds`) no toca el `select` de la lista, así que la conversación
   * de un contacto con varias etiquetas las tiene que traer TODAS.
   */
  it("una conversación filtrada por una etiqueta sigue trayendo TODAS las etiquetas de su contacto", async () => {
    const { client } = createFakeSupabase(links, conversations);

    const result = await fetchConversations(client, { tagId: tagVip.id });

    const convC = result.find((c) => c.id === "conv-c")!;
    expect(convC.contact.tags.map((t) => t.id).sort()).toEqual([tagBbk.id, tagVip.id].sort());
  });

  it("una etiqueta sin ningún contacto no consulta conversations y responde vacío", async () => {
    const { client, conversationsInCalls } = createFakeSupabase(links, conversations);

    const result = await fetchConversations(client, { tagId: "t-sin-uso" });

    expect(result).toEqual([]);
    expect(conversationsInCalls).toEqual([]);
  });
});
