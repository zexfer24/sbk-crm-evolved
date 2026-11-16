import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHAT_MESSAGES_WINDOW, fetchMessages, fetchMessagesBefore, mapMessageReading } from "@/lib/data";
import { conservarLecturasResueltas } from "@/lib/media-reading-map";
import type { Message, MessageReading } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fake del query builder para la ventana de mensajes:
// `.from().select().eq().order().limit()` y su variante con `.lt()` para
// pedir lo anterior a un mensaje. Guarda cada llamada para poder afirmar
// sobre el orden pedido, que es justamente donde está el riesgo: pedir los
// últimos N exige orden DESCENDENTE y luego invertir.
// ---------------------------------------------------------------------------

interface QueryCall {
  /** El string del `select`, para afirmar que trae la lectura embebida. */
  select?: string;
  orderAscending: boolean | undefined;
  limit: number;
  ltValue?: string;
}

function makeRow(index: number, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    id: `msg-${index}`,
    conversation_id: "conv-1",
    direction: "inbound" as const,
    sender_type: "customer" as const,
    message_type: "text" as const,
    content: `mensaje ${index}`,
    template_name: null,
    media_url: null,
    is_internal_note: false,
    whatsapp_status: null,
    reply_to_message_id: null,
    created_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
    sender_agent: null,
  };
}

/** `rows` va en orden cronológico ascendente, como están en la tabla. */
function createFakeSupabase(rows: ReturnType<typeof makeRow>[]) {
  const calls: QueryCall[] = [];
  let selectUsado: string | undefined;

  function resolver(ascending: boolean | undefined, ltValue?: string) {
    return {
      // La rama sin ventana pagina con `.range()`; se incluye para poder
      // comprobar que ese camino sigue trayendo el historial completo.
      range(from: number, to: number) {
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
      limit(count: number) {
        calls.push({ select: selectUsado, orderAscending: ascending, limit: count, ltValue });
        const pool = ltValue ? rows.filter((r) => r.created_at < ltValue) : rows;
        // Descendente = los más nuevos primero.
        const ordered = ascending === false ? [...pool].reverse() : pool;
        return Promise.resolve({ data: ordered.slice(0, count), error: null });
      },
    };
  }

  const client = {
    from() {
      return {
        select(columns?: string) {
          selectUsado = columns;
          return {
            eq() {
              return {
                order(_column: string, opts?: { ascending?: boolean }) {
                  return {
                    ...resolver(opts?.ascending),
                    lt(_col: string, value: string) {
                      return resolver(opts?.ascending, value);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchMessages · ventana", () => {
  /**
   * Abrir un chat traía TODO su historial. En una conversación larga son
   * miles de filas viajando al navegador cada vez que se hace clic en ella,
   * cuando lo único que se ve al abrir son los últimos mensajes.
   */
  it("trae solo los últimos mensajes cuando se pide una ventana", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 500 }, (_, i) => makeRow(i))
    );

    const result = await fetchMessages(client, "conv-1", { limit: CHAT_MESSAGES_WINDOW });

    expect(result).toHaveLength(CHAT_MESSAGES_WINDOW);
    // Pedir "los últimos" exige orden descendente en la consulta.
    expect(calls[0].orderAscending).toBe(false);
  });

  /**
   * El chat se lee de arriba hacia abajo: por más que la consulta pida los
   * más nuevos primero, lo que se pinta tiene que quedar en orden
   * cronológico o la conversación se lee al revés.
   */
  it("devuelve la ventana en orden cronológico", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 500 }, (_, i) => makeRow(i)));

    const result = await fetchMessages(client, "conv-1", { limit: 3 });

    expect(result.map((m) => m.content)).toEqual(["mensaje 497", "mensaje 498", "mensaje 499"]);
  });

  /** Sin ventana pedida se conserva el comportamiento de traer el historial entero. */
  it("sigue trayendo todo cuando no se pide ventana", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 40 }, (_, i) => makeRow(i)));

    const result = await fetchMessages(client, "conv-1");

    expect(result).toHaveLength(40);
  });
});

describe("fetchMessagesBefore", () => {
  /**
   * Es lo que hace que acotar la ventana no le quite nada al asesor: el
   * historial viejo sigue disponible, se pide cuando hace falta.
   */
  it("trae los mensajes anteriores a uno dado, en orden cronológico", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 500 }, (_, i) => makeRow(i))
    );
    const corte = new Date(2024, 0, 1, 0, 0, 100).toISOString();

    const result = await fetchMessagesBefore(client, "conv-1", corte, 3);

    expect(calls[0].ltValue).toBe(corte);
    expect(result.map((m) => m.content)).toEqual(["mensaje 97", "mensaje 98", "mensaje 99"]);
  });

  /** Al llegar al principio del hilo no hay nada anterior que traer. */
  it("devuelve vacío cuando ya no queda historial", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 500 }, (_, i) => makeRow(i)));
    const primero = new Date(2024, 0, 1, 0, 0, 0).toISOString();

    const result = await fetchMessagesBefore(client, "conv-1", primero, 20);

    expect(result).toEqual([]);
  });
});

