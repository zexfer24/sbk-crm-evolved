import { describe, expect, it } from "vitest";
import {
  CUSTOMER_BURST_GAP_MINUTES,
  captionOfCustomerMarker,
  PREVIOUS_CONVERSATION_GAP_HOURS,
  customerBurst,
  historyLine,
  isHistoryMarker,
  latestCustomerMarker,
  mediaStreakWithoutText,
  pendingCustomerEntries,
  pendingCustomerLines,
  previousConversationCutoff,
  textoLeido,
  type HistoryReading,
  type HistoryRow,
  type SeenMarker,
} from "@/lib/ai/history-line";
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

/**
 * T6, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026): `agent_turns.customer_message` quedaba `null` con
 * foto + pie porque el marcador se descartaba entero. El pie es texto que el
 * cliente SÍ escribió; `captionOfCustomerMarker` lo saca del marcador.
 */
describe("captionOfCustomerMarker", () => {
  it("devuelve el pie de cada marcador del cliente que lo lleva", () => {
    for (const tipo of ["image", "video", "audio", "document"]) {
      const linea = historyLine(row({ message_type: tipo, content: "  Tienen este casco en talla M?  " }));
      expect(captionOfCustomerMarker(linea!.content)).toBe("Tienen este casco en talla M?");
    }
  });

  it("un pie de varias líneas o con corchetes se devuelve entero", () => {
    const linea = historyLine(row({ message_type: "image", content: "Bujía [NGK]\nla necesito hoy" }));
    expect(captionOfCustomerMarker(linea!.content)).toBe("Bujía [NGK]\nla necesito hoy");
  });

  it("un marcador sin pie, un sticker, uno del asesor o un texto normal dan null", () => {
    expect(captionOfCustomerMarker(historyLine(row({ message_type: "image", content: null }))!.content)).toBeNull();
    expect(captionOfCustomerMarker(historyLine(row({ message_type: "sticker", content: null }))!.content)).toBeNull();
    expect(
      captionOfCustomerMarker(historyLine(row({ sender_type: "agent", message_type: "image", content: "Aquí va" }))!.content)
    ).toBeNull();
    expect(captionOfCustomerMarker("Pie: hola")).toBeNull();
    expect(captionOfCustomerMarker("[urgente] necesito un caucho")).toBeNull();
  });
});

/**
 * Tarea 6, "La voz cercana y la espera visible" (14/9/2026), decisión 5:
 * 494 fotos y 117 audios en 72 h, la IA repitiendo "¿qué repuesto buscas?"
 * hasta 10 veces. `agent.ts` usa esto para decidir cuándo dejar de insistir.
 *
 * El historial se escribe en orden CRONOLÓGICO (del más viejo al más
 * nuevo) — es la forma en la que `loadHistory` (agent.ts) se lo entrega al
 * modelo, y la que recibe `mediaStreakWithoutText` en producción.
 */
describe("mediaStreakWithoutText", () => {
  it("foto sin pie + pregunta de la IA + foto sin pie → {2, true}", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
        { role: "assistant", content: "¿De qué moto es el repuesto que buscas?" },
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
      ])
    ).toEqual({ adjuntos: 2, yaPreguntamos: true, tipos: ["una foto", "una foto"] });
  });

  it("foto sin pie + foto sin pie, SIN que la IA haya respondido en medio → {2, false}: turno normal", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
      ])
    ).toEqual({ adjuntos: 2, yaPreguntamos: false, tipos: ["una foto", "una foto"] });
  });

  it("foto CON pie → 0: hay texto, no es un adjunto sin respuesta", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió una foto. Pie: para mi moto]" },
      ])
    ).toEqual({ adjuntos: 0, yaPreguntamos: false, tipos: [] });
  });

  it("texto normal al final → 0", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
        { role: "user", content: "hola, era para mi Bera" },
      ])
    ).toEqual({ adjuntos: 0, yaPreguntamos: false, tipos: [] });
  });

  it("sticker + sticker: un sticker no es un pedido, no cuenta ni corta como si fuera texto — pero tampoco arrastra una racha detrás", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió un sticker]" },
        { role: "user", content: "[El cliente envió un sticker]" },
      ])
    ).toEqual({ adjuntos: 0, yaPreguntamos: false, tipos: [] });
  });

  it("un marcador saliente del asesor (foto) en medio no cuenta como pregunta", () => {
    expect(
      mediaStreakWithoutText([
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
        { role: "assistant", content: "[El asesor envió una foto]" },
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
      ])
    ).toEqual({ adjuntos: 2, yaPreguntamos: false, tipos: ["una foto", "una foto"] });
  });

  it("historial vacío → todo en cero", () => {
    expect(mediaStreakWithoutText([])).toEqual({ adjuntos: 0, yaPreguntamos: false, tipos: [] });
  });
});

