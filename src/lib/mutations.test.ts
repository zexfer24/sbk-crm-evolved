import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Contact, Message, Sale, Sticker } from "@/lib/types";
import {
  assignToMe,
  closeSaleWithContactInfo,
  createCatalogLink,
  createContactConversation,
  createInvoiceForSale,
  createLesson,
  createSticker,
  deleteCatalogLink,
  deleteLesson,
  deleteSticker,
  intervene,
  issueInvoice,
  LessonIdentityError,
  markConversationRead,
  markConversationUnread,
  pinConversation,
  saveStickerFromMessage,
  sendStickerMessage,
  setAiEnabled,
  setCatalogLinkActive,
  setLessonActive,
  unassign,
  unpinConversation,
  updateCatalogLink,
  updateProductWeight,
  voidInvoice,
  type LessonDraft,
  type SaleLineItem,
} from "@/lib/mutations";
import type { CatalogLinkDraft } from "@/lib/catalog-links";

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function createFakeSupabase() {
  const calls: { table: string; op: "insert" | "update"; payload: unknown }[] = [];
  let nextOrderId = 1;

  const client = {
    from(table: string) {
      if (table === "contacts") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "orders") {
        return {
          insert: (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return {
              select: () => ({
                single: async () => ({ data: { id: `order-${nextOrderId++}` }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "order_items") {
        return {
          insert: async (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return { error: null };
          },
        };
      }
      if (table === "conversations") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "messages") {
        return { insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { error: null }; } };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const CONTACT_DETAILS = {
  displayName: "Cliente Demo",
  cedulaType: "V" as const,
  cedulaNumber: "12345678",
  state: "Barinas",
  city: "Barinas",
  address: "Calle Falsa 123",
  paymentProofUrl: "https://example.com/proof.jpg",
  paymentMethod: "pago_movil" as const,
  saintInvoiceNumber: "00123",
};

describe("closeSaleWithContactInfo — el monto sale del catálogo, nunca de un número a mano", () => {
  /**
   * Corrección R2 (revisión `code-review high` del 19/9/2026): antes de
   * este ajuste el `if (items.length === 0)` de acá arriba ya lanzaba, pero
   * vivía suelto, desconectado de `validateSaleCart` (`sale-draft.ts`) — la
   * misma regla que corre el toast del modal. Este caso deja explícito que
   * NINGUNA fila se escribe (ni siquiera `orders`) antes del rechazo, no
   * solo que la promesa se rechaza.
   */
  it("rechaza cerrar la venta sin un solo renglón, sin escribir nada en la base", async () => {
    const { client, calls } = createFakeSupabase();
    await expect(
      closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, [], 40)
    ).rejects.toThrow(/al menos un repuesto/i);
    expect(calls).toHaveLength(0);
  });

  it("crea la orden con el total exacto de los renglones y enlaza la conversación", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
      { id: "prod-2", origin: "inventory", productId: "prod-2", description: "Kit de arrastre", unitPrice: 32.5, quantity: 2 },
    ];

    await closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, items, 40);

    const orderInsert = calls.find((c) => c.table === "orders" && c.op === "insert");
    expect(orderInsert?.payload).toMatchObject({
      contact_id: "contact-1",
      currency: "USD",
      total_amount: 83, // 18*1 + 32.5*2
      bcv_rate: 40,
    });

    const itemsInsert = calls.find((c) => c.table === "order_items" && c.op === "insert");
    expect(itemsInsert?.payload).toEqual([
      { order_id: "order-1", product_id: "prod-1", description: "Carburador PZ27", quantity: 1, unit_price: 18 },
      { order_id: "order-1", product_id: "prod-2", description: "Kit de arrastre", quantity: 2, unit_price: 32.5 },
    ]);

    const conversationUpdate = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(conversationUpdate?.payload).toMatchObject({
      deal_status: "won",
      order_id: "order-1",
    });
  });

  /**
   * T5, plan "Nada sin leer, un solo catálogo y la factura Saint"
   * (18/9/2026, D9-D11): la orden guarda el número de factura Saint
   * NORMALIZADO (recortado y sin espacios dobles), y el evento de sistema
   * lo nombra — el asesor que revisa la bitácora ya no tiene que abrir la
   * orden para saber a qué factura corresponde el cierre.
   */
  it("guarda la factura Saint normalizada y la nombra en el evento de sistema", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
    ];

    await closeSaleWithContactInfo(
      client,
      "conv-1",
      "contact-1",
      AGENT,
      { ...CONTACT_DETAILS, saintInvoiceNumber: "  00123   ABC  " },
      items,
      40
    );

    const orderInsert = calls.find((c) => c.table === "orders" && c.op === "insert");
    expect(orderInsert?.payload).toMatchObject({ saint_invoice_number: "00123 ABC" });

    const messageInsert = calls.find((c) => c.table === "messages" && c.op === "insert");
    const payload = messageInsert?.payload as { content?: string } | undefined;
    expect(payload?.content).toContain("Factura Saint 00123 ABC");
  });

  /**
   * Segunda barrera de D10: la misma regla del modal (`validateSaleDraft`)
   * corre acá y lanza ANTES de tocar la base — un llamador que se saltara
   * la validación del modal (o un bug futuro en él) no deja una venta a
   * medias escrita.
   */
  it("sin factura Saint lanza antes de escribir nada en la base", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
    ];

    await expect(
      closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, { ...CONTACT_DETAILS, saintInvoiceNumber: "   " }, items, 40)
    ).rejects.toThrow(/factura saint/i);
    expect(calls).toHaveLength(0);
  });

  it("sin comprobante de pago lanza antes de escribir nada en la base", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
    ];

    await expect(
      closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, { ...CONTACT_DETAILS, paymentProofUrl: null }, items, 40)
    ).rejects.toThrow(/comprobante/i);
    expect(calls).toHaveLength(0);
  });
});

/**
 * Apartar un chat y volver a darlo por leído son la misma acción invertida.
 * Lo que estos tests fijan es que ninguna de las dos toque `unread_count`
 * para mentir: apartar no inventa un mensaje, y dar por leído sí tiene que
 * limpiar las dos señales a la vez —si no, un chat apartado seguiría en
 * "Sin leer" para siempre después de abrirlo.
 */
describe("marcar una conversación como no leída", () => {
  it("aparta el chat sin tocar el contador de mensajes sin leer", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationUnread(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ manually_unread: true });
  });

  it("darla por leída limpia el contador y el apartado a la vez", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationRead(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ unread_count: 0, manually_unread: false });
  });
});

/**
 * T2.2 del plan "La bandeja que no pierde" (5/9/2026): hasta tres chats
 * fijados por asesor. `pinConversation`/`unpinConversation` no arman la
 * regla del tope de tres —eso vive en el trigger
 * `conversation_pins_limit_before_insert` de la migración
 * 20260905040000_conversation_pins.sql, y lo verifica `supabase/tests/pins.sql`
 * contra la base real—; lo único que estos tests fijan es que el par
 * agente/conversación viaja tal cual a la tabla, y que un error de la base
 * (el del cuarto pin, u otro cualquiera) sube sin que la función lo trague.
 */
/**
 * T7, corrida "La IA ve lo que llega" (8/9/2026): human-handled.ts dejó de
 * preguntar "¿alguna vez escribió un asesor?" y pasó a comparar fechas, así
 * que estas dos mutaciones ya no dependen de nada más que de sus columnas
 * propias para devolver un chat a la IA — no tocan `messages`, no tocan
 * fechas. Lo único que fijan estos tests es que el UPDATE de `conversations`
 * lleva EXACTAMENTE esa columna y ninguna otra: si algún día empezara a
 * escribir también, por ejemplo, `last_customer_message_at` a mano, rompería
 * los dos candados documentados en CLAUDE.md sobre esa columna.
 */
