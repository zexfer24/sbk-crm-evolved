import { describe, expect, it } from "vitest";
import { historyLine, isHistoryMarker, type HistoryRow } from "@/lib/ai/history-line";
import { revealsIdentity } from "@/lib/ai/identity-guard";

function row(overrides: Partial<HistoryRow>): HistoryRow {
  return {
    sender_type: "customer",
    content: null,
    is_internal_note: false,
    message_type: "text",
    ...overrides,
  };
}

describe("historyLine — filas que se saltan (comportamiento ya vigente)", () => {
  it("nota interna → null", () => {
    expect(historyLine(row({ content: "anotación para el equipo", is_internal_note: true }))).toBeNull();
  });

  it("sender_type 'system' → null", () => {
    expect(historyLine(row({ sender_type: "system", content: "evento de sistema" }))).toBeNull();
  });

  it("message_type 'unsupported' → null aunque is_internal_note sea false", () => {
    expect(historyLine(row({ message_type: "unsupported", content: null }))).toBeNull();
  });
});

describe("historyLine — texto y tipos que se pasan tal cual", () => {
  it("text con contenido → content tal cual", () => {
    expect(historyLine(row({ message_type: "text", content: "hola, tienen aceite 20w50?" }))).toEqual({
      role: "user",
      content: "hola, tienen aceite 20w50?",
      marcador: false,
    });
  });

  it("text con content null → null", () => {
    expect(historyLine(row({ message_type: "text", content: null }))).toBeNull();
  });

  it("text con content solo espacios → null", () => {
    expect(historyLine(row({ message_type: "text", content: "   " }))).toBeNull();
  });

  it("message_type null (desconocido) se trata como texto", () => {
    expect(historyLine(row({ message_type: null, content: "algo" }))).toEqual({
      role: "user",
      content: "algo",
      marcador: false,
    });
  });

  it("location → content tal cual", () => {
    expect(historyLine(row({ message_type: "location", content: "Ubicación compartida: Barinas" }))).toEqual({
      role: "user",
      content: "Ubicación compartida: Barinas",
      marcador: false,
    });
  });

  it("contacts → content tal cual", () => {
    expect(historyLine(row({ message_type: "contacts", content: "Contacto compartido: Juan Pérez" }))).toEqual({
      role: "user",
      content: "Contacto compartido: Juan Pérez",
      marcador: false,
    });
  });

  it("interactive → content tal cual", () => {
    expect(historyLine(row({ message_type: "interactive", content: "Seleccionó: Sí, quiero comprar" }))).toEqual({
      role: "user",
      content: "Seleccionó: Sí, quiero comprar",
      marcador: false,
    });
  });

  it("order → content tal cual (ya es el resumen en español que arma el webhook)", () => {
    expect(
      historyLine(row({ message_type: "order", content: "🛒 El cliente envió un pedido del catálogo (1 producto)" }))
    ).toEqual({
      role: "user",
      content: "🛒 El cliente envió un pedido del catálogo (1 producto)",
      marcador: false,
    });
  });

  it("template → content tal cual", () => {
    expect(historyLine(row({ sender_type: "ai", message_type: "template", content: "Plantilla de bienvenida" }))).toEqual({
      role: "assistant",
      content: "Plantilla de bienvenida",
      marcador: false,
    });
  });

  it("system_event → content tal cual", () => {
    expect(historyLine(row({ message_type: "system_event", content: "El cliente cambió de número" }))).toEqual({
      role: "user",
      content: "El cliente cambió de número",
      marcador: false,
    });
  });
});

describe("historyLine — multimedia del CLIENTE", () => {
  it("foto con pie", () => {
    expect(historyLine(row({ message_type: "image", content: "Cualquiera de estos en talla L" }))).toEqual({
      role: "user",
      content: "[El cliente envió una foto. Pie: Cualquiera de estos en talla L]",
      marcador: true,
    });
  });

  it("foto sin pie (content null)", () => {
    expect(historyLine(row({ message_type: "image", content: null }))).toEqual({
      role: "user",
      content: "[El cliente envió una foto sin texto; no puedes verla]",
      marcador: true,
    });
  });

  it("video con pie", () => {
    expect(historyLine(row({ message_type: "video", content: "el de la izquierda" }))).toEqual({
      role: "user",
      content: "[El cliente envió un video. Pie: el de la izquierda]",
      marcador: true,
    });
  });

  it("video sin pie", () => {
    expect(historyLine(row({ message_type: "video", content: null }))).toEqual({
      role: "user",
      content: "[El cliente envió un video sin texto; no puedes verlo]",
      marcador: true,
    });
  });

  it("nota de voz sin pie (el caso normal: WhatsApp no deja poner pie a un audio)", () => {
    expect(historyLine(row({ message_type: "audio", content: null }))).toEqual({
      role: "user",
      content: "[El cliente envió una nota de voz; no puedes escucharla]",
      marcador: true,
    });
  });

  it("nota de voz con pie (si algún día trajera uno)", () => {
    expect(historyLine(row({ message_type: "audio", content: "esto es lo que dije" }))).toEqual({
      role: "user",
      content: "[El cliente envió una nota de voz. Pie: esto es lo que dije]",
      marcador: true,
    });
  });

  it("documento con pie", () => {
    expect(historyLine(row({ message_type: "document", content: "esta es mi factura" }))).toEqual({
      role: "user",
      content: "[El cliente envió un documento. Pie: esta es mi factura]",
      marcador: true,
    });
  });

  it("documento sin pie (el webhook no guarda el nombre del archivo)", () => {
    expect(historyLine(row({ message_type: "document", content: null }))).toEqual({
      role: "user",
      content: "[El cliente envió un documento; no puedes abrirlo]",
      marcador: true,
    });
  });

  it("sticker", () => {
    expect(historyLine(row({ message_type: "sticker", content: null }))).toEqual({
      role: "user",
      content: "[El cliente envió un sticker]",
      marcador: true,
    });
  });

  it("un pie con espacios alrededor se recorta", () => {
    expect(historyLine(row({ message_type: "image", content: "  para mi moto  " }))).toEqual({
      role: "user",
      content: "[El cliente envió una foto. Pie: para mi moto]",
      marcador: true,
    });
  });

  it("un pie de solo espacios se trata como sin pie", () => {
    expect(historyLine(row({ message_type: "image", content: "   " }))).toEqual({
      role: "user",
      content: "[El cliente envió una foto sin texto; no puedes verla]",
      marcador: true,
    });
  });
});