/**
 * T3, plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo A3): la cola
 * agrupa ráfagas de mensajes seguidos antes de correr un turno — mirar solo
 * la última línea del cliente (como hacía `lastCustomerMessage`, agent.ts)
 * se comía una pregunta real que llegó antes de un saludo/cortesía de
 * cierre en la misma ráfaga. `customerBurst` junta toda esa ráfaga final.
 *
 * Igual que `mediaStreakWithoutText`, el historial se escribe en orden
 * CRONOLÓGICO (del más viejo al más nuevo) — la forma en la que `loadHistory`
 * (agent.ts) se lo entrega.
 *
 * Corrección del 19/9/2026 (`code-review high`, hallazgos 4 y 8): las
 * entradas de estos tests llevan `createdAt` cuando la línea NO es la más
 * nueva de la ráfaga — la más nueva siempre entra sin fecha (ver el
 * docblock de la función), así que agregarle una ahí sería ruido.
 */
describe("customerBurst", () => {
  it("historial vacío → []", () => {
    expect(customerBurst([])).toEqual([]);
  });

  it("una sola línea de cliente, SIN fecha → igual entra: es la más nueva, no hay contra qué medir un hueco", () => {
    expect(customerBurst([{ role: "user", content: "hola" }])).toEqual(["hola"]);
  });

  it("dos líneas de cliente seguidas, con 1 minuto de diferencia → las dos, en orden cronológico", () => {
    expect(
      customerBurst([
        { role: "user", content: "Precio del casco LS2", createdAt: "2026-09-19T10:00:00.000Z" },
        { role: "user", content: "Buenas tardes", createdAt: "2026-09-19T10:01:00.000Z" },
      ])
    ).toEqual(["Precio del casco LS2", "Buenas tardes"]);
  });

  it("una respuesta de la IA en medio corta la ráfaga: solo cuenta lo posterior a esa respuesta", () => {
    expect(
      customerBurst([
        { role: "user", content: "hola" },
        { role: "assistant", content: "¡Bienvenido!" },
        { role: "user", content: "buenas" },
      ])
    ).toEqual(["buenas"]);
  });

  it("el historial termina en una línea del asesor/IA: la ráfaga del cliente está vacía", () => {
    expect(
      customerBurst([
        { role: "user", content: "hola" },
        { role: "assistant", content: "¿en qué te ayudo?" },
      ])
    ).toEqual([]);
  });

  it("un marcador de media entra a la ráfaga tal cual, como cualquier otra línea de cliente", () => {
    expect(
      customerBurst([
        { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]", createdAt: "2026-09-19T10:00:00.000Z" },
        { role: "user", content: "hola", createdAt: "2026-09-19T10:00:30.000Z" },
      ])
    ).toEqual(["[El cliente envió una foto sin texto; no puedes verla]", "hola"]);
  });

  /**
   * Hallazgo 4 (corrección del 19/9/2026): sin acotar por tiempo, dos
   * líneas de cliente sin nada del CRM entre medio se consideraban la MISMA
   * ráfaga sin importar cuánto tiempo real las separara. Caso real: "¿ya me
   * atienden?" (`pausada`, chat cerrado) y, DÍAS después, "hola" al reabrir.
   */
  describe("hallazgo 4 — la ráfaga se acota por tiempo, no solo por 'no hubo respuesta del CRM en el medio'", () => {
    it(`un hueco de exactamente ${CUSTOMER_BURST_GAP_MINUTES} minutos sigue siendo la MISMA ráfaga`, () => {
      expect(
        customerBurst([
          { role: "user", content: "¿tienen aceite 20w50?", createdAt: "2026-09-19T10:00:00.000Z" },
          { role: "user", content: "buenas", createdAt: "2026-09-19T10:10:00.000Z" },
        ])
      ).toEqual(["¿tienen aceite 20w50?", "buenas"]);
    });

    it(`un hueco de ${CUSTOMER_BURST_GAP_MINUTES + 1} minutos corta la ráfaga: solo entra la línea más nueva`, () => {
      expect(
        customerBurst([
          { role: "user", content: "¿tienen aceite 20w50?", createdAt: "2026-09-19T10:00:00.000Z" },
          { role: "user", content: "buenas", createdAt: "2026-09-19T10:11:00.000Z" },
        ])
      ).toEqual(["buenas"]);
    });

    it("caso real: '¿ya me atienden?' de hace 3 días + 'hola' al reabrir el chat — el hueco corta la línea vieja", () => {
      expect(
        customerBurst([
          { role: "user", content: "¿ya me atienden?", createdAt: "2026-09-16T10:00:00.000Z" },
          { role: "user", content: "hola", createdAt: "2026-09-19T10:00:00.000Z" },
        ])
      ).toEqual(["hola"]);
    });

    it("una línea vieja SIN createdAt corta la ráfaga (conservador): solo entra la línea más nueva, que sí lo tiene", () => {
      expect(
        customerBurst([
          { role: "user", content: "¿ya me atienden?" },
          { role: "user", content: "hola", createdAt: "2026-09-19T10:00:00.000Z" },
        ])
      ).toEqual(["hola"]);
    });

    it("la línea más nueva sin createdAt también corta lo que venga detrás, aunque esa línea de atrás sí tenga fecha", () => {
      expect(
        customerBurst([
          { role: "user", content: "¿ya me atienden?", createdAt: "2026-09-19T09:59:00.000Z" },
          { role: "user", content: "hola" },
        ])
      ).toEqual(["hola"]);
    });
  });

  /**
   * Hallazgo 8 (corrección del 19/9/2026): un sticker no es ni saludo ni
   * cortesía ni una pregunta — se salta al armar la ráfaga, sin contar como
   * línea ni cortarla (mismo criterio que ya usa `mediaStreakWithoutText`
   * para no tratarlo como un adjunto pendiente).
   */
  describe("hallazgo 8 — un sticker se ignora: no cuenta ni corta la ráfaga", () => {
    it("texto + sticker + texto: el sticker desaparece del resultado y no corta nada", () => {
      expect(
        customerBurst([
          { role: "user", content: "hola", createdAt: "2026-09-19T10:00:00.000Z" },
          { role: "user", content: "[El cliente envió un sticker]", createdAt: "2026-09-19T10:00:30.000Z" },
          { role: "user", content: "buenas", createdAt: "2026-09-19T10:01:00.000Z" },
        ])
      ).toEqual(["hola", "buenas"]);
    });

    it("un sticker solo → [] (igual que antes de esta función existir, cuando lastCustomerMessage daba null para un marcador)", () => {
      expect(customerBurst([{ role: "user", content: "[El cliente envió un sticker]" }])).toEqual([]);
    });

    it("'gracias' + sticker (el sticker es lo más nuevo): la ráfaga queda ['gracias']", () => {
      expect(
        customerBurst([
          { role: "user", content: "gracias", createdAt: "2026-09-19T10:00:00.000Z" },
          { role: "user", content: "[El cliente envió un sticker]", createdAt: "2026-09-19T10:01:00.000Z" },
        ])
      ).toEqual(["gracias"]);
    });
  });
});