describe("setAiEnabled — devuelve el chat a la IA sin tocar messages", () => {
  it("setAiEnabled(true) actualiza SOLO ai_enabled", async () => {
    const { client, calls } = createFakeSupabase();

    await setAiEnabled(client, "conv-1", AGENT, true);

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ ai_enabled: true });
  });
});

/**
 * T10, plan "Seba sale sin pisar a nadie" (19/9/2026, decisión D-A):
 * `assignToMe` e `intervene` apagan a Seba al tomar un chat a mano con DOS
 * UPDATE en serie sobre `conversations` — nunca uno conjunto. El trigger
 * `handle_conversation_ownership_change` (migración 20260917010000) solo
 * escribe la fila `reclamado` si `ai_enabled` NO cambia en el MISMO UPDATE
 * que `assigned_agent_id`, y solo escribe `silenciada_por_asesor` si
 * `assigned_agent_id` NO cambia en el MISMO UPDATE que `ai_enabled`: un
 * UPDATE conjunto no dejaría NINGUNA fila en `conversation_handoffs`,
 * contra la invariante "ningún lead invisible" (CLAUDE.md). El caso SQL
 * equivalente (asignar con sesión real, después apagar) vive en
 * `supabase/tests/seba_y_escalada_viva.sql`.
 *
 * Corrección post-revisión (`code-review high`, 19/9/2026): la primera
 * versión lanzaba directo si el segundo UPDATE (`ai_enabled = false`)
 * fallaba, sin compensación — un corte de red ahí dejaba el chat ASIGNADO
 * con Seba ENCENDIDA, el mismo bug C1 que esta tarea existe para cerrar.
 * Los casos de abajo cubren el reintento único y la compensación de mejor
 * esfuerzo (volver `assigned_agent_id` al valor previo a la toma manual).
 */