describe("la lectura automática de los adjuntos", () => {
  const lecturaCruda = {
    kind: "audio",
    status: "ok",
    text: "quiero un casco",
    fields: null,
    created_at: "2026-11-16T15:00:00.000Z",
  };

  it("el select pide la lectura embebida de message_readings", async () => {
    const { client, calls } = createFakeSupabase([makeRow(0)]);

    await fetchMessages(client, "conv-1", { limit: 5 });

    expect(calls[0].select).toContain("reading:message_readings(kind, status, text, fields, created_at)");
  });

  it("mapea la lectura embebida como objeto", async () => {
    const { client } = createFakeSupabase([makeRow(0, { reading: lecturaCruda })]);

    const [mensaje] = await fetchMessages(client, "conv-1", { limit: 5 });

    expect(mensaje.reading).toEqual({
      kind: "audio",
      status: "ok",
      text: "quiero un casco",
      fields: null,
      createdAt: "2026-11-16T15:00:00.000Z",
    });
  });

  it("un mensaje sin lectura (null) queda en null", async () => {
    const { client } = createFakeSupabase([makeRow(0, { reading: null })]);

    const [mensaje] = await fetchMessages(client, "conv-1", { limit: 5 });

    expect(mensaje.reading).toBeNull();
  });

  it("por defensa, un arreglo de un elemento toma el primero", async () => {
    const { client } = createFakeSupabase([makeRow(0, { reading: [lecturaCruda] })]);

    const [mensaje] = await fetchMessages(client, "conv-1", { limit: 5 });

    expect(mensaje.reading?.text).toBe("quiero un casco");
  });
});

describe("mapMessageReading", () => {
  it("pasa los campos de una imagen por parseImageFields", () => {
    const lectura = mapMessageReading({
      kind: "image",
      status: "ok",
      text: "Un casco",
      fields: { tipo: "comprobante_pago", es_comprobante_pago: true, comprobante: { monto: 10, moneda: "USD" } },
      created_at: "2026-11-16T15:00:00.000Z",
    });

    expect(lectura?.fields?.tipo).toBe("comprobante_pago");
    expect(lectura?.fields?.comprobante?.monto).toBe(10);
  });

  it("fields ilegibles quedan en null sin tumbar la lectura", () => {
    const lectura = mapMessageReading({
      kind: "image",
      status: "ok",
      text: "Un casco",
      fields: { tipo: "inventado" },
      created_at: "2026-11-16T15:00:00.000Z",
    });

    expect(lectura).toMatchObject({ text: "Un casco", fields: null });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["un string", "basura"],
    ["un número", 7],
    ["un arreglo vacío", []],
    ["un objeto sin kind", { status: "ok" }],
    ["un kind inválido", { kind: "video", status: "ok" }],
    ["un status inválido", { kind: "audio", status: "quizas" }],
  ])("devuelve null con %s", (_nombre, basura) => {
    expect(mapMessageReading(basura)).toBeNull();
  });

  it("acepta la fila cruda de un evento de Realtime (message_id de más, text null)", () => {
    const lectura = mapMessageReading({
      message_id: "m-1",
      conversation_id: "c-1",
      kind: "audio",
      status: "pendiente",
      text: null,
      fields: null,
      created_at: "2026-11-16T15:00:00.000Z",
      updated_at: "2026-11-16T15:00:00.000Z",
    });

    expect(lectura).toEqual({
      kind: "audio",
      status: "pendiente",
      text: null,
      fields: null,
      createdAt: "2026-11-16T15:00:00.000Z",
    });
  });
});

describe("conservarLecturasResueltas", () => {
  const lect = (status: "pendiente" | "ok", text: string | null): MessageReading => ({
    kind: "audio",
    status,
    text,
    fields: null,
    createdAt: "2026-11-16T15:00:00.000Z",
  });
  const mensaje = (id: string, reading?: MessageReading | null): Message => ({
    id,
    conversationId: "c-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "audio",
    content: null,
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    reading,
    createdAt: "2026-11-16T15:00:00.000Z",
  });

  it("un nuevo pendiente con un previo ok conserva la lectura ok", () => {
    const previa = lect("ok", "hola");
    const [m] = conservarLecturasResueltas([mensaje("a", previa)], [mensaje("a", lect("pendiente", null))]);
    expect(m.reading).toBe(previa);
  });

  it("un nuevo sin lectura (null o undefined) con un previo ok conserva la lectura ok", () => {
    const previa = lect("ok", "hola");
    const r = conservarLecturasResueltas([mensaje("a", previa)], [mensaje("a", null), mensaje("b", undefined)]);
    expect(r[0].reading).toBe(previa);
    expect(r[1].reading).toBeUndefined();
  });

  it("un nuevo ok gana sobre un previo ok", () => {
    const nueva = lect("ok", "versión nueva");
    const [m] = conservarLecturasResueltas([mensaje("a", lect("ok", "vieja"))], [mensaje("a", nueva)]);
    expect(m.reading).toBe(nueva);
  });

  it("un mensaje nuevo sin previo queda igual, y los mismos objetos si nada cambia", () => {
    const nuevos = [mensaje("z", lect("pendiente", null))];
    const r = conservarLecturasResueltas([mensaje("a", lect("ok", "x"))], nuevos);
    expect(r[0]).toBe(nuevos[0]);
  });

  it("un previo pendiente no se conserva: gana el nuevo", () => {
    const nueva = lect("pendiente", null);
    const [m] = conservarLecturasResueltas([mensaje("a", lect("pendiente", null))], [mensaje("a", nueva)]);
    expect(m.reading).toBe(nueva);
  });

  it("no cambia el orden ni la cantidad", () => {
    const r = conservarLecturasResueltas([], [mensaje("1"), mensaje("2"), mensaje("3")]);
    expect(r.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });
});
