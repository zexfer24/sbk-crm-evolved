import { describe, expect, it } from "vitest";
import { conservarLecturasResueltas, mapMessageReading } from "@/lib/media-reading-map";
import type { Message, MessageReading } from "@/lib/types";

// Estos tests vivían en `data-messages-window.test.ts` (los puso ahí la entrega
// de lectura de adjuntos, 16/11/2026); la revisión de código los movió junto a
// su módulo (convención del repo: `foo.ts` + `foo.test.ts`). Allá queda lo que
// prueba `data.ts`: que el `select` pide la lectura y que `mapMessage` la mapea.

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