/**
 * T1, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): la ráfaga de líneas de cliente que le interesa al turno
 * SIGUIENTE, medida contra la marca "visto hasta" (`turn-seen.ts`) en vez de
 * (o, sin marca, además de) la ráfaga final del historial. Ver el
 * comentario de cabecera en history-line.ts para el caso real del 22/9.
 */
describe("pendingCustomerLines", () => {
  it("con marca nula, el resultado es EXACTAMENTE customerBurst(history)", () => {
    const history = [
      { role: "user", content: "hola", createdAt: "2026-09-22T10:00:00.000Z" },
      { role: "assistant", content: "¿en qué te ayudo?", createdAt: "2026-09-22T10:00:05.000Z" },
      { role: "user", content: "buenas", createdAt: "2026-09-22T10:00:10.000Z" },
    ];
    expect(pendingCustomerLines(history, null)).toEqual(customerBurst(history));
  });

  it("líneas pendientes ANTES y DESPUÉS de una respuesta del asistente entran las dos, sin que la respuesta las corte", () => {
    const history = [
      { role: "user", content: "primero", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
      { role: "assistant", content: "una respuesta cualquiera", createdAt: "2026-09-22T10:00:05.000Z" },
      { role: "user", content: "segundo", createdAt: "2026-09-22T10:00:10.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T09:59:00.000Z", ids: [] };
    expect(pendingCustomerLines(history, seen)).toEqual(["primero", "segundo"]);
  });

  it("empate de segundo: el mismo created_at, resuelto por id — el que ya está en `ids` NO es pendiente", () => {
    const history = [
      { role: "user", content: "a", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
      { role: "user", content: "b", createdAt: "2026-09-22T10:00:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T10:00:00.000Z", ids: ["m1"] };
    expect(pendingCustomerLines(history, seen)).toEqual(["b"]);
  });

  it("un sticker se salta: no cuenta como pendiente aunque sea posterior a la marca", () => {
    const history = [
      { role: "user", content: "[El cliente envió un sticker]", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
      { role: "user", content: "hola", createdAt: "2026-09-22T10:00:05.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T09:00:00.000Z", ids: [] };
    expect(pendingCustomerLines(history, seen)).toEqual(["hola"]);
  });

  it(`un hueco de más de ${CUSTOMER_BURST_GAP_MINUTES} minutos entre pendientes consecutivos corta la ráfaga: solo entra la más nueva`, () => {
    const history = [
      { role: "user", content: "vieja", createdAt: "2026-09-22T09:00:00.000Z", id: "m1" },
      { role: "user", content: "nueva", createdAt: "2026-09-22T09:15:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T08:00:00.000Z", ids: [] };
    expect(pendingCustomerLines(history, seen)).toEqual(["nueva"]);
  });

  it("una línea pendiente SIN createdAt, que no es la más nueva de todo el historial, se descarta (conservador)", () => {
    const history = [
      { role: "user", content: "sin fecha" },
      { role: "user", content: "con fecha", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T09:00:00.000Z", ids: [] };
    expect(pendingCustomerLines(history, seen)).toEqual(["con fecha"]);
  });

  it("caso real 22/9/2026: la marca en 'Color *' (ya vista por el turno anterior) recupera ['Vale', 'Gracias'], aunque Seba haya respondido en el medio", () => {
    const history = [
      { role: "user", content: "Color *", createdAt: "2026-09-22T15:24:44.000Z", id: "m-color" },
      { role: "user", content: "Vale", createdAt: "2026-09-22T15:24:53.000Z", id: "m-vale" },
      { role: "user", content: "Gracias", createdAt: "2026-09-22T15:24:54.000Z", id: "m-gracias" },
      { role: "assistant", content: "¡Un gusto ayudarte!", createdAt: "2026-09-22T15:24:59.000Z" },
    ];
    // La marca dice "el turno anterior ya vio 'Color *'" (su id está en
    // `ids`): esa línea queda EXCLUIDA de los pendientes, y quedan las dos
    // que llegaron después — las dos de cortesía, que es justo lo que hace
    // disparar la guarda de cortesía tras escalada en agent.test.ts.
    const seen: SeenMarker = { hasta: "2026-09-22T15:24:44.000Z", ids: ["m-color"] };
    expect(pendingCustomerLines(history, seen)).toEqual(["Vale", "Gracias"]);
  });
});

/**
 * T4, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): "el historial viejo marcado". Defecto A, medido en
 * producción el 22/9/2026 (hora VET) — ver el comentario de cabecera de
 * `pendingCustomerLines` para el caso completo. La última pregunta del
 * cliente antes de ese día fue "¿Tienen retrovisores de RK200?" del
 * 3/9/2026, ya respondida por un asesor ("se nos agotaron"); el 22/9 el
 * cliente escribió "Buenas tardes" y, segundos después, tres mensajes sobre
 * las tapas de la RK200. El turno tomó la pregunta vieja como la consulta
 * actual y escaló ofreciendo confirmar LOS RETROVISORES en vez de las
 * tapas — nada en el historial le decía al modelo que esa pregunta ya
 * estaba atendida.
 */
describe("previousConversationCutoff", () => {
  const HISTORIAL_RETROVISORES = [
    { role: "user", content: "Tienen retrovisores de RK200 ?", createdAt: "2026-09-03T14:00:00.000Z", id: "m-retro" },
    { role: "assistant", content: "se nos agotaron", createdAt: "2026-09-03T14:05:00.000Z", id: "m-agotaron" },
    { role: "user", content: "Buenas tardes", createdAt: "2026-09-22T15:24:14.000Z", id: "m-tardes" },
    { role: "user", content: "Llegaron las tapas de la Rk 200", createdAt: "2026-09-22T15:24:24.000Z", id: "m-tapas" },
    { role: "user", content: "?", createdAt: "2026-09-22T15:24:26.000Z", id: "m-signo" },
    { role: "user", content: "Coño negro", createdAt: "2026-09-22T15:24:28.000Z", id: "m-negro" },
  ];

  it("caso real: con la marca en 'Buenas tardes' (ya vista), el corte queda en 'Buenas tardes' — antes de eso es la conversación de los retrovisores, después son las tapas", () => {
    const seen: SeenMarker = { hasta: "2026-09-22T15:24:14.000Z", ids: ["m-tardes"] };
    expect(previousConversationCutoff(HISTORIAL_RETROVISORES, seen)).toEqual({
      cutoffAt: "2026-09-22T15:24:14.000Z",
    });
  });

  it("sin hueco de más de 12 h antes de la primera pendiente, no da corte", () => {
    const history = [
      { role: "user", content: "vieja", createdAt: "2026-09-22T09:00:00.000Z", id: "m1" },
      { role: "assistant", content: "respuesta", createdAt: "2026-09-22T09:05:00.000Z" },
      { role: "user", content: "nueva", createdAt: "2026-09-22T09:10:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T09:00:00.000Z", ids: ["m1"] };
    expect(previousConversationCutoff(history, seen)).toBeNull();
  });

  it("un hueco de más de 12 h que queda DESPUÉS de la primera pendiente no la parte", () => {
    const history = [
      { role: "user", content: "vieja", createdAt: "2026-09-22T09:00:00.000Z", id: "m1" },
      { role: "user", content: "pendiente", createdAt: "2026-09-22T09:05:00.000Z", id: "m2" },
      // Hueco de 20 h entre "pendiente" y lo que viene después — es DESPUÉS
      // de la primera pendiente, así que no cuenta.
      { role: "assistant", content: "respuesta tardía", createdAt: "2026-09-23T05:05:00.000Z" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-22T08:00:00.000Z", ids: [] };
    expect(previousConversationCutoff(history, seen)).toBeNull();
  });

  it(`hueco de EXACTAMENTE 12 horas: no corta (literal en el test, no el símbolo ${"PREVIOUS_CONVERSATION_GAP_HOURS"} importado — trampa CLAUDE.md)`, () => {
    const history = [
      { role: "user", content: "vieja", createdAt: "2026-09-01T00:00:00.000Z", id: "m1" },
      // 2026-09-01T12:00:00.000Z es EXACTAMENTE 12 horas después: 12 * 60 *
      // 60 * 1000 ms, escrito acá a mano, no con la constante importada.
      { role: "user", content: "pendiente", createdAt: "2026-09-01T12:00:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-08-31T23:00:00.000Z", ids: [] };
    expect(previousConversationCutoff(history, seen)).toBeNull();
  });

  it("hueco de 12 horas y 1 minuto: SÍ corta (literal en el test, no el símbolo importado)", () => {
    const history = [
      { role: "user", content: "vieja", createdAt: "2026-09-01T00:00:00.000Z", id: "m1" },
      { role: "user", content: "pendiente", createdAt: "2026-09-01T12:01:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-08-31T23:00:00.000Z", ids: [] };
    expect(previousConversationCutoff(history, seen)).toEqual({ cutoffAt: "2026-09-01T12:01:00.000Z" });
  });

  it("sin ninguna línea pendiente, no hay nada que cortar", () => {
    const history = [{ role: "user", content: "todo visto", createdAt: "2026-09-01T00:00:00.000Z", id: "m1" }];
    const seen: SeenMarker = { hasta: "2026-09-01T00:00:00.000Z", ids: ["m1"] };
    expect(previousConversationCutoff(history, seen)).toBeNull();
  });

  it("la primera pendiente es la primera línea de todo el historial: nada antes que mirar", () => {
    const history = [{ role: "user", content: "primera", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" }];
    expect(previousConversationCutoff(history, null)).toBeNull();
  });

  it("toma el hueco MÁS RECIENTE (el más cercano a la primera pendiente) cuando hay más de uno, aunque el más cercano termine EN la propia línea pendiente", () => {
    const history = [
      { role: "user", content: "hace un mes largo", createdAt: "2026-08-01T00:00:00.000Z", id: "m0" },
      // Hueco de ~50 días acá.
      { role: "user", content: "hace dos días", createdAt: "2026-09-20T00:00:00.000Z", id: "m1" },
      // Hueco de ~2 días acá, más cerca de la pendiente: este es el que se
      // reporta, aunque su segunda línea sea la propia pendiente.
      { role: "user", content: "pendiente", createdAt: "2026-09-22T10:00:00.000Z", id: "m2" },
    ];
    const seen: SeenMarker = { hasta: "2026-09-21T00:00:00.000Z", ids: [] };
    expect(previousConversationCutoff(history, seen)).toEqual({ cutoffAt: "2026-09-22T10:00:00.000Z" });
  });

  it(`la constante exportada vale ${12}`, () => {
    expect(PREVIOUS_CONVERSATION_GAP_HOURS).toBe(12);
  });
});

describe("latestCustomerMarker", () => {
  it("historial vacío → null", () => {
    expect(latestCustomerMarker([])).toBeNull();
  });

  it("sin ninguna línea de cliente con createdAt parseable → null", () => {
    expect(latestCustomerMarker([{ role: "user", content: "hola" }])).toBeNull();
  });

  it("toma la línea de cliente con el created_at MÁS NUEVO, ignorando las líneas del asistente", () => {
    expect(
      latestCustomerMarker([
        { role: "user", content: "primero", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
        { role: "assistant", content: "respuesta", createdAt: "2026-09-22T10:05:00.000Z" },
        { role: "user", content: "segundo", createdAt: "2026-09-22T10:10:00.000Z", id: "m2" },
      ])
    ).toEqual({ hasta: "2026-09-22T10:10:00.000Z", ids: ["m2"] });
  });

  it("dos líneas de cliente con el MISMO created_at (empate de segundo) → los dos ids", () => {
    expect(
      latestCustomerMarker([
        { role: "user", content: "a", createdAt: "2026-09-22T10:00:00.000Z", id: "m1" },
        { role: "user", content: "b", createdAt: "2026-09-22T10:00:00.000Z", id: "m2" },
      ])
    ).toEqual({ hasta: "2026-09-22T10:00:00.000Z", ids: ["m1", "m2"] });
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

// ---------------------------------------------------------------------------
// M4, plan "Seba lee fotos y audios" (16/11/2026): el historial del turno
// trae lo que el sistema LEYÓ del adjunto (transcripción o descripción) en vez
// de "no puedes verla". Los marcadores de hoy no cambian byte a byte.
// ---------------------------------------------------------------------------
function lectura(parcial: Partial<HistoryReading>): HistoryReading {
  return { status: "ok", text: null, fields: null, ...parcial };
}

function camposImagen(parcial: Record<string, unknown>): Record<string, unknown> {
  return {
    tipo: "repuesto",
    es_comprobante_pago: false,
    texto_visible: "",
    producto_visible: null,
    marca_visible: null,
    modelo_moto_visible: null,
    medida_visible: null,
    comprobante: null,
    orden_cashea: null,
    ...parcial,
  };
}

describe("historyLine — nota de voz con lectura", () => {
  it("ok con texto → transcripción entre corchetes", () => {
    expect(
      historyLine({ ...row({ message_type: "audio" }), reading: lectura({ text: "hola, buenas, tienen aceite" }) })
    ).toEqual({
      role: "user",
      content: '[Nota de voz del cliente, transcrita: "hola, buenas, tienen aceite"]',
      marcador: true,
    });
  });

  it("las comillas dobles de la transcripción pasan a simples para no romper el marco", () => {
    const linea = historyLine({ ...row({ message_type: "audio" }), reading: lectura({ text: 'dijo "ya voy" y colgó' }) });
    expect(linea?.content).toBe(`[Nota de voz del cliente, transcrita: "dijo 'ya voy' y colgó"]`);
  });

  it("recorta la transcripción a 1.000 caracteres", () => {
    const linea = historyLine({ ...row({ message_type: "audio" }), reading: lectura({ text: "a".repeat(1500) }) });
    expect(linea?.content).toBe(`[Nota de voz del cliente, transcrita: "${"a".repeat(1000)}"]`);
  });

  it("vacio → nota de voz sin palabras reconocibles", () => {
    expect(historyLine({ ...row({ message_type: "audio" }), reading: lectura({ status: "vacio" }) })?.content).toBe(
      "[El cliente envió una nota de voz sin palabras reconocibles]"
    );
  });

  it.each(["alucinacion", "fallo", "pendiente"])("%s → el marcador de hoy, sin cambios", (status) => {
    expect(historyLine({ ...row({ message_type: "audio" }), reading: lectura({ status, text: "texto" }) })?.content).toBe(
      "[El cliente envió una nota de voz; no puedes escucharla]"
    );
  });

  it("sin lectura (undefined o null) → el marcador de hoy", () => {
    expect(historyLine(row({ message_type: "audio" }))?.content).toBe("[El cliente envió una nota de voz; no puedes escucharla]");
    expect(historyLine({ ...row({ message_type: "audio" }), reading: null })?.content).toBe(
      "[El cliente envió una nota de voz; no puedes escucharla]"
    );
  });

  it("ok pero sin texto → el marcador de hoy", () => {
    expect(historyLine({ ...row({ message_type: "audio" }), reading: lectura({ text: "  " }) })?.content).toBe(
      "[El cliente envió una nota de voz; no puedes escucharla]"
    );
  });
});

describe("historyLine — foto con lectura", () => {
  it("ok con descripción y texto visible", () => {
    const linea = historyLine({
      ...row({ message_type: "image" }),
      reading: lectura({
        text: "Kit de arrastre de moto.",
        fields: camposImagen({ texto_visible: "DID 428 · 118 eslabones" }),
      }),
    });
    expect(linea).toEqual({
      role: "user",
      content: '[Foto del cliente: Kit de arrastre de moto. Texto visible: "DID 428 · 118 eslabones"]',
      marcador: true,
    });
  });

  it("la descripción va sin punto final", () => {
    const linea = historyLine({
      ...row({ message_type: "image" }),
      reading: lectura({ text: "casco integral negro.", fields: camposImagen({ tipo: "casco_o_accesorio" }) }),
    });
    expect(linea?.content).toBe("[Foto del cliente: casco integral negro]");
  });

  it("sin texto visible no agrega esa parte", () => {
    const linea = historyLine({
      ...row({ message_type: "image" }),
      reading: lectura({ text: "pastillas de freno", fields: camposImagen({}) }),
    });
    expect(linea?.content).toBe("[Foto del cliente: pastillas de freno]");
  });

  it("con pie del cliente lo agrega antes del corchete de cierre", () => {
    const linea = historyLine({
      ...row({ message_type: "image", content: "tienen este?" }),
      reading: lectura({ text: "casco integral negro", fields: camposImagen({}) }),
    });
    expect(linea?.content).toBe("[Foto del cliente: casco integral negro. Pie: tienen este?]");
  });

  it("con texto visible y pie, el pie va al final", () => {
    const linea = historyLine({
      ...row({ message_type: "image", content: "cuánto?" }),
      reading: lectura({ text: "caja de aceite", fields: camposImagen({ texto_visible: "MOTUL 5100" }) }),
    });
    expect(linea?.content).toBe('[Foto del cliente: caja de aceite. Texto visible: "MOTUL 5100". Pie: cuánto?]');
  });

  it("comprobante de pago → línea sin campos leídos", () => {
    const linea = historyLine({
      ...row({ message_type: "image", content: "ya pagué" }),
      reading: lectura({
        text: "Captura de transferencia",
        fields: camposImagen({
          tipo: "comprobante_pago",
          es_comprobante_pago: true,
          comprobante: { monto: 1234.5, moneda: "VES", referencia: "123456789", banco: "Banesco", fecha: "16/11/2026" },
        }),
      }),
    });
    expect(linea?.content).toBe("[Foto del cliente: comprobante de pago. Pie: ya pagué]");
  });

  it("la línea de un comprobante NO contiene ningún dígito aunque los campos traigan monto y referencia", () => {
    const linea = historyLine({
      ...row({ message_type: "image" }),
      reading: lectura({
        text: "Captura de transferencia 1234",
        fields: camposImagen({
          es_comprobante_pago: true,
          comprobante: { monto: 1234.5, moneda: "VES", referencia: "123456", banco: "Banesco 0134", fecha: "16/11/2026" },
        }),
      }),
    });
    expect(linea?.content).toBe("[Foto del cliente: comprobante de pago]");
    expect(linea?.content).not.toMatch(/\d/);
  });

  it("orden de Cashea", () => {
    const linea = historyLine({
      ...row({ message_type: "image" }),
      reading: lectura({
        text: "Orden de Cashea",
        fields: camposImagen({ tipo: "orden_cashea", orden_cashea: { modalidad: "retiro", total_usd: 45 } }),
      }),
    });
    expect(linea?.content).toBe("[Foto del cliente: orden de Cashea]");
  });

  it.each(["vacio", "alucinacion", "fallo", "pendiente"])("%s → el marcador de hoy", (status) => {
    expect(
      historyLine({ ...row({ message_type: "image" }), reading: lectura({ status, text: "algo", fields: camposImagen({}) }) })?.content
    ).toBe("[El cliente envió una foto sin texto; no puedes verla]");
  });

  it("con pie y lectura fallida → el marcador de hoy con su pie", () => {
    expect(
      historyLine({ ...row({ message_type: "image", content: "este" }), reading: lectura({ status: "fallo" }) })?.content
    ).toBe("[El cliente envió una foto. Pie: este]");
  });

  it("ok sin descripción (ni comprobante) → el marcador de hoy", () => {
    expect(
      historyLine({ ...row({ message_type: "image" }), reading: lectura({ text: "", fields: camposImagen({}) }) })?.content
    ).toBe("[El cliente envió una foto sin texto; no puedes verla]");
  });

  it("una lectura en un mensaje del ASESOR se ignora: su marcador no cambia", () => {
    expect(
      historyLine({ ...row({ sender_type: "agent", message_type: "image" }), reading: lectura({ text: "algo" }) })?.content
    ).toBe("[El asesor envió una foto]");
  });

  it("una lectura en un video/documento se ignora", () => {
    expect(historyLine({ ...row({ message_type: "video" }), reading: lectura({ text: "algo" }) })?.content).toBe(
      "[El cliente envió un video sin texto; no puedes verlo]"
    );
  });
});

describe("textoLeido", () => {
  it("devuelve la transcripción de una nota de voz", () => {
    expect(textoLeido('[Nota de voz del cliente, transcrita: "hola, buenas"]')).toBe("hola, buenas");
  });

  it("devuelve todo lo de adentro de una foto: descripción, texto visible y pie", () => {
    expect(textoLeido('[Foto del cliente: caja de aceite. Texto visible: "MOTUL 5100". Pie: cuánto?]')).toBe(
      'caja de aceite. Texto visible: "MOTUL 5100". Pie: cuánto?'
    );
  });

  it.each([
    "[El cliente envió una foto sin texto; no puedes verla]",
    "[El cliente envió una nota de voz sin palabras reconocibles]",
    "[El asesor envió una foto]",
    "hola, buenas",
    "",
  ])("%j → null", (texto) => {
    expect(textoLeido(texto)).toBeNull();
  });
});

describe("las líneas leídas no son 'sin texto'", () => {
  const leidas = [
    '[Nota de voz del cliente, transcrita: "hola"]',
    "[Foto del cliente: casco integral negro]",
    "[Foto del cliente: comprobante de pago]",
  ];

  it.each(leidas)("isHistoryMarker(%s) es false", (linea) => {
    expect(isHistoryMarker(linea)).toBe(false);
  });

  it("mediaStreakWithoutText no cuenta un audio ok y lo trata como texto del cliente (corta la racha)", () => {
    const racha = mediaStreakWithoutText([
      { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
      { role: "assistant", content: "¿qué repuesto buscas?" },
      { role: "user", content: '[Nota de voz del cliente, transcrita: "busco pastillas"]' },
      { role: "user", content: "[El cliente envió una foto sin texto; no puedes verla]" },
    ]);
    expect(racha.adjuntos).toBe(1);
    expect(racha.yaPreguntamos).toBe(false);
  });

  it("mediaStreakWithoutText SÍ cuenta la nota de voz sin palabras reconocibles", () => {
    const racha = mediaStreakWithoutText([
      { role: "user", content: "[El cliente envió una nota de voz sin palabras reconocibles]" },
      { role: "assistant", content: "¿me lo escribes?" },
      { role: "user", content: "[El cliente envió una nota de voz sin palabras reconocibles]" },
    ]);
    expect(racha).toEqual({ adjuntos: 2, yaPreguntamos: true, tipos: ["una nota de voz", "una nota de voz"] });
  });
});

describe("la ráfaga y los pendientes ven el texto leído, no los corchetes", () => {
  it("customerBurst devuelve la transcripción en vez de la línea con corchetes", () => {
    expect(
      customerBurst([
        { role: "user", content: '[Nota de voz del cliente, transcrita: "hola, buenas"]', createdAt: "2026-11-16T10:00:00.000Z" },
        { role: "user", content: "[Foto del cliente: casco integral negro. Pie: este]", createdAt: "2026-11-16T10:00:20.000Z" },
      ])
    ).toEqual(["hola, buenas", "casco integral negro. Pie: este"]);
  });

  it("pendingCustomerLines también (con y sin marca)", () => {
    const historial = [
      { role: "user", content: "viejo", createdAt: "2026-11-16T09:00:00.000Z", id: "a" },
      { role: "assistant", content: "ok", createdAt: "2026-11-16T09:01:00.000Z", id: "b" },
      {
        role: "user",
        content: '[Nota de voz del cliente, transcrita: "tienen aceite"]',
        createdAt: "2026-11-16T10:00:00.000Z",
        id: "c",
      },
    ];
    expect(pendingCustomerLines(historial, null)).toEqual(["tienen aceite"]);
    expect(pendingCustomerLines(historial, { hasta: "2026-11-16T09:00:00.000Z", ids: ["a"] })).toEqual(["tienen aceite"]);
  });

  it("el `content` que viaja al modelo en el historial no cambia: el arreglo original conserva los corchetes", () => {
    const historial = [{ role: "user", content: '[Nota de voz del cliente, transcrita: "hola"]', id: "c" }];
    pendingCustomerLines(historial, null);
    expect(historial[0].content).toBe('[Nota de voz del cliente, transcrita: "hola"]');
  });
});

describe("pendingCustomerEntries", () => {
  const historial = [
    { role: "user", content: "primero", createdAt: "2026-11-16T09:00:00.000Z", id: "a", lectura: "L-a" },
    { role: "assistant", content: "ok", createdAt: "2026-11-16T09:01:00.000Z", id: "b", lectura: null },
    { role: "user", content: "[El cliente envió un sticker]", createdAt: "2026-11-16T10:00:00.000Z", id: "s", lectura: null },
    {
      role: "user",
      content: "[Foto del cliente: comprobante de pago]",
      createdAt: "2026-11-16T10:00:10.000Z",
      id: "c",
      lectura: "L-c",
    },
    { role: "user", content: "gracias", createdAt: "2026-11-16T10:00:20.000Z", id: "d", lectura: null },
  ];

  const marcas: (SeenMarker | null)[] = [
    null,
    { hasta: "2026-11-16T09:00:00.000Z", ids: ["a"] },
    { hasta: "2026-11-16T10:00:10.000Z", ids: ["c"] },
    { hasta: "2026-11-16T10:00:20.000Z", ids: ["d"] },
  ];

  it.each(marcas.map((m, i) => [i, m] as const))("misma selección que pendingCustomerLines (marca #%i)", (_i, marca) => {
    const entradas = pendingCustomerEntries(historial, marca);
    const lineas = pendingCustomerLines(historial, marca);
    expect(entradas.map((e) => textoLeido(e.content) ?? e.content)).toEqual(lineas);
  });

  it("devuelve las entradas ORIGINALES (con sus campos extra), no copias recortadas", () => {
    const entradas = pendingCustomerEntries(historial, null);
    expect(entradas.map((e) => e.id)).toEqual(["c", "d"]);
    expect(entradas[0]).toBe(historial[3]);
    expect(entradas[0].lectura).toBe("L-c");
  });
});
