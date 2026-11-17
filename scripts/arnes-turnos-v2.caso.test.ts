import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { derivarRafaga } from "@/lib/seba2/contexto";
import { AREAS } from "@/lib/seba-v2-config";
import { faltantesDelEntorno, historialDeCaso, parseCasos, type CasoArnes } from "./arnes-turnos-v2.caso";

// Martes 17/11/2026 11:00 en Caracas.
const AHORA = new Date("2026-11-17T15:00:00.000Z");

function linea(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "c1",
    fuente: "ejemplar",
    historial: [],
    rafaga: ["hola"],
    estado: null,
    esperado: {},
    ...over,
  });
}

const COMPROBANTE = {
  tipo: "comprobante_pago",
  es_comprobante_pago: true,
  texto_visible: "",
  comprobante: { monto: 10, moneda: "VES", referencia: "123456", banco: "Banco de Ejemplo", fecha: null },
};

describe("parseCasos", () => {
  it("lee un caso por línea, salta las líneas en blanco y normaliza los opcionales", () => {
    const casos = parseCasos(`${linea({ id: "a" })}\n\n${linea({ id: "b", escaladaAbierta: true })}\n`, "x.jsonl");
    expect(casos.map((c) => c.id)).toEqual(["a", "b"]);
    expect(casos[0].estado).toBeNull();
    expect(casos[0].escaladaAbierta).toBeUndefined();
    expect(casos[1].escaladaAbierta).toBe(true);
  });

  it("una línea que no es JSON lanza con el archivo y el número de línea", () => {
    const jsonl = `${linea({ id: "a" })}\n\n{esto no es json}\n`;
    expect(() => parseCasos(jsonl, "casos.jsonl")).toThrow(/casos\.jsonl:3: no es JSON válido/);
  });

  it("un caso mal formado lanza con el número de línea del archivo (las vacías cuentan)", () => {
    const jsonl = `${linea({ id: "a" })}\n\n${linea({ id: "b", fuente: "inventada" })}\n`;
    expect(() => parseCasos(jsonl, "casos.jsonl")).toThrow(/casos\.jsonl:3: «fuente» tiene que ser/);
  });

  it.each([
    ["sin id", { id: "" }, /«id»/],
    ["rafaga que no son textos", { rafaga: [1] }, /«rafaga»/],
    ["sin nada que contestar", { rafaga: [] }, /nada que contestar/],
    ["haceMin menor a 1", { historial: [{ de: "seba", texto: "hola", haceMin: 0 }] }, /haceMin/],
    ["autor desconocido", { historial: [{ de: "robot", texto: "hola", haceMin: 5 }] }, /historial\[0\]\.de/],
    ["texto vacío sin lectura", { historial: [{ de: "seba", texto: " ", haceMin: 5 }] }, /no puede estar vacío/],
    ["lectura inválida", { historial: [{ de: "cliente", texto: "", haceMin: 5, lectura: { tipo: "inventado" } }] }, /lectura válida/],
    ["área inválida", { esperado: { debePasar: { area: "marte" } } }, /área válida/],
    ["motivo inválido", { esperado: { debePasar: { area: "ventas", motivo: "inventado" } } }, /motivo/],
    ["estado inválido", { estado: { etapa: "inventada" } }, /«estado»/],
    ["rafagaLecturas inválida", { rafagaLecturas: [{ tipo: "inventado" }] }, /rafagaLecturas\[0\]/],
    ["noDebePasar que no es booleano", { esperado: { noDebePasar: "si" } }, /noDebePasar/],
  ])("rechaza: %s", (_nombre, over, mensaje) => {
    expect(() => parseCasos(linea(over), "x.jsonl")).toThrow(mensaje);
  });

  it("rechaza un id repetido y dice en qué línea se usó antes", () => {
    expect(() => parseCasos(`${linea()}\n${linea()}`, "x.jsonl")).toThrow(/x\.jsonl:2: el id «c1» ya se usó en la línea 1/);
  });

  it("rechaza un historial que termina en un mensaje reciente del cliente (se fusionaría con la ráfaga)", () => {
    const over = { historial: [{ de: "cliente", texto: "una pregunta", haceMin: 5 }] };
    expect(() => parseCasos(linea(over), "x.jsonl")).toThrow(/se fusionaría con la ráfaga/);
    // Con más de 10 minutos de hueco sí es otra ráfaga.
    expect(() => parseCasos(linea({ historial: [{ de: "cliente", texto: "una pregunta", haceMin: 30 }] }), "x.jsonl")).not.toThrow();
    // Y con la respuesta de Seba en medio también.
    const conRespuesta = {
      historial: [
        { de: "cliente", texto: "una pregunta", haceMin: 6 },
        { de: "seba", texto: "una respuesta", haceMin: 5 },
      ],
    };
    expect(() => parseCasos(linea(conRespuesta), "x.jsonl")).not.toThrow();
  });

  it("acepta una ráfaga que solo trae un comprobante", () => {
    const [caso] = parseCasos(linea({ rafaga: [], rafagaLecturas: [COMPROBANTE] }), "x.jsonl");
    expect(caso.rafagaLecturas).toHaveLength(1);
    expect(caso.rafagaLecturas?.[0].comprobante?.referencia).toBe("123456");
  });

  it("el ejemplo sintético del repositorio parsea entero y todos sus casos son válidos", () => {
    const archivo = path.resolve(process.cwd(), "privado", "seba-v2", "ejemplo.sintetico.jsonl");
    const casos = parseCasos(fs.readFileSync(archivo, "utf8"), "ejemplo.sintetico.jsonl");
    expect(casos.length).toBeGreaterThanOrEqual(6);
    expect(casos.length).toBeLessThanOrEqual(8);
    expect(new Set(casos.map((c) => c.id)).size).toBe(casos.length);
    // Cubre lo que el brief pide: comprobante con lectura, escalada abierta, reclamo, pedir una persona, Cashea, saludo, aceite.
    expect(casos.some((c) => (c.rafagaLecturas ?? []).some((l) => l.es_comprobante_pago))).toBe(true);
    expect(casos.some((c) => c.escaladaAbierta === true)).toBe(true);
    expect(casos.some((c) => c.esperado.debePasar?.area === "reclamos")).toBe(true);
    expect(casos.some((c) => c.esperado.debePasar?.motivo === "pide_persona")).toBe(true);
    expect(casos.some((c) => c.rafaga.join(" ").toLowerCase().includes("cashea"))).toBe(true);
    expect(casos.some((c) => c.rafaga.join(" ").toLowerCase().includes("20w50"))).toBe(true);
    for (const c of casos) {
      // Sin productos reales: no sabemos qué hay en la base del VPS.
      expect(c.esperado.productosValidos).toBeUndefined();
      for (const area of [c.esperado.debePasar?.area].filter((a) => a !== undefined)) expect(AREAS).toContain(area);
    }
  });

  it("el ejemplo sintético no trae datos reales (teléfonos largos, correos, cédulas)", () => {
    const archivo = path.resolve(process.cwd(), "privado", "seba-v2", "ejemplo.sintetico.jsonl");
    const texto = fs.readFileSync(archivo, "utf8");
    expect(texto).not.toMatch(/\b0?4(12|14|16|24|26)[- ]?\d{7}\b/);
    expect(texto).not.toMatch(/\+?58\d{9,}/);
    expect(texto).not.toMatch(/\S+@\S+\.\S+/);
    expect(texto).not.toMatch(/\b[VEJ]-?\d{6,}\b/);
  });
});

