import { describe, expect, it } from "vitest";
import type { ImageFields } from "@/lib/media-reading-fields";
import { decidirApertura, elegirFrase, esPostventa, esSoloSaludo, type EntradaDeApertura } from "./apertura";
import { estadoInicial, type EstadoSeba } from "./tipos";

// Cuatro frases como las del mensaje 2 por defecto (la lista real vive en la
// configuración del supervisor; acá solo importa que sean cuatro y distintas).
const FRASES = [
  "Cuéntame, ¿qué estás buscando?",
  "¿En qué te puedo ayudar hoy?",
  "Dime qué repuesto o accesorio necesitas.",
  "¿Qué producto te interesa?",
];

const AHORA = new Date("2026-11-17T15:00:00.000Z");

function lectura(parcial: Partial<ImageFields> = {}): ImageFields {
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

function estadoHace(dias: number, etapa: EstadoSeba["etapa"]): EstadoSeba {
  return {
    ...estadoInicial(AHORA),
    etapa,
    actualizadoEn: new Date(AHORA.getTime() - dias * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function entrada(parcial: Partial<EntradaDeApertura> = {}): EntradaDeApertura {
  return {
    conversationId: "conv-1",
    ventanaNueva: true,
    rafaga: ["Buenas"],
    lecturas: [],
    asesorAtendiendo: false,
    escaladaAbierta: false,
    estado: null,
    now: AHORA,
    welcomeText: "Bienvenido a SBK Motors. Horario y pagos aquí.",
    followups: FRASES,
    ultimaFraseUsada: null,
    ...parcial,
  };
}

describe("esSoloSaludo", () => {
  it("«Buenas tardes» sí; la pregunta con producto no", () => {
    expect(esSoloSaludo(["Buenas tardes"])).toBe(true);
    expect(esSoloSaludo(["Hola, precio del impermeable Givi"])).toBe(false);
  });

  it("un signo de pregunta lo descarta aunque la palabra sea un saludo", () => {
    expect(esSoloSaludo(["Hola?"])).toBe(false);
    expect(esSoloSaludo(["¿Hola"])).toBe(false);
  });

  it("la ráfaga vacía no es solo saludo", () => {
    expect(esSoloSaludo([])).toBe(false);
  });

  it("toda la ráfaga tiene que ser saludo", () => {
    expect(esSoloSaludo(["Hola", "Buenas", "Buen día"])).toBe(true);
    expect(esSoloSaludo(["Hola", "tienen pastillas"])).toBe(false);
  });
});

describe("esPostventa", () => {
  it.each([
    "Realicé la compra de unas pastillas",
    "ya pagué",
    "Ya hice el pago",
    "hice el pago ayer",
    "compré un casco el lunes",
    "Pague por pago movil",
    "ya transferí",
    "ya cancelé la factura",
    "ya lo pagué",
    "¿y mi guía?",
    "me pasas el tracking",
    "el número de guía por favor",
    "¿cómo va mi pedido?",
    "sobre mi compra",
    "mi orden no ha llegado",
  ])("«%s» es postventa", (texto) => {
    expect(esPostventa([texto], [])).toBe(true);
  });

  it.each([
    "¿Puedo pagar con Cashea?",
    "quiero comprar un casco",
    "¿cuánto cuesta el pedido mínimo?",
    "Hola, precio del impermeable Givi",
    "cuando pague te mando el comprobante",
    "si compre hoy, ¿llega mañana?",
  ])("«%s» no es postventa", (texto) => {
    expect(esPostventa([texto], [])).toBe(false);
  });

  it("basta una línea de la ráfaga", () => {
    expect(esPostventa(["Hola", "buenas tardes", "ya pagué"], [])).toBe(true);
  });

  it("una lectura de comprobante, de orden de Cashea o de guía MRW lo es; un repuesto no", () => {
    expect(esPostventa([], [lectura({ tipo: "comprobante_pago" })])).toBe(true);
    expect(esPostventa([], [lectura({ es_comprobante_pago: true })])).toBe(true);
    expect(esPostventa([], [lectura({ tipo: "orden_cashea" })])).toBe(true);
    expect(esPostventa([], [lectura({ tipo: "guia_mrw" })])).toBe(true);
    expect(esPostventa([], [lectura({ tipo: "repuesto" })])).toBe(false);
  });
});

describe("decidirApertura", () => {
  it("A1: solo saluda → mensaje 1 y frase fija", () => {
    const d = decidirApertura(entrada());
    expect(d.apertura).toBe(true);
    expect(d.mensaje1).toBe("Bienvenido a SBK Motors. Horario y pagos aquí.");
    expect(FRASES).toContain(d.mensaje2Fijo);
  });

  it("A2: abre con la pregunta → mensaje 1 y el mensaje 2 lo redacta el modelo", () => {
    const d = decidirApertura(entrada({ rafaga: ["Hola, precio del impermeable Givi"] }));
    expect(d).toEqual({
      apertura: true,
      mensaje1: "Bienvenido a SBK Motors. Horario y pagos aquí.",
      mensaje2Fijo: null,
    });
  });

  it("A3: abre con una foto sin texto → mensaje 1 y respuesta del modelo", () => {
    const d = decidirApertura(entrada({ rafaga: [], lecturas: [lectura({ tipo: "casco_o_accesorio" })] }));
    expect(d.apertura).toBe(true);
    expect(d.mensaje1).not.toBeNull();
    expect(d.mensaje2Fijo).toBeNull();
  });

  it("A3: «Hola» más una foto leída → no sale la frase fija, el modelo responde sobre la foto", () => {
    const d = decidirApertura(entrada({ rafaga: ["Hola"], lecturas: [lectura({ tipo: "repuesto" })] }));
    expect(d.mensaje1).not.toBeNull();
    expect(d.mensaje2Fijo).toBeNull();
  });

  it("A4: ya compró (por texto) → sin bienvenida informativa, sin frase fija", () => {
    const d = decidirApertura(entrada({ rafaga: ["Realicé la compra de unas pastillas"] }));
    expect(d).toEqual({ apertura: true, mensaje1: null, mensaje2Fijo: null });
  });

  it("A4: manda un comprobante (por lectura) → sin bienvenida informativa", () => {
    const d = decidirApertura(entrada({ rafaga: [], lecturas: [lectura({ tipo: "comprobante_pago" })] }));
    expect(d).toEqual({ apertura: true, mensaje1: null, mensaje2Fijo: null });
  });

  it("A5: con un asesor atendiendo no sale nada", () => {
    const d = decidirApertura(entrada({ asesorAtendiendo: true }));
    expect(d).toEqual({ apertura: false, mensaje1: null, mensaje2Fijo: null });
  });

  it("A5: con la escalada abierta no sale nada", () => {
    const d = decidirApertura(entrada({ escaladaAbierta: true }));
    expect(d).toEqual({ apertura: false, mensaje1: null, mensaje2Fijo: null });
  });

  it("sin ventana nueva no hay apertura", () => {
    const d = decidirApertura(entrada({ ventanaNueva: false }));
    expect(d).toEqual({ apertura: false, mensaje1: null, mensaje2Fijo: null });
  });

  it("A6: pedido de 3 días en «datos_enviados» → sin bloque informativo; con 8 días → con él", () => {
    const reciente = decidirApertura(entrada({ estado: estadoHace(3, "datos_enviados") }));
    expect(reciente.apertura).toBe(true);
    expect(reciente.mensaje1).toBeNull();
    // El mensaje 2 sigue su propia regla: solo saludó → frase fija.
    expect(reciente.mensaje2Fijo).not.toBeNull();

    const vencido = decidirApertura(entrada({ estado: estadoHace(8, "datos_enviados") }));
    expect(vencido.mensaje1).toBe("Bienvenido a SBK Motors. Horario y pagos aquí.");
  });

  it("A6: «eligiendo_pago» reciente también omite el bloque; «cotizado» no", () => {
    expect(decidirApertura(entrada({ estado: estadoHace(1, "eligiendo_pago") })).mensaje1).toBeNull();
    expect(decidirApertura(entrada({ estado: estadoHace(1, "cotizado") })).mensaje1).not.toBeNull();
  });

  it("A6: con el estado vigente y una pregunta, el mensaje 2 lo redacta el modelo", () => {
    const d = decidirApertura(
      entrada({ estado: estadoHace(2, "eligiendo_pago"), rafaga: ["¿me confirman el total?"] }),
    );
    expect(d).toEqual({ apertura: true, mensaje1: null, mensaje2Fijo: null });
  });

  it("A7: cinco saludos seguidos → una sola decisión con mensaje 1 y frase fija", () => {
    const d = decidirApertura(entrada({ rafaga: ["Hola", "Buenas", "Buenos días", "Hola", "Saludos"] }));
    expect(d.apertura).toBe(true);
    expect(d.mensaje1).not.toBeNull();
    expect(d.mensaje2Fijo).not.toBeNull();
  });

  it("A7: cinco mensajes con una pregunta en medio → sin frase fija", () => {
    const d = decidirApertura(entrada({ rafaga: ["Hola", "Buenas", "precio del casco LS2", "Hola", "Saludos"] }));
    expect(d.apertura).toBe(true);
    expect(d.mensaje1).not.toBeNull();
    expect(d.mensaje2Fijo).toBeNull();
  });

  it("un welcomeText vacío deja el mensaje 1 en null sin romper", () => {
    expect(decidirApertura(entrada({ welcomeText: "" })).mensaje1).toBeNull();
    expect(decidirApertura(entrada({ welcomeText: "  \n " })).mensaje1).toBeNull();
    expect(decidirApertura(entrada({ welcomeText: "" })).apertura).toBe(true);
  });

  it("la frase fija no repite la última usada, para ninguna de las cuatro", () => {
    for (const ultima of FRASES) {
      const d = decidirApertura(entrada({ ultimaFraseUsada: ultima }));
      expect(d.mensaje2Fijo).not.toBeNull();
      expect(d.mensaje2Fijo).not.toBe(ultima);
    }
  });
});

describe("elegirFrase", () => {
  it("es determinista: misma entrada, misma frase", () => {
    const a = elegirFrase(FRASES, null, "conv-1", AHORA);
    const b = elegirFrase(FRASES, null, "conv-1", new Date(AHORA.getTime() + 60_000));
    expect(a).toBe(b);
  });

  it("cambia de día (fecha de Caracas) para alguna conversación", () => {
    // El día de Caracas es UTC-4: 03:59 UTC del 18 todavía es el 17 allá.
    const mismoDia = elegirFrase(FRASES, null, "conv-x", new Date("2026-11-18T03:59:00.000Z"));
    expect(mismoDia).toBe(elegirFrase(FRASES, null, "conv-x", new Date("2026-11-17T12:00:00.000Z")));

    const elegidas = new Set<string | null>();
    for (let dia = 1; dia <= 20; dia++) {
      elegidas.add(elegirFrase(FRASES, null, "conv-x", new Date(Date.UTC(2026, 10, dia, 16))));
    }
    expect(elegidas.size).toBeGreaterThan(1);
  });

  it("reparte entre las frases según la conversación", () => {
    const elegidas = new Set<string | null>();
    for (let i = 0; i < 40; i++) elegidas.add(elegirFrase(FRASES, null, `conv-${i}`, AHORA));
    expect(elegidas.size).toBeGreaterThan(1);
  });

  it("descarta vacías y la última usada", () => {
    expect(elegirFrase(["", "  ", "A", "B"], "A", "c", AHORA)).toBe("B");
  });

  it("con una sola frase que ya fue la última, la repite antes que callar", () => {
    expect(elegirFrase(["Única"], "Única", "c", AHORA)).toBe("Única");
  });

  it("sin ninguna utilizable, null", () => {
    expect(elegirFrase([], null, "c", AHORA)).toBeNull();
    expect(elegirFrase(["", "   "], null, "c", AHORA)).toBeNull();
  });
});
