import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS, turnClockLine } from "@/lib/business-hours";
import { formatCrmDateTime } from "@/lib/time-zone";
import {
  buildSeba2Instructions,
  MAX_PENDING_LINE_CHARS,
  MAX_PENDING_LINES,
  SEBA2_SYSTEM_PROMPT,
  seba2Prefix,
  type Seba2Context,
} from "@/lib/seba2/prompt";
import { estadoInicial, type EstadoSeba } from "@/lib/seba2/tipos";

/**
 * El texto del prompt de Seba v2 vive en DOS sitios: el documento de diseño
 * (`docs/seba-v2/system-prompt-seba-v2.md`, §1, aprobado el 16/11/2026) y la
 * constante `SEBA2_SYSTEM_PROMPT`. Este archivo extrae el bloque del documento y
 * exige igualdad EXACTA: si alguien cambia uno sin el otro, cae.
 */

function leerDocumento(): string {
  // Normaliza CRLF: en Windows un checkout puede traer saltos de línea \r\n.
  return readFileSync(path.join(process.cwd(), "docs/seba-v2/system-prompt-seba-v2.md"), "utf8").replace(/\r\n/g, "\n");
}

/** El primer bloque ```text que sigue al encabezado de la sección indicada. */
function bloqueTrasEncabezado(documento: string, encabezado: string): string {
  const desde = documento.indexOf(encabezado);
  expect(desde, `no encontré «${encabezado}» en el documento`).toBeGreaterThanOrEqual(0);
  const apertura = documento.indexOf("```text\n", desde);
  const inicio = apertura + "```text\n".length;
  const cierre = documento.indexOf("\n```", inicio);
  expect(cierre).toBeGreaterThan(inicio);
  return documento.slice(inicio, cierre);
}

const NOW = new Date("2026-11-17T15:00:00Z");

function estado(sobre: Partial<EstadoSeba> = {}): EstadoSeba {
  return { ...estadoInicial(NOW), ...sobre };
}

function contexto(sobre: Partial<Seba2Context> = {}): Seba2Context {
  return {
    now: NOW,
    businessHours: DEFAULT_BUSINESS_HOURS,
    apertura: false,
    customerName: null,
    estado: null,
    pedido: [],
    formasDeContado: ["Pago móvil", "Transferencia"],
    formaElegida: null,
    casheaMinimoUsd: 25,
    casheaSeisCuotasDesdeUsd: 100,
    esperaDeAsesor: null,
    pendingCustomerLines: [],
    previousConversationCutoffAt: null,
    ...sobre,
  };
}

/** Todo lo que viene después del prefijo cacheable. */
function sufijo(ctx: Seba2Context): string {
  const completo = buildSeba2Instructions(ctx);
  const prefijo = seba2Prefix(ctx.lessons);
  expect(completo.startsWith(`${prefijo}\n\n`)).toBe(true);
  return completo.slice(prefijo.length + 2);
}

function linea(texto: string, empiezaCon: string): string | undefined {
  return texto.split("\n").find((l) => l.startsWith(empiezaCon));
}

describe("SEBA2_SYSTEM_PROMPT", () => {
  it("es idéntico al bloque de la sección 1 del documento de diseño", () => {
    const bloque = bloqueTrasEncabezado(leerDocumento(), "## 1. Prompt estático");
    expect(SEBA2_SYSTEM_PROMPT).toBe(bloque);
  });

  it("arranca y termina donde dice el documento", () => {
    expect(SEBA2_SYSTEM_PROMPT.startsWith("SBK MOTORS · VENTAS POR WHATSAPP\n")).toBe(true);
    expect(SEBA2_SYSTEM_PROMPT.endsWith("Un producto por línea cuando son varios.")).toBe(true);
  });

  it("no contiene el nombre propio (D7), ni teléfonos ni correos (el repo es público)", () => {
    expect(SEBA2_SYSTEM_PROMPT).not.toMatch(/seba/i);
    expect(SEBA2_SYSTEM_PROMPT).not.toMatch(/\d{7,}/);
    expect(SEBA2_SYSTEM_PROMPT).not.toContain("@");
  });

  it("no lleva saltos de línea CRLF", () => {
    expect(SEBA2_SYSTEM_PROMPT).not.toContain("\r");
  });
});