function caso(over: Partial<CasoArnes> = {}): CasoArnes {
  return {
    id: "h1",
    fuente: "ejemplar",
    historial: [],
    rafaga: ["hola"],
    estado: null,
    esperado: {},
    ...over,
  };
}

describe("historialDeCaso", () => {
  it("arma cuatro arreglos paralelos en orden cronológico, con los roles de cada autor", () => {
    const h = historialDeCaso(
      caso({
        // Escrito a propósito FUERA de orden: el historial se ordena por antigüedad.
        historial: [
          { de: "seba", texto: "respuesta", haceMin: 19 },
          { de: "cliente", texto: "pregunta", haceMin: 20 },
          { de: "asesor", texto: "nota del asesor", haceMin: 18 },
        ],
        rafaga: ["uno", "dos"],
      }),
      AHORA
    );
    expect(h.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "user"]);
    expect(h.messages.map((m) => m.content)).toEqual(["pregunta", "respuesta", "nota del asesor", "uno", "dos"]);
    const largo = h.messages.length;
    expect([h.createdAt.length, h.ids.length, h.lecturas.length]).toEqual([largo, largo, largo]);
    const fechas = h.createdAt.map((f) => Date.parse(f as string));
    expect([...fechas].sort((a, b) => a - b)).toEqual(fechas);
    expect(new Set(h.ids).size).toBe(largo);
    expect(h.ids.every((id) => typeof id === "string" && id.startsWith("arnes-h1-"))).toBe(true);
  });

  it("un comprobante de la ráfaga aparece como lo escribiría historyLine, y derivarRafaga lo recupera con su lectura", () => {
    const [con] = parseCasos(
      linea({
        historial: [
          { de: "cliente", texto: "pago móvil", haceMin: 30 },
          { de: "seba", texto: "datos de pago", haceMin: 29 },
        ],
        rafaga: ["listo, ya pagué"],
        rafagaLecturas: [COMPROBANTE],
      }),
      "x.jsonl"
    );
    const h = historialDeCaso(con, AHORA);
    expect(h.messages.at(-1)).toEqual({ role: "user", content: "[Foto del cliente: comprobante de pago]" });

    const rafaga = derivarRafaga(h, null, AHORA);
    expect(rafaga.lineas).toEqual(["listo, ya pagué", "comprobante de pago"]);
    expect(rafaga.lecturas).toHaveLength(1);
    expect(rafaga.lecturas[0].comprobante?.banco).toBe("Banco de Ejemplo");
    expect(rafaga.ventanaNueva).toBe(false);
    expect(rafaga.triggerMessageId).toBe(h.ids.at(-1));
  });

  it("una foto del historial con lectura, una nota de voz transcrita y un adjunto sin lectura salen como los escribe historyLine", () => {
    const h = historialDeCaso(
      caso({
        historial: [
          {
            de: "cliente",
            texto: "",
            haceMin: 40,
            lectura: { tipo: "repuesto", es_comprobante_pago: false, texto_visible: "", producto_visible: "amortiguador", marca_visible: null, modelo_moto_visible: null, medida_visible: null, comprobante: null, orden_cashea: null },
          },
          { de: "seba", texto: "¿qué moto tienes?", haceMin: 39 },
          { de: "cliente", texto: "", haceMin: 30, lectura: { transcripcion: "es una moto de ejemplo" } },
          { de: "seba", texto: "anotado", haceMin: 29 },
        ],
      }),
      AHORA
    );
    expect(h.messages[0].content).toBe("[Foto del cliente: amortiguador]");
    expect(h.messages[2].content).toBe('[Nota de voz del cliente, transcrita: "es una moto de ejemplo"]');
    // La lectura viaja en el arreglo paralelo, con la forma de HistoryReading.
    expect(h.lecturas[0]).toMatchObject({ status: "ok", text: "amortiguador" });
    expect(h.lecturas[2]).toEqual({ status: "ok", text: "es una moto de ejemplo", fields: null });
    // Un mensaje de Seba o del asesor nunca lleva lectura.
    expect(h.lecturas[1]).toBeNull();
  });

  it("derivarRafaga recupera EXACTAMENTE la ráfaga del caso y abre ventana nueva solo sin historial o tras 24 h", () => {
    const sin = derivarRafaga(historialDeCaso(caso({ rafaga: ["a", "b", "c"] }), AHORA), null, AHORA);
    expect(sin.lineas).toEqual(["a", "b", "c"]);
    expect(sin.ventanaNueva).toBe(true);

    const reciente = derivarRafaga(
      historialDeCaso(caso({ historial: [{ de: "cliente", texto: "antes", haceMin: 120 }, { de: "seba", texto: "ok", haceMin: 119 }] }), AHORA),
      null,
      AHORA
    );
    expect(reciente.lineas).toEqual(["hola"]);
    expect(reciente.ventanaNueva).toBe(false);

    const vieja = derivarRafaga(
      historialDeCaso(caso({ historial: [{ de: "cliente", texto: "antes", haceMin: 60 * 30 }, { de: "seba", texto: "ok", haceMin: 60 * 30 - 1 }] }), AHORA),
      null,
      AHORA
    );
    expect(vieja.ventanaNueva).toBe(true);
  });
});