describe("assignToMe / intervene — apagan a Seba con DOS UPDATE en serie (T10, 19/9/2026)", () => {
  /**
   * `updateResults` describe, EN ORDEN, el error (o `null`) que devuelve
   * cada UPDATE sucesivo sobre `conversations` dentro de una sola llamada a
   * `assignToMe`/`intervene`: [asignar, apagar-intento-1, apagar-intento-2
   * (solo si el 1 falla), revertir-compensación (solo si el 2 falla)].
   * `select` (leer `assigned_agent_id` previo) se registra aparte, con
   * `op: "select"`, y no consume `updateResults`.
   */
  function createFakeConversationsSupabase(
    options: { previousAssignedAgentId?: string | null; updateResults?: (Error | null)[] } = {}
  ) {
    const calls: { table: string; op: "select" | "update"; payload?: Record<string, unknown> }[] = [];
    const updateResults = options.updateResults ?? [];
    let updateCallIndex = 0;
    const client = {
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => {
                  calls.push({ table, op: "select" });
                  return {
                    data: { assigned_agent_id: options.previousAssignedAgentId ?? null },
                    error: null,
                  };
                },
              }),
            }),
            update: (payload: Record<string, unknown>) => ({
              eq: async () => {
                calls.push({ table, op: "update", payload });
                const error = updateResults[updateCallIndex] ?? null;
                updateCallIndex += 1;
                return { error };
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            insert: async (payload: unknown) => {
              calls.push({ table, op: "update", payload: payload as Record<string, unknown> });
              return { error: null };
            },
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  function conversationUpdatesOf(calls: { table: string; op: "select" | "update"; payload?: Record<string, unknown> }[]) {
    return calls.filter((c) => c.table === "conversations" && c.op === "update");
  }

  it("assignToMe lee el asesor previo, hace dos UPDATE en orden y recién entonces deja la nota", async () => {
    const { client, calls } = createFakeConversationsSupabase();

    await assignToMe(client, "conv-1", AGENT);

    expect(calls[0]).toEqual({ table: "conversations", op: "select" });
    const conversationUpdates = conversationUpdatesOf(calls);
    expect(conversationUpdates).toHaveLength(2);
    expect(conversationUpdates[0].payload).toEqual({ assigned_agent_id: "agent-1" });
    expect(conversationUpdates[1].payload).toEqual({ ai_enabled: false });

    // La nota de sistema llega DESPUÉS del select y los dos UPDATE.
    expect(calls[3].table).toBe("messages");
  });

  it("intervene hace dos UPDATE en orden: primero assigned_agent_id, después ai_enabled = false", async () => {
    const { client, calls } = createFakeConversationsSupabase();

    await intervene(client, "conv-1", AGENT);

    const conversationUpdates = conversationUpdatesOf(calls);
    expect(conversationUpdates).toHaveLength(2);
    expect(conversationUpdates[0].payload).toEqual({ assigned_agent_id: "agent-1" });
    expect(conversationUpdates[1].payload).toEqual({ ai_enabled: false });
  });

  it("assignToMe: si falla el primer UPDATE (assigned_agent_id), lanza antes de leer/apagar la IA", async () => {
    const { client, calls } = createFakeConversationsSupabase({
      updateResults: [new Error("no se pudo asignar")],
    });

    await expect(assignToMe(client, "conv-1", AGENT)).rejects.toThrow(/no se pudo asignar/i);

    const conversationUpdates = conversationUpdatesOf(calls);
    expect(conversationUpdates).toHaveLength(1);
    expect(conversationUpdates[0].payload).toEqual({ assigned_agent_id: "agent-1" });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("assignToMe: si el UPDATE de ai_enabled falla UNA vez, el reintento pasa — no lanza y deja la nota de sistema", async () => {
    const { client, calls } = createFakeConversationsSupabase({
      updateResults: [null, new Error("corte de red transitorio"), null],
    });

    await assignToMe(client, "conv-1", AGENT);

    const conversationUpdates = conversationUpdatesOf(calls);
    // assignar + dos intentos de apagar (el primero falla, el segundo pasa)
    // — sin una tercera fila de compensación, porque no hizo falta.
    expect(conversationUpdates).toHaveLength(3);
    expect(conversationUpdates[1].payload).toEqual({ ai_enabled: false });
    expect(conversationUpdates[2].payload).toEqual({ ai_enabled: false });
    expect(calls.some((c) => c.table === "messages")).toBe(true);
  });

  it("assignToMe: si el UPDATE de ai_enabled falla DOS veces, revierte assigned_agent_id al valor previo (null) y lanza — sin nota de sistema", async () => {
    const originalError = new Error("no se pudo apagar la ia");
    const { client, calls } = createFakeConversationsSupabase({
      previousAssignedAgentId: null,
      updateResults: [null, originalError, originalError, null],
    });

    await expect(assignToMe(client, "conv-1", AGENT)).rejects.toBe(originalError);

    const conversationUpdates = conversationUpdatesOf(calls);
    // asignar + dos intentos de apagar + la compensación que revierte.
    expect(conversationUpdates).toHaveLength(4);
    expect(conversationUpdates[3].payload).toEqual({ assigned_agent_id: null });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("intervene: si el UPDATE de ai_enabled falla DOS veces, revierte assigned_agent_id al asesor previo DISTINTO y lanza", async () => {
    const originalError = new Error("no se pudo apagar la ia");
    const { client, calls } = createFakeConversationsSupabase({
      previousAssignedAgentId: "agent-2",
      updateResults: [null, originalError, originalError, null],
    });

    await expect(intervene(client, "conv-1", AGENT)).rejects.toBe(originalError);

    const conversationUpdates = conversationUpdatesOf(calls);
    expect(conversationUpdates).toHaveLength(4);
    expect(conversationUpdates[0].payload).toEqual({ assigned_agent_id: "agent-1" });
    // La compensación vuelve al asesor que tenía el chat ANTES de intervenir,
    // no a `null` — intervenir puede quitarle el chat a otro asesor.
    expect(conversationUpdates[3].payload).toEqual({ assigned_agent_id: "agent-2" });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("assignToMe: si además falla la compensación, lanza el error ORIGINAL (no el de la compensación) y avisa por console.error", async () => {
    const originalError = new Error("no se pudo apagar la ia");
    const compensationError = new Error("no se pudo revertir");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = createFakeConversationsSupabase({
        previousAssignedAgentId: null,
        updateResults: [null, originalError, originalError, compensationError],
      });

      await expect(assignToMe(client, "conv-1", AGENT)).rejects.toBe(originalError);

      expect(calls.some((c) => c.table === "messages")).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

/**
 * T11 (19/9/2026): corrección del hallazgo #2 de la revisión `/code-review
 * high` sobre el plan "Seba sale sin pisar a nadie" (decisión abierta #2
 * del plan). `unassign` lee `assigned_at`/`ai_enabled`/`status` ANTES de
 * desasignar y, si el chat estaba tomado a mano con la IA apagada (T10),
 * sin cerrar, con `assigned_at` real, con una fila `silenciada_por_asesor`
 * POSTERIOR a `assigned_at` (la que dejó el propio tomar-a-mano de T10, no
 * una pausa manual de antes de asignarse) y SIN que el asesor le haya
 * escrito de verdad al cliente desde entonces, hace un SEGUNDO UPDATE
 * aparte que reenciende `ai_enabled` — mismo motivo de "dos UPDATE en
 * serie" que T10 (el trigger `handle_conversation_ownership_change`
 * necesita que cada columna cambie en su propio UPDATE para dejar la fila
 * correcta en `conversation_handoffs`).
 *
 * Ajuste del mismo día (corrección del orquestador sobre la primera
 * versión de T11): sin la condición de `conversation_handoffs`, una pausa
 * manual de ANTES de asignarse el chat (`setAiEnabled(false)` seguido,
 * más tarde, de "Asignarme") se reencendía igual al desasignar sin haber
 * escrito — pisando una decisión explícita de un supervisor.
 */
describe("unassign — reenciende la IA solo si fue el propio tomar-a-mano y el asesor nunca le escribió al cliente (T11, 19/9/2026)", () => {
  const ASSIGNED_AT = "2026-09-19T10:00:00.000Z";

  /**
   * `conversationRow` describe lo que devuelve la lectura previa
   * (`assigned_at`/`ai_enabled`/`status`); `conversationReadError`, en su
   * lugar, hace fallar esa lectura. `handoffsResult` describe la respuesta
   * de la consulta que busca una fila `silenciada_por_asesor` posterior a
   * `assigned_at` — por defecto trae una (el caso común: la IA se apagó
   * por el propio tomar-a-mano), así que los tests que no la mencionan
   * ejercitan el camino "sí, fue el tomar-a-mano" sin tener que repetirlo.
   * `messagesResult` describe la respuesta de la consulta que busca un
   * mensaje real de asesor desde `assigned_at`. `secondUpdateError` hace
   * fallar SOLO el segundo UPDATE (`ai_enabled: true`); el primero
   * (`assigned_agent_id: null`) usa `firstUpdateError`.
   */
  function createFakeSupabaseForUnassign(
    options: {
      conversationRow?: { assigned_at: string | null; ai_enabled: boolean; status: string };
      conversationReadError?: Error;
      handoffsResult?: { data: { id: string }[] | null; error: Error | null };
      messagesResult?: { data: { id: string }[] | null; error: Error | null };
      firstUpdateError?: Error;
      secondUpdateError?: Error;
    } = {}
  ) {
    const calls: Array<
      | { table: "conversations"; op: "select" }
      | {
          table: "conversations";
          op: "update";
          payload: Record<string, unknown>;
          // D (20/9/2026, corrida "El resguardo antes del push"): el fake
          // no distinguía operador — quitar el `.is(...)` del UPDATE de
          // reencendido pasaba en verde igual. Ahora cada filtro de la
          // cadena (`.eq`/`.is`/`.neq`) queda registrado en orden con su
          // operador, columna y valor, para poder assertar los tres juntos.
          filters: Array<{ op: "eq" | "is" | "neq"; column: string; value: unknown }>;
        }
      | { table: "conversation_handoffs"; op: "select"; filters: Record<string, unknown> }
      | { table: "messages"; op: "select"; filters: Record<string, unknown> }
      | { table: "messages"; op: "insert"; payload: unknown }
    > = [];

    const client = {
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => {
                  calls.push({ table, op: "select" });
                  if (options.conversationReadError) {
                    return { data: null, error: options.conversationReadError };
                  }
                  return {
                    data: options.conversationRow ?? { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
                    error: null,
                  };
                },
              }),
            }),
            update: (payload: Record<string, unknown>) => {
              const filters: Array<{ op: "eq" | "is" | "neq"; column: string; value: unknown }> = [];
              const run = async () => {
                calls.push({ table, op: "update", payload, filters });
                if ("assigned_agent_id" in payload && options.firstUpdateError) {
                  return { error: options.firstUpdateError };
                }
                if ("ai_enabled" in payload && options.secondUpdateError) {
                  return { error: options.secondUpdateError };
                }
                return { error: null };
              };
              // Encadenable como el builder real de Supabase: cada filtro
              // devuelve el mismo builder (para poder seguir encadenando)
              // y el builder es "thenable" en cualquier punto de la cadena
              // (así `await update(...).eq(...)` sigue funcionando igual
              // que antes de sumar `.is`/`.neq`).
              const builder = {
                eq: (column: string, value: unknown) => {
                  filters.push({ op: "eq", column, value });
                  return builder;
                },
                is: (column: string, value: unknown) => {
                  filters.push({ op: "is", column, value });
                  return builder;
                },
                neq: (column: string, value: unknown) => {
                  filters.push({ op: "neq", column, value });
                  return builder;
                },
                then: (onFulfilled: (v: { error: Error | null }) => unknown, onRejected?: (e: unknown) => unknown) =>
                  run().then(onFulfilled, onRejected),
              };
              return builder;
            },
          };
        }
        if (table === "conversation_handoffs") {
          return {
            select: () => {
              const filters: Record<string, unknown> = {};
              const chain = {
                eq(col: string, val: unknown) {
                  filters[col] = val;
                  return chain;
                },
                gte(col: string, val: unknown) {
                  filters[col] = val;
                  return chain;
                },
                limit: async () => {
                  calls.push({ table: "conversation_handoffs", op: "select", filters });
                  return options.handoffsResult ?? { data: [{ id: "handoff-1" }], error: null };
                },
              };
              return chain;
            },
          };
        }
        if (table === "messages") {
          return {
            select: () => {
              const filters: Record<string, unknown> = {};
              const chain = {
                eq(col: string, val: unknown) {
                  filters[col] = val;
                  return chain;
                },
                gte(col: string, val: unknown) {
                  filters[col] = val;
                  return chain;
                },
                limit: async () => {
                  calls.push({ table: "messages", op: "select", filters });
                  return options.messagesResult ?? { data: [], error: null };
                },
              };
              return chain;
            },
            insert: async (payload: unknown) => {
              calls.push({ table: "messages", op: "insert", payload });
              return { error: null };
            },
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  function conversationUpdatesOf(calls: ReturnType<typeof createFakeSupabaseForUnassign>["calls"]) {
    return calls.filter((c) => c.table === "conversations" && c.op === "update") as {
      table: "conversations";
      op: "update";
      payload: Record<string, unknown>;
      filters: Array<{ op: "eq" | "is" | "neq"; column: string; value: unknown }>;
    }[];
  }

  it("caso 1 — tomado a mano (fila silenciada_por_asesor posterior a assigned_at), sin escribirle al cliente: dos UPDATE, desasignar y reencender", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
      handoffsResult: { data: [{ id: "handoff-1" }], error: null },
      messagesResult: { data: [], error: null },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(2);
    expect(updates[0].payload).toEqual({ assigned_agent_id: null });
    expect(updates[1].payload).toEqual({ ai_enabled: true });

    // D (20/9/2026): el UPDATE que reenciende a Seba no se escribe a
    // ciegas — condiciona `id`, `assigned_agent_id is null` y
    // `status <> closed` para no pisar a un asesor que tomó el chat, o un
    // cierre, ocurridos en la ventana de las 4 idas y vueltas HTTP de
    // arriba.
    expect(updates[1].filters).toEqual([
      { op: "eq", column: "id", value: "conv-1" },
      { op: "is", column: "assigned_agent_id", value: null },
      { op: "neq", column: "status", value: "closed" },
    ]);

    // La consulta de conversation_handoffs busca la fila que deja el
    // segundo UPDATE de silenceAiForManualTakeover (T10): mismo reason,
    // posterior o igual a assigned_at.
    const handoffsSelect = calls.find((c) => c.table === "conversation_handoffs" && c.op === "select");
    expect(handoffsSelect && "filters" in handoffsSelect ? handoffsSelect.filters : null).toEqual({
      conversation_id: "conv-1",
      reason: "silenciada_por_asesor",
      created_at: ASSIGNED_AT,
    });

    // La consulta de mensajes usa el MISMO predicado que apaga la IA por
    // trigger (handle_agent_message_silences_ai): sender_type='agent',
    // direction='outbound', is_internal_note=false, desde assigned_at.
    const messagesSelect = calls.find((c) => c.table === "messages" && c.op === "select");
    expect(messagesSelect && "filters" in messagesSelect ? messagesSelect.filters : null).toEqual({
      conversation_id: "conv-1",
      sender_type: "agent",
      direction: "outbound",
      is_internal_note: false,
      created_at: ASSIGNED_AT,
    });

    expect(calls.some((c) => c.table === "messages" && c.op === "insert")).toBe(true);
  });

  it("caso 2 — el asesor SÍ le escribió al cliente después de assigned_at: un solo UPDATE, no reenciende", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
      messagesResult: { data: [{ id: "msg-1" }], error: null },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ assigned_agent_id: null });
  });

  it("caso 3 — ai_enabled ya estaba en true (Seba escaló, nadie la apagó): un solo UPDATE, ni siquiera consulta handoffs/messages", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: true, status: "open" },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ assigned_agent_id: null });
    expect(calls.some((c) => c.table === "conversation_handoffs")).toBe(false);
    expect(calls.some((c) => c.table === "messages" && c.op === "select")).toBe(false);
  });

  it("caso 4 — la conversación está cerrada: un solo UPDATE", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "closed" },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(calls.some((c) => c.table === "conversation_handoffs")).toBe(false);
    expect(calls.some((c) => c.table === "messages" && c.op === "select")).toBe(false);
  });

  it("caso 5 — assigned_at es null: un solo UPDATE", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: null, ai_enabled: false, status: "open" },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(calls.some((c) => c.table === "conversation_handoffs")).toBe(false);
    expect(calls.some((c) => c.table === "messages" && c.op === "select")).toBe(false);
  });

  it("caso 6 — falla la lectura de mensajes: un solo UPDATE, no lanza, avisa por console.error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = createFakeSupabaseForUnassign({
        conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
        messagesResult: { data: null, error: new Error("corte de red") },
      });

      await expect(unassign(client, "conv-1", AGENT, "María")).resolves.toBeUndefined();

      const updates = conversationUpdatesOf(calls);
      expect(updates).toHaveLength(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("caso 7 — falla el segundo UPDATE (ai_enabled=true): no lanza, la desasignación queda hecha, avisa por console.error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = createFakeSupabaseForUnassign({
        conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
        messagesResult: { data: [], error: null },
        secondUpdateError: new Error("no se pudo reencender"),
      });

      await expect(unassign(client, "conv-1", AGENT, "María")).resolves.toBeUndefined();

      const updates = conversationUpdatesOf(calls);
      expect(updates).toHaveLength(2);
      expect(updates[0].payload).toEqual({ assigned_agent_id: null });
      expect(updates[1].payload).toEqual({ ai_enabled: true });
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("caso 8 — falla el primer UPDATE (assigned_agent_id): lanza como hoy, sin segundo UPDATE ni nota", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
      firstUpdateError: new Error("no se pudo desasignar"),
    });

    await expect(unassign(client, "conv-1", AGENT, "María")).rejects.toThrow(/no se pudo desasignar/i);

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(calls.some((c) => c.table === "messages" && c.op === "insert")).toBe(false);
  });

  it("una nota interna posterior a assigned_at no cuenta como haberle escrito al cliente: la consulta la excluye por is_internal_note=false", async () => {
    // Una nota interna real quedaría filtrada por is_internal_note=false en
    // la propia consulta (Postgres, no en memoria): acá se verifica que la
    // consulta manda ese filtro, y que con la tabla vacía de mensajes NO
    // internos ni de otro sentido (simulando que la única fila era la nota,
    // que el filtro ya descartó) sí reenciende.
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
      messagesResult: { data: [], error: null },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const messagesSelect = calls.find((c) => c.table === "messages" && c.op === "select");
    expect(messagesSelect && "filters" in messagesSelect ? messagesSelect.filters.is_internal_note : undefined).toBe(false);

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toEqual({ ai_enabled: true });
  });

  it("conversationRow ausente (lectura previa falló): no lanza, un solo UPDATE, no reenciende", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = createFakeSupabaseForUnassign({
        conversationReadError: new Error("corte de red al leer"),
      });

      await expect(unassign(client, "conv-1", AGENT, "María")).resolves.toBeUndefined();

      const updates = conversationUpdatesOf(calls);
      expect(updates).toHaveLength(1);
      expect(updates[0].payload).toEqual({ assigned_agent_id: null });
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  /**
   * Caso (a) del ajuste del orquestador: una pausa manual de ANTES de
   * asignarse el chat (`setAiEnabled(false)`, o cualquier otro camino que
   * deje `silenciada_por_asesor`) no debe reencenderse al desasignar sin
   * haber escrito — esa fila queda ANTERIOR a `assigned_at`, así que la
   * consulta con `created_at >= assigned_at` no la encuentra, y en el fake
   * eso se simula con `handoffsResult: { data: [], error: null }` (como si
   * el filtro de la base ya la hubiera descartado).
   */
  it("caso (a) — pausa manual ANTERIOR a assigned_at, tomado y desasignado sin escribir: un solo UPDATE, no reenciende", async () => {
    const { client, calls } = createFakeSupabaseForUnassign({
      conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
      handoffsResult: { data: [], error: null },
    });

    await unassign(client, "conv-1", AGENT, "María");

    const updates = conversationUpdatesOf(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ assigned_agent_id: null });
    // Sin una fila silenciada_por_asesor posterior a assigned_at, ni
    // siquiera vale la pena preguntar si el asesor escribió.
    expect(calls.some((c) => c.table === "messages" && c.op === "select")).toBe(false);
  });

  /** Caso (b): cubierto por el caso 1 de arriba (fila posterior a assigned_at → reenciende). */

  it("caso (c) — falla la lectura de conversation_handoffs: un solo UPDATE, no lanza, avisa por console.error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = createFakeSupabaseForUnassign({
        conversationRow: { assigned_at: ASSIGNED_AT, ai_enabled: false, status: "open" },
        handoffsResult: { data: null, error: new Error("corte de red") },
      });

      await expect(unassign(client, "conv-1", AGENT, "María")).resolves.toBeUndefined();

      const updates = conversationUpdatesOf(calls);
      expect(updates).toHaveLength(1);
      // Falla antes de llegar a preguntar por los mensajes.
      expect(calls.some((c) => c.table === "messages" && c.op === "select")).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("pinConversation / unpinConversation", () => {
  function createFakePinsSupabase() {
    const calls: { op: "insert" | "delete"; agentId: string; conversationId: string }[] = [];

    const client = {
      from(table: string) {
        if (table !== "conversation_pins") {
          throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        }
        return {
          insert: async (payload: { agent_id: string; conversation_id: string }) => {
            calls.push({ op: "insert", agentId: payload.agent_id, conversationId: payload.conversation_id });
            return { error: null };
          },
          delete: () => ({
            eq: (_col1: string, agentId: string) => ({
              eq: async (_col2: string, conversationId: string) => {
                calls.push({ op: "delete", agentId, conversationId });
                return { error: null };
              },
            }),
          }),
        };
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("fija: inserta el par agente/conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await pinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "insert", agentId: "agent-1", conversationId: "conv-9" }]);
  });

  it("propaga el error del cuarto pin en vez de tragárselo", async () => {
    const client = {
      from: () => ({
        insert: async () => ({
          error: new Error("Ya tenés tres conversaciones fijadas. Desfijá una para poder fijar esta."),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(pinConversation(client, "agent-1", "conv-9")).rejects.toThrow(/tres conversaciones fijadas/);
  });

  it("desfija: borra por agente Y conversación, no solo por conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await unpinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "delete", agentId: "agent-1", conversationId: "conv-9" }]);
  });
});

/**
 * T4 del plan "Seis frentes del buzón" (8/9/2026): peso en kilos para
 * Cashea. El UPDATE lleva la columna y `updated_at` — nada más — y `null` es
 * un guardado legítimo (vuelve a dejar el repuesto "sin cargar"). Hasta el
 * 19/9/2026 este comentario decía "igual que `updateProductPrice`": esa
 * mutación se borró ese día ("El precio se lee en bolívares") sin dejar test
 * propio en este archivo — nunca lo tuvo.
 */
describe("updateProductWeight", () => {
  function createFakeProductsSupabase() {
    const calls: { table: string; payload: unknown; productId: string }[] = [];
    const client = {
      from(table: string) {
        if (table !== "products") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        return {
          update: (payload: unknown) => ({
            eq: async (_col: string, productId: string) => {
              calls.push({ table, payload, productId });
              return { error: null };
            },
          }),
        };
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  it("manda weight_kg y updated_at", async () => {
    const { client, calls } = createFakeProductsSupabase();

    await updateProductWeight(client, "prod-1", 0.25);

    expect(calls).toHaveLength(1);
    expect(calls[0].productId).toBe("prod-1");
    expect(calls[0].payload).toMatchObject({ weight_kg: 0.25 });
    expect(calls[0].payload).toHaveProperty("updated_at");
  });

  it("guardar null vuelve a dejar el repuesto sin peso cargado", async () => {
    const { client, calls } = createFakeProductsSupabase();

    await updateProductWeight(client, "prod-1", null);

    expect(calls[0].payload).toMatchObject({ weight_kg: null });
  });

  it("propaga el error de la base en vez de tragárselo", async () => {
    const client = {
      from: () => ({ update: () => ({ eq: async () => ({ error: new Error("no se pudo guardar") }) }) }),
    } as unknown as SupabaseClient;

    await expect(updateProductWeight(client, "prod-1", 1)).rejects.toThrow(/no se pudo guardar/);
  });
});

/**
 * "Lecciones de Seba" (T5, plan "Seba atiende el mostrador", 18/9/2026,
 * requisito 7 del cliente): createLesson/setLessonActive/deleteLesson.
 * Mismo patrón que `ai_playbooks` un poco más arriba en este archivo
 * (createPlaybook/setPlaybookActive/deletePlaybook), sin tests propios ahí
 * todavía — este describe es el primero de ese patrón en este archivo.
 */
describe("createLesson / setLessonActive / deleteLesson — Lecciones de Seba (T5, 18/9/2026)", () => {
  function createLessonFakeSupabase() {
    const calls: { op: "insert" | "update" | "delete"; payload?: unknown; id?: string }[] = [];
    const client = {
      from(table: string) {
        if (table !== "ai_lessons") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        return {
          insert: (payload: Record<string, unknown>) => {
            calls.push({ op: "insert", payload });
            return Promise.resolve({ error: null });
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              calls.push({ op: "update", payload, id });
              return { error: null };
            },
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              calls.push({ op: "delete", id });
              return { error: null };
            },
          }),
        };
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  const LESSON_AGENT: Agent = {
    id: "agent-9",
    displayName: "Marta",
    fullName: "Marta Gómez",
    avatarUrl: null,
    role: "agent",
    isActive: true,
  };

  function lessonDraft(overrides: Partial<LessonDraft> = {}): LessonDraft {
    return {
      scope: "global",
      kind: "nota",
      content: "El repuesto XYZ también sirve para la Bera R1.",
      synonymFrom: null,
      synonymTo: null,
      messageId: null,
      messageExcerpt: null,
      conversationId: null,
      contactId: null,
      ...overrides,
    };
  }

  it("createLesson inserta con created_by = agent.id", async () => {
    const { client, calls } = createLessonFakeSupabase();

    await createLesson(client, LESSON_AGENT, lessonDraft());

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("insert");
    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.created_by).toBe("agent-9");
    expect(payload.content).toBe("El repuesto XYZ también sirve para la Bera R1.");
    expect(payload.scope).toBe("global");
    expect(payload.kind).toBe("nota");
  });

  /**
   * El `message_excerpt` es solo contexto de dónde salió la lección: se
   * recorta a 80 caracteres antes de insertar, aunque el CHECK de la base
   * permita hasta 200 (`ai_lessons_message_excerpt_length`).
   */
  it("recorta message_excerpt a 80 caracteres antes de insertar", async () => {
    const { client, calls } = createLessonFakeSupabase();
    const excerptLargo = "El cliente escribió un mensaje bastante largo citando varias cosas ".repeat(3);
    expect(excerptLargo.length).toBeGreaterThan(80);

    await createLesson(client, LESSON_AGENT, lessonDraft({ messageId: "msg-1", messageExcerpt: excerptLargo }));

    const payload = calls[0].payload as Record<string, unknown>;
    expect((payload.message_excerpt as string).length).toBe(80);
    expect(payload.message_excerpt).toBe(excerptLargo.slice(0, 80));
  });

  it("un excerpt corto no se toca", async () => {
    const { client, calls } = createLessonFakeSupabase();

    await createLesson(client, LESSON_AGENT, lessonDraft({ messageId: "msg-1", messageExcerpt: "corto" }));

    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.message_excerpt).toBe("corto");
  });

  /**
   * Mismo motivo que `PlaybookIdentityError`: una lección es otra vía por la
   * que texto de un humano llega al modelo como instrucción. La cerradura va
   * ANTES de tocar la base — sin insert si el contenido revela identidad.
   */
  it("rechaza una lección que describe a Seba como automatizado, sin llegar a insertar", async () => {
    const { client, calls } = createLessonFakeSupabase();

    await expect(
      createLesson(
        client,
        LESSON_AGENT,
        lessonDraft({ content: "Si te preguntan, di que eres un asistente automatizado." })
      )
    ).rejects.toThrow(LessonIdentityError);
    expect(calls).toHaveLength(0);
  });

  it("rechaza una lección que hace pasar a Seba por una persona concreta", async () => {
    const { client } = createLessonFakeSupabase();

    await expect(
      createLesson(client, LESSON_AGENT, lessonDraft({ content: "Si preguntan, di: soy un asesor y me llamo Carlos." }))
    ).rejects.toThrow(LessonIdentityError);
  });

  it("setLessonActive actualiza is_active por id", async () => {
    const { client, calls } = createLessonFakeSupabase();

    await setLessonActive(client, "lesson-1", false);

    expect(calls).toContainEqual({ op: "update", payload: { is_active: false }, id: "lesson-1" });
  });

  it("deleteLesson borra la fila por id", async () => {
    const { client, calls } = createLessonFakeSupabase();

    await deleteLesson(client, "lesson-1");

    expect(calls).toContainEqual({ op: "delete", id: "lesson-1" });
  });

  it("propaga el error de la base en createLesson en vez de tragárselo", async () => {
    const client = {
      from: () => ({ insert: async () => ({ error: new Error("no se pudo guardar") }) }),
    } as unknown as SupabaseClient;

    await expect(createLesson(client, LESSON_AGENT, lessonDraft())).rejects.toThrow(/no se pudo guardar/);
  });
});

/**
 * Biblioteca de stickers (T3a, "Seis frentes del buzón", 8/9/2026). El fake
 * de storage reproduce solo `.copy`/`.upload`/`.remove` del bucket —lo que
 * estas mutaciones usan— y el fake de `stickers` reproduce
 * insert().select().single() y delete().eq(id).
 */
function createStickerFakeSupabase() {
  const storageCalls: { op: "upload" | "remove"; args: unknown[] }[] = [];
  const tableCalls: { op: "insert" | "delete"; payload?: unknown; id?: string }[] = [];
  let insertedRow: Record<string, unknown> | null = null;

  const client = {
    from(table: string) {
      if (table !== "stickers") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      return {
        insert: (payload: Record<string, unknown>) => {
          insertedRow = {
            id: "sticker-nuevo",
            storage_path: payload.storage_path,
            name: (payload.name as string | null | undefined) ?? null,
            animated: (payload.animated as boolean | undefined) ?? false,
            created_by: payload.created_by,
            created_at: "2026-09-09T12:00:00.000Z",
          };
          tableCalls.push({ op: "insert", payload });
          return {
            select: () => ({
              single: async () => ({ data: insertedRow, error: null }),
            }),
          };
        },
        delete: () => ({
          eq: async (_col: string, id: string) => {
            tableCalls.push({ op: "delete", id });
            return { error: null };
          },
        }),
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: unknown, opts: unknown) => {
          storageCalls.push({ op: "upload", args: [bucket, path, file, opts] });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          storageCalls.push({ op: "remove", args: [bucket, paths] });
          return { error: null };
        },
      }),
    },
  };

  return { client: client as unknown as SupabaseClient, storageCalls, tableCalls };
}

/**
 * Arma bytes de un WebP mínimo (T2, "Ponele balanza a la biblioteca",
 * 8/9/2026): cabecera `RIFF`/tamaño/`WEBP` + chunk `VP8X` con el bit ANIM
 * (`0x02`) prendido o apagado en el byte de flags (offset 20), rellenado
 * hasta `totalBytes` — lo mínimo que `isAnimatedWebp` necesita para decidir,
 * más relleno para simular el peso real del caso que el test necesita.
 */
function buildWebpBytes(totalBytes: number, animated: boolean): Uint8Array {
  const bytes = new Uint8Array(Math.max(totalBytes, 21));
  const escribirFourCC = (offset: number, cc: string) => {
    for (let i = 0; i < 4; i++) bytes[offset + i] = cc.charCodeAt(i);
  };
  escribirFourCC(0, "RIFF");
  escribirFourCC(8, "WEBP");
  escribirFourCC(12, "VP8X");
  bytes[20] = animated ? 0x02 : 0x00;
  return bytes;
}

function stubFetchConArchivo(bytes: Uint8Array) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    }))
  );
}

