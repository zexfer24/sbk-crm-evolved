import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTicketTags } from "@/lib/data";
import {
  buildTicketStats,
  isTicket,
  ticketCategory,
  ticketQueue,
  ticketTagsOf,
} from "@/lib/dashboard";
import type { BoardConversation, Tag, TicketTagsByContact } from "@/lib/types";

/**
 * Un reclamo no es una entidad aparte: es un contacto etiquetado. Las
 * etiquetas dejaron de viajar embebidas en cada fila del tablero —eran un
 * lateral por fila en PostgREST, cientos por carga— y llegan en un mapa por
 * contacto. Esto cubre las dos mitades: que el mapa se arme bien, y que la
 * estadística siga contando lo mismo leyéndolo.
 */

const ENVIO: Tag = { id: "tag-envio", label: "Reclamo · Envío", color: "danger" };
const GARANTIA: Tag = { id: "tag-gar", label: "Reclamo · Garantía", color: "warning" };

const HORA = 60 * 60 * 1000;
const AHORA = new Date("2026-08-25T18:00:00.000Z").getTime();

function conversacion(over: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id: "conv-1",
    contact: {
      id: "contact-1",
      phoneNumber: "+58123456789",
      displayName: "Cliente",
      profileName: null,
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: new Date(AHORA - HORA).toISOString(),
    hasReply: false,
    lastMessageAt: new Date(AHORA - HORA).toISOString(),
    createdAt: new Date(AHORA - 10 * HORA).toISOString(),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...over,
  };
}

describe("etiquetas de reclamo — el mapa manda, no la fila", () => {
  const tags: TicketTagsByContact = new Map([["contact-1", [ENVIO]]]);

  it("una conversación de un contacto etiquetado es un reclamo", () => {
    expect(isTicket(conversacion(), tags)).toBe(true);
    expect(ticketTagsOf(conversacion(), tags)).toEqual([ENVIO]);
  });

  it("una de un contacto sin etiquetar, no", () => {
    const otra = conversacion({
      contact: { ...conversacion().contact, id: "contact-2" },
    });
    expect(isTicket(otra, tags)).toBe(false);
    expect(ticketTagsOf(otra, tags)).toEqual([]);
  });

  it("la categoría es lo que va después del separador", () => {
    expect(ticketCategory(ENVIO)).toBe("Envío");
    expect(ticketCategory({ ...ENVIO, label: "Reclamo" })).toBe("General");
  });
});

describe("estadística de reclamos", () => {
  const tags: TicketTagsByContact = new Map([
    ["contact-1", [ENVIO]],
    ["contact-2", [ENVIO, GARANTIA]],
    ["contact-3", [GARANTIA]],
  ]);

  const conversaciones = [
    // Abierto, con el cliente esperando desde hace más de un día.
    conversacion({
      id: "abierto-callado",
      lastCustomerMessageAt: new Date(AHORA - 30 * HORA).toISOString(),
      lastMessageAt: new Date(AHORA - 30 * HORA).toISOString(),
      createdAt: new Date(AHORA - 40 * HORA).toISOString(),
    }),
    // Abierto, con dos categorías y respondido hace poco.
    conversacion({
      id: "abierto-doble",
      contact: { ...conversacion().contact, id: "contact-2" },
      createdAt: new Date(AHORA - 2 * HORA).toISOString(),
    }),
    // Resuelto.
    conversacion({
      id: "resuelto",
      contact: { ...conversacion().contact, id: "contact-3" },
      status: "closed",
    }),
    // No es reclamo: su contacto no está en el mapa.
    conversacion({
      id: "no-reclamo",
      contact: { ...conversacion().contact, id: "contact-9" },
    }),
  ];

  it("separa abiertos de resueltos y deja fuera lo que no es reclamo", () => {
    const stats = buildTicketStats(conversaciones, AHORA, tags);

    expect(stats.total).toBe(3);
    expect(stats.open).toBe(2);
    expect(stats.resolved).toBe(1);
  });

  it("cuenta una conversación en cada una de sus categorías", () => {
    const stats = buildTicketStats(conversaciones, AHORA, tags);
    const porCategoria = new Map(stats.categories.map((c) => [c.label, c]));

    // Envío: los dos abiertos. Garantía: el abierto doble y el resuelto.
    expect(porCategoria.get("Envío")?.total).toBe(2);
    expect(porCategoria.get("Garantía")?.total).toBe(2);
    expect(porCategoria.get("Garantía")?.resolved).toBe(1);
  });

  it("marca los que llevan más de 24 h sin respuesta", () => {
    const stats = buildTicketStats(conversaciones, AHORA, tags);
    expect(stats.unanswered).toBe(1);
  });

  it("la cola son los abiertos, primero el que lleva más callado", () => {
    const cola = ticketQueue(conversaciones, AHORA, tags);

    expect(cola.map((c) => c.id)).toEqual(["abierto-callado", "abierto-doble"]);
  });
});