describe("faltantesDelEntorno", () => {
  const completo = { ARNES_SUPABASE_URL: "http://x", ARNES_SUPABASE_KEY: "k", OPENAI_API_KEY: "o" };

  it("vacío cuando está todo", () => {
    expect(faltantesDelEntorno(completo)).toEqual([]);
  });

  it("nombra lo que falta, sin valores", () => {
    expect(faltantesDelEntorno({})).toEqual(["ARNES_SUPABASE_URL", "ARNES_SUPABASE_KEY", "OPENAI_API_KEY"]);
    expect(faltantesDelEntorno({ ARNES_SUPABASE_URL: "http://x", OPENAI_API_KEY: "o" })).toEqual(["ARNES_SUPABASE_KEY"]);
  });

  it("pide la llave de Google si el proveedor es Google o el modelo es gemini", () => {
    const sinGoogle = { ARNES_SUPABASE_URL: "u", ARNES_SUPABASE_KEY: "k", OPENAI_API_KEY: "o" };
    expect(faltantesDelEntorno({ ...sinGoogle, AI_AGENT_PROVIDER: "google" })).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY"]);
    expect(faltantesDelEntorno({ ...sinGoogle, AI_AGENT_MODEL: "gemini-3.1-flash-lite" })).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY"]);
    // Un override explícito a openai gana sobre el nombre del modelo (misma regla que model.ts).
    expect(faltantesDelEntorno({ ...sinGoogle, AI_AGENT_PROVIDER: "openai", AI_AGENT_MODEL: "gemini-x" })).toEqual([]);
  });
});