describe("seba2Prefix", () => {
  it("sin lecciones es EXACTAMENTE el prompt estático", () => {
    expect(seba2Prefix()).toBe(SEBA2_SYSTEM_PROMPT);
    expect(seba2Prefix({ global: [], chat: [] })).toBe(SEBA2_SYSTEM_PROMPT);
  });

  it("las lecciones de chat no entran al prefijo", () => {
    expect(seba2Prefix({ global: [], chat: ["x"] })).toBe(SEBA2_SYSTEM_PROMPT);
  });

  it("las lecciones en blanco se descartan: sin ninguna real, el prefijo no cambia", () => {
    expect(seba2Prefix({ global: ["", "   ", "\n"], chat: [] })).toBe(SEBA2_SYSTEM_PROMPT);
  });

  it("con lecciones globales las agrega al final, con su cabecera, sin nombrar a Seba", () => {
    const prefijo = seba2Prefix({ global: ["Di «casco» y no «capacete»", "Nunca ofrezcas apartados"], chat: [] });
    expect(prefijo.startsWith(`${SEBA2_SYSTEM_PROMPT}\n\n`)).toBe(true);
    const bloque = prefijo.slice(SEBA2_SYSTEM_PROMPT.length + 2);
    expect(bloque).toBe(
      [
        "LECCIONES DEL EQUIPO — correcciones de los asesores. Tienen prioridad sobre tu criterio:",
        "- Di «casco» y no «capacete»",
        "- Nunca ofrezcas apartados",
      ].join("\n")
    );
    expect(bloque).not.toMatch(/seba/i);
  });

  it("topa las lecciones globales en 15", () => {
    const veinte = Array.from({ length: 20 }, (_, i) => `lección ${i + 1}`);
    const bloque = seba2Prefix({ global: veinte, chat: [] }).slice(SEBA2_SYSTEM_PROMPT.length + 2);
    const items = bloque.split("\n").filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(15);
    expect(items[14]).toBe("- lección 15");
  });

  it("recorta cada lección global a 200 caracteres", () => {
    const larga = "a".repeat(500);
    const bloque = seba2Prefix({ global: [larga], chat: [] }).slice(SEBA2_SYSTEM_PROMPT.length + 2);
    expect(bloque.split("\n")[1]).toBe(`- ${"a".repeat(200)}`);
  });
});

describe("buildSeba2Instructions: prefijo", () => {
  it("empieza con el prefijo cacheable, y es idéntico entre dos turnos distintos", () => {
    const a = contexto({ apertura: true, customerName: "Ana", pendingCustomerLines: ["hola"] });
    const b = contexto({
      now: new Date("2026-11-18T22:30:00Z"),
      estado: estado({ etapa: "cotizado" }),
      pedido: [{ cantidad: 1, nombre: "CASCO LS2" }],
    });
    const iA = buildSeba2Instructions(a);
    const iB = buildSeba2Instructions(b);
    expect(iA.startsWith(seba2Prefix(a.lessons))).toBe(true);
    expect(iB.startsWith(seba2Prefix(b.lessons))).toBe(true);
    expect(iA.slice(0, SEBA2_SYSTEM_PROMPT.length)).toBe(iB.slice(0, SEBA2_SYSTEM_PROMPT.length));
    expect(iA).not.toBe(iB);
  });

  it("con las mismas lecciones globales los dos prefijos son idénticos aunque cambien las de chat", () => {
    const globales = ["Regla A", "Regla B"];
    const a = contexto({ lessons: { global: globales, chat: ["solo este chat"] } });
    const b = contexto({ lessons: { global: globales, chat: [] } });
    expect(seba2Prefix(a.lessons)).toBe(seba2Prefix(b.lessons));
    expect(buildSeba2Instructions(a).startsWith(seba2Prefix(a.lessons))).toBe(true);
    expect(buildSeba2Instructions(b).startsWith(seba2Prefix(b.lessons))).toBe(true);
  });
});