const STICKER_AGENT: Agent = {
  id: "agent-42",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function stickerSourceMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-sticker-1",
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "sticker",
    content: null,
    templateName: null,
    mediaUrl: "/api/media/inbound/conv-1/original.webp",
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: "2026-09-09T11:00:00.000Z",
    ...overrides,
  };
}

describe("saveStickerFromMessage — guardar el sticker de un mensaje recibido", () => {
  it("descarga el sticker por la ruta propia, lo sube a stickers/<uuid>.webp e inserta la fila con source_message_id", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(60 * 1024, false);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      // No hay .copy: ahora el único camino es bajar los bytes (para
      // pesarlos y detectar animación) y subirlos.
      const uploadCall = storageCalls.find((c) => c.op === "upload");
      expect(uploadCall).toBeDefined();
      expect(String(uploadCall?.args[1])).toMatch(/^stickers\/.+\.webp$/);
      expect(uploadCall?.args[3]).toMatchObject({ contentType: "image/webp" });

      expect(tableCalls[0]).toMatchObject({
        op: "insert",
        payload: {
          created_by: "agent-42",
          source_message_id: "msg-sticker-1",
          animated: false,
        },
      });
      expect(sticker.id).toBe("sticker-nuevo");
      expect(sticker.url).toMatch(/^\/api\/media\/stickers\//);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker animado de 973.668 bytes (el caso real del 131053 de Meta) se rechaza sin escribir nada", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(973668, true);
    stubFetchConArchivo(bytes);

    try {
      let error: unknown;
      try {
        await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      const mensaje = (error as Error).message;
      expect(mensaje).toMatch(/animado/i);
      expect(mensaje).toMatch(/951 KB/);
      expect(mensaje).toMatch(/500 KB/);

      expect(storageCalls).toHaveLength(0);
      expect(tableCalls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker animado de 400 KB entra en el límite y se guarda con animated: true", async () => {
    const { client, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(400 * 1024, true);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      expect(tableCalls[0]).toMatchObject({ op: "insert", payload: { animated: true } });
      expect(sticker.animated).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker estático de 60 KB se guarda con animated: false", async () => {
    const { client, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(60 * 1024, false);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      expect(tableCalls[0]).toMatchObject({ op: "insert", payload: { animated: false } });
      expect(sticker.animated).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sin mediaUrl no hay nada que guardar", async () => {
    const { client } = createStickerFakeSupabase();
    await expect(
      saveStickerFromMessage(client, stickerSourceMessage({ mediaUrl: null }), STICKER_AGENT)
    ).rejects.toThrow(/no tiene un sticker/i);
  });
});

describe("createSticker — armado desde cero", () => {
  it("sube el WebP e inserta la fila con el nombre", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const blob = new Blob(["webp"]);

    const sticker = await createSticker(client, blob, "Moto contenta", STICKER_AGENT);

    const uploadCall = storageCalls.find((c) => c.op === "upload");
    expect(uploadCall?.args[2]).toBe(blob);
    expect(uploadCall?.args[3]).toMatchObject({ contentType: "image/webp" });
    expect(tableCalls[0]).toMatchObject({
      op: "insert",
      payload: { name: "Moto contenta", created_by: "agent-42" },
    });
    expect(sticker.name).toBe("Moto contenta");
  });
});

describe("deleteSticker — borra la fila y el archivo, en ese orden", () => {
  const STICKER: Sticker = {
    id: "sticker-1",
    url: "/api/media/stickers/sticker-1.webp",
    name: null,
    animated: false,
    createdBy: "agent-42",
    createdAt: "2026-09-09T12:00:00.000Z",
  };

  it("borra la fila y después el objeto del bucket", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();

    await deleteSticker(client, STICKER);

    expect(tableCalls).toEqual([{ op: "delete", id: "sticker-1" }]);
    const removeCall = storageCalls.find((c) => c.op === "remove");
    expect(removeCall?.args[1]).toEqual(["stickers/sticker-1.webp"]);
  });

  it("un error de RLS al borrar la fila se propaga tal cual, sin tocar el archivo", async () => {
    const client = {
      from: () => ({
        delete: () => ({
          eq: async () => ({ error: new Error("new row violates row-level security policy") }),
        }),
      }),
      storage: { from: () => ({ remove: vi.fn() }) },
    } as unknown as SupabaseClient;

    await expect(deleteSticker(client, STICKER)).rejects.toThrow(/row-level security/);
  });
});

describe("sendStickerMessage — el mismo camino que un adjunto, sin content", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: "msg-99" }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda kind: media, mediaType: sticker y sin content", async () => {
    await sendStickerMessage("conv-1", "/api/media/stickers/sticker-1.webp");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/send");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      conversationId: "conv-1",
      kind: "media",
      mediaUrl: "/api/media/stickers/sticker-1.webp",
      mediaType: "sticker",
    });
  });
});