// ---------------------------------------------------------------------------
// El contrato compartido "isStalePending y buildInboxSections miden lo
// mismo" que vivía acá se retiró con la reforma del 28/8/2026 (tarde): la
// bandeja ya no parte por la ventana de 24h —esa píldora ("pending") salió
// de inbox-sections.ts—, así que ya no hay dos relojes que puedan divergir.
// `isStalePending` sigue siendo del dashboard (`dashboard.ts`) y sus propios
// tests (arriba, en "estadística de reclamos") quedan intactos.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// El armado del mapa
// ---------------------------------------------------------------------------

function fakeSupabase(tagRows: Tag[], links: { contact_id: string; tag_id: string }[]) {
  const pedidos: { tabla: string; in?: unknown[] } = { tabla: "" };

  const client = {
    from(tabla: string) {
      pedidos.tabla = tabla;
      return {
        select() {
          if (tabla === "tags") return Promise.resolve({ data: tagRows, error: null });
          return {
            in(_column: string, values: unknown[]) {
              pedidos.in = values;
              return Promise.resolve({
                data: links.filter((l) => values.includes(l.tag_id)),
                error: null,
              });
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, pedidos };
}

describe("fetchTicketTags", () => {
  it("agrupa por contacto las etiquetas de reclamo", async () => {
    const { client } = fakeSupabase(
      [ENVIO, GARANTIA, { id: "tag-vip", label: "VIP", color: "accent" }],
      [
        { contact_id: "contact-1", tag_id: "tag-envio" },
        { contact_id: "contact-1", tag_id: "tag-gar" },
        { contact_id: "contact-2", tag_id: "tag-envio" },
      ]
    );

    const mapa = await fetchTicketTags(client);

    expect(mapa.get("contact-1")).toEqual([ENVIO, GARANTIA]);
    expect(mapa.get("contact-2")).toEqual([ENVIO]);
    expect(mapa.size).toBe(2);
  });

  it("no pregunta por las etiquetas que no son de reclamo", async () => {
    const { client, pedidos } = fakeSupabase(
      [ENVIO, { id: "tag-vip", label: "VIP", color: "accent" }],
      [{ contact_id: "contact-1", tag_id: "tag-envio" }]
    );

    await fetchTicketTags(client);

    expect(pedidos.in).toEqual(["tag-envio"]);
  });

  /**
   * El filtro se hace en TypeScript con el mismo criterio que la vista. Un
   * `ilike 'reclamo%'` en SQL habría dejado fuera esta etiqueta: Postgres
   * ignora mayúsculas, no acentos.
   */
  it("reconoce una etiqueta escrita con acento", async () => {
    const conAcento: Tag = { id: "tag-acento", label: "Réclamo · Envío", color: "danger" };
    const { client } = fakeSupabase(
      [conAcento],
      [{ contact_id: "contact-1", tag_id: "tag-acento" }]
    );

    const mapa = await fetchTicketTags(client);

    expect(mapa.get("contact-1")).toEqual([conAcento]);
  });

  it("sin etiquetas de reclamo devuelve un mapa vacío sin consultar los vínculos", async () => {
    const { client, pedidos } = fakeSupabase(
      [{ id: "tag-vip", label: "VIP", color: "accent" }],
      [{ contact_id: "contact-1", tag_id: "tag-vip" }]
    );

    const mapa = await fetchTicketTags(client);

    expect(mapa.size).toBe(0);
    expect(pedidos.in).toBeUndefined();
  });
});