describe("sufijo del turno", () => {
  it("abre con TURNO ACTUAL y la línea del reloj tal cual", () => {
    const s = sufijo(contexto());
    const lineas = s.split("\n");
    expect(lineas[0]).toBe("TURNO ACTUAL");
    expect(lineas[1]).toBe(turnClockLine(NOW, DEFAULT_BUSINESS_HOURS));
  });

  it("el orden de las líneas es el de la sección 2 del documento", () => {
    const s = sufijo(
      contexto({
        apertura: true,
        customerName: "Ana",
        estado: estado(),
        pedido: [{ cantidad: 1, nombre: "CASCO" }],
        lessons: { global: [], chat: ["una"] },
        pendingCustomerLines: ["hola"],
        previousConversationCutoffAt: "2026-11-10T15:00:00Z",
      })
    );
    const prefijos = [
      "TURNO ACTUAL",
      "Hora local:",
      "Apertura:",
      "Cliente:",
      "Etapa:",
      "Pedido:",
      "Pago:",
      "Formas de contado activas:",
      "Cashea:",
      "Espera de asesor:",
      "Lecciones del equipo para este chat:",
      "Mensajes nuevos del cliente que tienes que responder ahora:",
      "Lo anterior al ",
    ];
    const posiciones = prefijos.map((p) => s.indexOf(p));
    posiciones.forEach((p, i) => expect(p, `falta «${prefijos[i]}»`).toBeGreaterThanOrEqual(0));
    expect([...posiciones].sort((x, y) => x - y)).toEqual(posiciones);
  });

  it("Apertura sí / no", () => {
    expect(sufijo(contexto({ apertura: true }))).toContain("\nApertura: sí\n");
    expect(sufijo(contexto({ apertura: false }))).toContain("\nApertura: no\n");
  });

  it("Cliente con nombre o sin nombre", () => {
    expect(sufijo(contexto({ customerName: "Ana" }))).toContain("\nCliente: Ana\n");
    expect(sufijo(contexto({ customerName: null }))).toContain("\nCliente: sin nombre\n");
    expect(sufijo(contexto({ customerName: "   " }))).toContain("\nCliente: sin nombre\n");
  });

  it("Etapa: la del estado, o «entender» sin estado", () => {
    expect(sufijo(contexto({ estado: null }))).toContain("\nEtapa: entender\n");
    expect(sufijo(contexto({ estado: estado({ etapa: "eligiendo_pago" }) }))).toContain("\nEtapa: eligiendo_pago\n");
  });

  it("Pedido vacío y con renglones", () => {
    expect(sufijo(contexto())).toContain("\nPedido: vacío\n");
    const s = sufijo(
      contexto({
        pedido: [
          { cantidad: 2, nombre: "PASTILLAS FRENO BERA SBR" },
          { cantidad: 1, nombre: "CASCO LS2 NEGRO" },
        ],
      })
    );
    expect(s).toContain("\nPedido: 2 × PASTILLAS FRENO BERA SBR; 1 × CASCO LS2 NEGRO\n");
  });

  it("Pago y Entrega en todas sus variantes", () => {
    expect(linea(sufijo(contexto()), "Pago:")).toBe("Pago: sin definir · Entrega: sin definir");
    expect(
      linea(
        sufijo(contexto({ formaElegida: "Cashea", estado: estado({ entrega: "envio", ciudad: "Mérida" }) })),
        "Pago:"
      )
    ).toBe("Pago: Cashea · Entrega: envío a Mérida");
    expect(linea(sufijo(contexto({ formaElegida: "Pago móvil", estado: estado({ entrega: "envio", ciudad: null }) })), "Pago:")).toBe(
      "Pago: Pago móvil · Entrega: envío (falta la ciudad)"
    );
    expect(linea(sufijo(contexto({ estado: estado({ entrega: "retiro" }) })), "Pago:")).toBe(
      "Pago: sin definir · Entrega: retiro"
    );
    expect(linea(sufijo(contexto({ estado: estado({ entrega: "delivery" }) })), "Pago:")).toBe(
      "Pago: sin definir · Entrega: delivery"
    );
    expect(linea(sufijo(contexto({ estado: estado({ entrega: null }) })), "Pago:")).toBe(
      "Pago: sin definir · Entrega: sin definir"
    );
  });

  it("Formas de contado: lista o «ninguna cargada»", () => {
    expect(sufijo(contexto({ formasDeContado: ["Pago móvil", "Transferencia"] }))).toContain(
      "\nFormas de contado activas: Pago móvil, Transferencia\n"
    );
    expect(sufijo(contexto({ formasDeContado: [] }))).toContain(
      "\nFormas de contado activas: ninguna cargada (si el cliente quiere pagar de contado, pasa el caso a ventas)\n"
    );
  });

  it("Cashea: montos enteros sin decimales y con coma decimal si no", () => {
    expect(linea(sufijo(contexto({ casheaMinimoUsd: 25, casheaSeisCuotasDesdeUsd: 100 })), "Cashea:")).toBe(
      "Cashea: envío gratis · compra mínima 25 $ · seis cuotas desde 100 $ · la inicial la confirma el asesor"
    );
    expect(linea(sufijo(contexto({ casheaMinimoUsd: 25.5, casheaSeisCuotasDesdeUsd: 99.9 })), "Cashea:")).toBe(
      "Cashea: envío gratis · compra mínima 25,50 $ · seis cuotas desde 99,90 $ · la inicial la confirma el asesor"
    );
  });

  it("Espera de asesor: prohíbe volver a pasar el caso; sin espera dice «no»", () => {
    expect(linea(sufijo(contexto()), "Espera de asesor:")).toBe("Espera de asesor: no");
    expect(linea(sufijo(contexto({ esperaDeAsesor: { area: "reclamos", minutos: 12 } })), "Espera de asesor:")).toBe(
      "Espera de asesor: sí, área reclamos desde hace 12 min: solo puedes contestar información; no pases el caso de nuevo"
    );
  });

  describe("lecciones de este chat", () => {
    it("se omite la línea sin lecciones de chat", () => {
      expect(sufijo(contexto())).not.toContain("Lecciones del equipo para este chat");
      expect(sufijo(contexto({ lessons: { global: ["g"], chat: [] } }))).not.toContain("Lecciones del equipo para este chat");
      expect(sufijo(contexto({ lessons: { global: [], chat: ["  "] } }))).not.toContain("Lecciones del equipo para este chat");
    });

    it("separa con « | », topa en 5 y recorta cada una a 200", () => {
      const siete = Array.from({ length: 7 }, (_, i) => `chat ${i + 1}`);
      expect(linea(sufijo(contexto({ lessons: { global: [], chat: siete } })), "Lecciones del equipo")).toBe(
        "Lecciones del equipo para este chat: chat 1 | chat 2 | chat 3 | chat 4 | chat 5"
      );
      const larga = "b".repeat(500);
      expect(linea(sufijo(contexto({ lessons: { global: [], chat: [larga] } })), "Lecciones del equipo")).toBe(
        `Lecciones del equipo para este chat: ${"b".repeat(200)}`
      );
    });

    it("las lecciones globales NO se repiten en el sufijo", () => {
      expect(sufijo(contexto({ lessons: { global: ["regla global única"], chat: [] } }))).not.toContain("regla global única");
    });
  });

  describe("mensajes nuevos del cliente", () => {
    const PREFIJO = "Mensajes nuevos del cliente que tienes que responder ahora: ";

    it("se omite sin pendientes", () => {
      expect(sufijo(contexto({ pendingCustomerLines: [] }))).not.toContain("Mensajes nuevos del cliente");
    });

    it("entre comillas angulares y separados por coma", () => {
      expect(linea(sufijo(contexto({ pendingCustomerLines: ["hola", "busco un casco"] })), PREFIJO)).toBe(
        `${PREFIJO}«hola», «busco un casco»`
      );
    });

    it("con siete líneas quedan las cinco últimas", () => {
      const siete = Array.from({ length: 7 }, (_, i) => `m${i + 1}`);
      expect(linea(sufijo(contexto({ pendingCustomerLines: siete })), PREFIJO)).toBe(
        `${PREFIJO}«m3», «m4», «m5», «m6», «m7»`
      );
    });

    it("recorta cada línea a 300 caracteres y marca el recorte con «…»", () => {
      const l = linea(sufijo(contexto({ pendingCustomerLines: ["x".repeat(450), "corta"] })), PREFIJO)!;
      expect(l).toBe(`${PREFIJO}«${"x".repeat(300)}…», «corta»`);
      // Una línea de exactamente 300 no se recorta ni lleva «…».
      expect(linea(sufijo(contexto({ pendingCustomerLines: ["y".repeat(300)] })), PREFIJO)).toBe(
        `${PREFIJO}«${"y".repeat(300)}»`
      );
    });

    it("los saltos de línea internos pasan a espacios (una línea por dato)", () => {
      const s = sufijo(contexto({ pendingCustomerLines: ["primera\nsegunda\r\n\r\ntercera"] }));
      expect(linea(s, PREFIJO)).toBe(`${PREFIJO}«primera segunda tercera»`);
    });

    it("los topes exportados valen 5 y 300", () => {
      expect(MAX_PENDING_LINES).toBe(5);
      expect(MAX_PENDING_LINE_CHARS).toBe(300);
    });
  });

  describe("conversación anterior", () => {
    it("se omite sin corte", () => {
      expect(sufijo(contexto({ previousConversationCutoffAt: null }))).not.toContain("Lo anterior al");
    });

    it("trae la fecha en hora de Caracas", () => {
      const corte = "2026-11-10T15:00:00Z";
      expect(linea(sufijo(contexto({ previousConversationCutoffAt: corte })), "Lo anterior al")).toBe(
        `Lo anterior al ${formatCrmDateTime(new Date(corte))} es una conversación vieja ya atendida: úsalo solo como contexto.`
      );
    });

    it("una fecha ilegible no rompe el turno: la línea se omite", () => {
      expect(() => sufijo(contexto({ previousConversationCutoffAt: "no es fecha" }))).not.toThrow();
      expect(sufijo(contexto({ previousConversationCutoffAt: "no es fecha" }))).not.toContain("Lo anterior al");
    });
  });

  it("nunca lleva teléfonos, cuentas ni enlaces: solo etiquetas", () => {
    const s = sufijo(
      contexto({
        formasDeContado: ["Pago móvil", "Transferencia", "Binance"],
        formaElegida: "Pago móvil",
        pedido: [{ cantidad: 1, nombre: "CASCO LS2" }],
        estado: estado({ entrega: "envio", ciudad: "Mérida" }),
      })
    );
    expect(s).not.toMatch(/\d{7,}/);
    expect(s).not.toContain("http");
    expect(s).not.toContain("@");
  });
});