/**
 * T5, plan "Seis frentes del buzón" (8/9/2026): las bases de la factura.
 * `createInvoiceForSale` no arma el snapshot ella misma —eso lo prueba
 * invoices.test.ts (`buildInvoiceDraft`)— acá se fija que lea `order_id` de
 * la conversación, falle claro sin orden, y que emitir/anular actualicen
 * exactamente las columnas que les tocan.
 */
describe("createInvoiceForSale / issueInvoice / voidInvoice", () => {
  const CONTACT: Contact = {
    id: "contact-1",
    phoneNumber: "+584121234567",
    displayName: "Cliente Demo",
    profileName: "Demo WA",
    avatarUrl: null,
    tags: [],
    cedulaType: "V",
    cedulaNumber: "12345678",
    state: "Barinas",
    city: "Barinas",
    address: "Calle Falsa 123",
  };

  const SALE: Sale = {
    id: "conv-1",
    contact: CONTACT,
    dealStatus: "won",
    dealClosedAt: "2026-09-08T12:00:00.000Z",
    dealPaymentProofUrl: null,
    dealAmount: 83,
    dealCurrency: "USD",
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: "pago_movil",
    dealClosedBy: null,
    saintInvoiceNumber: null,
    createdAt: "2026-09-08T11:00:00.000Z",
  };

  const RAW_INVOICE_ROW = {
    id: "inv-1",
    number: 1,
    conversation_id: "conv-1",
    order_id: "order-1",
    contact_id: "contact-1",
    customer: { displayName: "Cliente Demo", phoneNumber: "+584121234567", cedulaType: "V", cedulaNumber: "12345678", state: "Barinas", city: "Barinas", address: "Calle Falsa 123" },
    items: [{ description: "Carburador PZ27", quantity: 1, unitPrice: 18, amount: 18 }],
    subtotal: 18,
    tax_rate: 0,
    tax_amount: 0,
    total: 18,
    currency: "USD",
    bcv_rate: 40,
    status: "draft",
    issued_at: null,
    voided_at: null,
    notes: null,
    created_at: "2026-09-08T12:00:00.000Z",
    updated_at: "2026-09-08T12:00:00.000Z",
    issued_by: null,
  };

  function createFakeInvoiceSupabase(options: { orderId?: string | null } = {}) {
    const calls: { table: string; op: string; payload?: unknown; eq?: [string, unknown][] }[] = [];
    const orderId = options.orderId === undefined ? "order-1" : options.orderId;

    const client = {
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: (col: string, value: unknown) => ({
                maybeSingle: async () => {
                  calls.push({ table, op: "select", eq: [[col, value]] });
                  return { data: { order_id: orderId }, error: null };
                },
              }),
            }),
          };
        }
        if (table === "order_items") {
          return {
            select: () => ({
              eq: (col: string, value: unknown) => {
                calls.push({ table, op: "select", eq: [[col, value]] });
                return Promise.resolve({
                  data: [{ description: "Carburador PZ27", quantity: 1, unit_price: "18.00" }],
                  error: null,
                });
              },
            }),
          };
        }
        if (table === "invoices") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () => ({ data: RAW_INVOICE_ROW, error: null }),
                }),
              };
            },
            update: (payload: unknown) => {
              calls.push({ table, op: "update", payload });
              return {
                eq: () => ({
                  select: () => ({
                    single: async () => ({
                      data: { ...RAW_INVOICE_ROW, ...(payload as Record<string, unknown>) },
                      error: null,
                    }),
                  }),
                }),
              };
            },
          };
        }
        if (table === "messages") {
          return { insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { error: null }; } };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("crea la factura con el snapshot del cliente y de los renglones de la orden", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await createInvoiceForSale(client, SALE, AGENT, 40);

    const invoiceInsert = calls.find((c) => c.table === "invoices" && c.op === "insert");
    expect(invoiceInsert?.payload).toMatchObject({
      conversation_id: "conv-1",
      order_id: "order-1",
      contact_id: "contact-1",
      subtotal: 18,
      total: 18,
      bcv_rate: 40,
    });
    expect(invoice.number).toBe(1);
    expect(invoice.status).toBe("draft");

    // Deja rastro en la conversación, como el resto de mutaciones de venta.
    const systemEvent = calls.find((c) => c.table === "messages" && c.op === "insert");
    expect((systemEvent?.payload as { content: string }).content).toContain("generó la factura SBK-000001");
  });

  it("sin orden registrada, falla con el mensaje claro y no llega a insertar nada", async () => {
    const { client, calls } = createFakeInvoiceSupabase({ orderId: null });

    await expect(createInvoiceForSale(client, SALE, AGENT, 40)).rejects.toThrow(
      "Esta venta no tiene orden registrada"
    );
    expect(calls.some((c) => c.table === "invoices")).toBe(false);
  });

  it("issueInvoice pasa a issued con quién y cuándo, y deja rastro en la conversación", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await issueInvoice(client, "inv-1", AGENT);

    const update = calls.find((c) => c.table === "invoices" && c.op === "update");
    expect(update?.payload).toMatchObject({ status: "issued", issued_by: "agent-1" });
    expect((update?.payload as { issued_at: string }).issued_at).toEqual(expect.any(String));
    expect(invoice.status).toBe("issued");

    const systemEvent = calls.find((c) => c.table === "messages" && c.op === "insert");
    expect((systemEvent?.payload as { content: string }).content).toContain("emitió la factura SBK-000001");
  });

  it("voidInvoice pasa a void sin pedir agente", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await voidInvoice(client, "inv-1");

    const update = calls.find((c) => c.table === "invoices" && c.op === "update");
    expect(update?.payload).toMatchObject({ status: "void" });
    expect((update?.payload as { voided_at: string }).voided_at).toEqual(expect.any(String));
    expect(invoice.status).toBe("void");
  });
});