describe("historyLine — multimedia del ASESOR (sender_type 'agent' o 'ai')", () => {
  it("foto sin pie, sender_type 'agent'", () => {
    expect(historyLine(row({ sender_type: "agent", message_type: "image", content: null }))).toEqual({
      role: "assistant",
      content: "[El asesor envió una foto]",
      marcador: true,
    });
  });

  it("foto con pie, sender_type 'ai'", () => {
    expect(historyLine(row({ sender_type: "ai", message_type: "image", content: "este es el que te decía" }))).toEqual({
      role: "assistant",
      content: "[El asesor envió una foto. Pie: este es el que te decía]",
      marcador: true,
    });
  });

  it("video sin pie", () => {
    expect(historyLine(row({ sender_type: "agent", message_type: "video", content: null }))).toEqual({
      role: "assistant",
      content: "[El asesor envió un video]",
      marcador: true,
    });
  });

  it("nota de voz sin pie", () => {
    expect(historyLine(row({ sender_type: "agent", message_type: "audio", content: null }))).toEqual({
      role: "assistant",
      content: "[El asesor envió una nota de voz]",
      marcador: true,
    });
  });

  it("documento sin pie", () => {
    expect(historyLine(row({ sender_type: "agent", message_type: "document", content: null }))).toEqual({
      role: "assistant",
      content: "[El asesor envió un documento]",
      marcador: true,
    });
  });

  it("sticker", () => {
    expect(historyLine(row({ sender_type: "agent", message_type: "sticker", content: null }))).toEqual({
      role: "assistant",
      content: "[El asesor envió un sticker]",
      marcador: true,
    });
  });
});

describe("isHistoryMarker", () => {
  it("reconoce cada marcador que produce historyLine", () => {
    const filas: HistoryRow[] = [
      row({ message_type: "image", content: null }),
      row({ message_type: "image", content: "pie" }),
      row({ message_type: "video", content: null }),
      row({ message_type: "video", content: "pie" }),
      row({ message_type: "audio", content: null }),
      row({ message_type: "audio", content: "pie" }),
      row({ message_type: "document", content: null }),
      row({ message_type: "document", content: "pie" }),
      row({ message_type: "sticker", content: null }),
      row({ sender_type: "agent", message_type: "image", content: null }),
      row({ sender_type: "agent", message_type: "image", content: "pie" }),
      row({ sender_type: "agent", message_type: "video", content: null }),
      row({ sender_type: "agent", message_type: "audio", content: null }),
      row({ sender_type: "agent", message_type: "document", content: null }),
      row({ sender_type: "agent", message_type: "sticker", content: null }),
    ];

    for (const fila of filas) {
      const linea = historyLine(fila);
      expect(linea).not.toBeNull();
      expect(isHistoryMarker(linea!.content)).toBe(true);
    }
  });

  it("un texto del cliente que empieza con '[' no es un marcador", () => {
    expect(isHistoryMarker("[urgente] necesito un caucho")).toBe(false);
  });

  it("una frase que menciona lo que envió el cliente pero no la escribió el CRM no es un marcador", () => {
    expect(isHistoryMarker("[El cliente dijo hola]")).toBe(false);
  });
});

describe("los marcadores nunca calzan con la guarda de identidad", () => {
  it("revealsIdentity(marcador) es null para todos los marcadores posibles", () => {
    const filas: HistoryRow[] = [
      row({ message_type: "image", content: null }),
      row({ message_type: "image", content: "pie" }),
      row({ message_type: "video", content: null }),
      row({ message_type: "video", content: "pie" }),
      row({ message_type: "audio", content: null }),
      row({ message_type: "audio", content: "pie" }),
      row({ message_type: "document", content: null }),
      row({ message_type: "document", content: "pie" }),
      row({ message_type: "sticker", content: null }),
      row({ sender_type: "agent", message_type: "image", content: null }),
      row({ sender_type: "agent", message_type: "image", content: "pie" }),
      row({ sender_type: "agent", message_type: "video", content: null }),
      row({ sender_type: "agent", message_type: "audio", content: null }),
      row({ sender_type: "agent", message_type: "document", content: null }),
      row({ sender_type: "agent", message_type: "sticker", content: null }),
    ];

    for (const fila of filas) {
      const linea = historyLine(fila);
      expect(revealsIdentity(linea!.content)).toBeNull();
    }
  });
});