/**
 * T6 (8/9/2026): "Agregar contacto" desde la bandeja. El fake reproduce las
 * tres tablas que toca la mutación -- `whatsapp_channels` (vía
 * `fetchDefaultChannel`, ya probado aparte en `data.test.ts`), `contacts` y
 * `conversations` -- y deja simular el código `23505` (unique_violation) de
 * Postgres en cualquiera de los dos inserts, que es el camino real: repetir
 * el mismo teléfono es el caso de uso más probable, no un error.
 */
describe("createContactConversation — un contacto nace desde la bandeja", () => {
  interface ContactConversationFakeOptions {
    channelRow?: { id: string; status: string } | null;
    contactInsertError?: { code: string } | null;
    existingContactId?: string;
    conversationInsertError?: { code: string } | null;
    existingConversationId?: string;
  }

  function createContactFlowSupabase(options: ContactConversationFakeOptions = {}) {
    const calls: { table: string; op: "insert"; payload: unknown }[] = [];
    const channelRow = options.channelRow === undefined ? { id: "chan-1", status: "connected" } : options.channelRow;

    const client = {
      from(table: string) {
        if (table === "whatsapp_channels") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () =>
                    channelRow && channelRow.status === "connected"
                      ? { data: [channelRow], error: null }
                      : { data: [], error: null },
                }),
              }),
              order: () => ({
                limit: async () => (channelRow ? { data: [channelRow], error: null } : { data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.contactInsertError
                      ? { data: null, error: options.contactInsertError }
                      : { data: { id: "contact-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { id: options.existingContactId ?? "contact-existing" }, error: null }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.conversationInsertError
                      ? { data: null, error: options.conversationInsertError }
                      : { data: { id: "conv-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: options.existingConversationId ?? "conv-existing" }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "messages") {
          return {
            insert: async (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return { error: null };
            },
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("crea contacto y conversación nuevos, y deja la nota interna de auditoría", async () => {
    const { client, calls } = createContactFlowSupabase();

    const result = await createContactConversation(client, {
      displayName: "Pedro Pérez",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: false });

    const contactInsert = calls.find((c) => c.table === "contacts");
    expect(contactInsert?.payload).toEqual({ display_name: "Pedro Pérez", phone_number: "+584141234567" });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toEqual({
      contact_id: "contact-new",
      whatsapp_channel_id: "chan-1",
      status: "open",
    });

    const noteInsert = calls.find((c) => c.table === "messages");
    expect(noteInsert?.payload).toMatchObject({
      conversation_id: "conv-new",
      direction: "outbound",
      sender_type: "system",
      sender_agent_id: AGENT.id,
      message_type: "system_event",
      is_internal_note: true,
      content: "Contacto agregado desde la bandeja por José Riera",
    });
  });

  it("sin ningún canal de WhatsApp configurado, no crea nada y lanza", async () => {
    const { client, calls } = createContactFlowSupabase({ channelRow: null });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toThrow(/ningún canal/i);

    expect(calls).toEqual([]);
  });

  it("un teléfono repetido (23505 en contacts) reutiliza el contacto y marca existed sin dejar nota", async () => {
    const { client, calls } = createContactFlowSupabase({
      contactInsertError: { code: "23505" },
      existingContactId: "contact-existing",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: true });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toMatchObject({ contact_id: "contact-existing" });

    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("una conversación repetida (23505 en conversations) reutiliza esa conversación y marca existed", async () => {
    const { client, calls } = createContactFlowSupabase({
      conversationInsertError: { code: "23505" },
      existingConversationId: "conv-repetida",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-repetida", existed: true });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("un error de la base que no es 23505 sube tal cual, no se traga", async () => {
    const { client } = createContactFlowSupabase({
      contactInsertError: { code: "42501" },
    });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toEqual({ code: "42501" });
  });
});

/**
 * Enlaces de catálogo (T2, plan "Nada sin leer, un solo catálogo y la
 * factura Saint", 18/9/2026, D3). Mismo patrón que el describe de
 * "Lecciones de Seba" más arriba en este archivo
 * (createLesson/setLessonActive/deleteLesson): createCatalogLink/
 * updateCatalogLink/deleteCatalogLink/setCatalogLinkActive.
 */
describe("createCatalogLink / updateCatalogLink / deleteCatalogLink / setCatalogLinkActive — T2, 18/9/2026", () => {
  function createCatalogLinkFakeSupabase() {
    const calls: { op: "insert" | "update" | "delete"; payload?: unknown; id?: string }[] = [];
    const client = {
      from(table: string) {
        if (table !== "catalog_links") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        return {
          insert: (payload: Record<string, unknown>) => {
            calls.push({ op: "insert", payload });
            return Promise.resolve({ error: null });
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              calls.push({ op: "update", payload, id });
              return { error: null };
            },
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              calls.push({ op: "delete", id });
              return { error: null };
            },
          }),
        };
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  const CATALOG_AGENT: Agent = {
    id: "agent-7",
    displayName: "Rosa",
    fullName: "Rosa Pérez",
    avatarUrl: null,
    role: "supervisor",
    isActive: true,
  };

  function catalogDraft(overrides: Partial<CatalogLinkDraft> = {}): CatalogLinkDraft {
    return {
      key: "cascos",
      label: "Cascos",
      url: "https://drive.google.com/file/d/1iz77Lc",
      ...overrides,
    };
  }

  it("createCatalogLink inserta con updated_by = agent.id", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await createCatalogLink(client, CATALOG_AGENT, catalogDraft());

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("insert");
    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.updated_by).toBe("agent-7");
    expect(payload.key).toBe("cascos");
    expect(payload.label).toBe("Cascos");
    expect(payload.url).toBe("https://drive.google.com/file/d/1iz77Lc");
  });

  /**
   * Sin `sortOrder` en el borrador, el INSERT no manda `sort_order`: la
   * columna toma el DEFAULT de la base (0), no hace falta que la mutación lo
   * calcule.
   */
  it("createCatalogLink sin sortOrder no manda sort_order (la base pone el default)", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await createCatalogLink(client, CATALOG_AGENT, catalogDraft());

    const payload = calls[0].payload as Record<string, unknown>;
    expect("sort_order" in payload).toBe(false);
  });

  it("createCatalogLink con sortOrder lo manda tal cual", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await createCatalogLink(client, CATALOG_AGENT, catalogDraft({ sortOrder: 3 }));

    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.sort_order).toBe(3);
  });

  it("updateCatalogLink actualiza key/label/url/updated_by por id", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await updateCatalogLink(client, CATALOG_AGENT, "link-1", catalogDraft({ label: "Cascos nuevos" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("update");
    expect(calls[0].id).toBe("link-1");
    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.label).toBe("Cascos nuevos");
    expect(payload.updated_by).toBe("agent-7");
  });

  /**
   * Sin `sortOrder`, el UPDATE no toca esa columna: deja el orden que ya
   * tenía la fila. Editar solo la URL de un catálogo no debe reordenar la
   * lista de `{{catalogos}}` por accidente.
   */
  it("updateCatalogLink sin sortOrder no toca sort_order", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await updateCatalogLink(client, CATALOG_AGENT, "link-1", catalogDraft());

    const payload = calls[0].payload as Record<string, unknown>;
    expect("sort_order" in payload).toBe(false);
  });

  it("deleteCatalogLink borra la fila por id", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await deleteCatalogLink(client, "link-1");

    expect(calls).toContainEqual({ op: "delete", id: "link-1" });
  });

  it("setCatalogLinkActive actualiza is_active y updated_by por id", async () => {
    const { client, calls } = createCatalogLinkFakeSupabase();

    await setCatalogLinkActive(client, CATALOG_AGENT, "link-1", false);

    expect(calls).toContainEqual({
      op: "update",
      payload: { is_active: false, updated_by: "agent-7" },
      id: "link-1",
    });
  });

  it("propaga el error de la base en createCatalogLink en vez de tragárselo", async () => {
    const client = {
      from: () => ({ insert: async () => ({ error: new Error("no se pudo guardar") }) }),
    } as unknown as SupabaseClient;

    await expect(createCatalogLink(client, CATALOG_AGENT, catalogDraft())).rejects.toThrow(/no se pudo guardar/);
  });
});
