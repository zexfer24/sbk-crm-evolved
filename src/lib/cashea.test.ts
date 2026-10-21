import { describe, expect, it } from "vitest";
import {
  CASHEA,
  NIVELES_CASHEA,
  calcularCashea,
  comparativaNiveles,
  cronogramaCashea,
  cuotasDisponibles,
  formatFechaCuota,
  formatUsd,
  mensajeWhatsApp,
  parseMontoBsInput,
  parseMontoInput,
  porcentajeInicial,
  toCents,
  type ConfigCashea,
  type NivelCashea,
} from "@/lib/cashea";
import {
  AVISO_SEIS_CUOTAS,
  ELECCION_CASHEA_INICIAL,
  bsDeCents,
  formatBs,
  lineaInicial,
  lineaResto,
} from "@/lib/cashea";

describe("toCents", () => {
  it("redondea a centavos y neutraliza lo inválido", () => {
    expect(toCents(118.5)).toBe(11850);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(NaN)).toBe(0);
    expect(toCents(-5)).toBe(0);
    expect(toCents(Infinity)).toBe(0);
  });
});

describe("cuotasDisponibles", () => {
  it("6 cuotas solo con un monto ESTRICTAMENTE mayor a $100", () => {
    expect(cuotasDisponibles(9999)).toEqual([3]);
    expect(cuotasDisponibles(10000)).toEqual([3]);
    expect(cuotasDisponibles(10001)).toEqual([3, 6]);
  });
});

describe("porcentajeInicial", () => {
  it("lee la tabla estándar y la de bajada", () => {
    expect(porcentajeInicial(4, false)).toBe(25);
    expect(porcentajeInicial(4, true)).toBe(20);
    expect(porcentajeInicial(6, true)).toBe(0);
  });
});

describe("calcularCashea", () => {
  it("ajusta a 3 cuotas cuando 6 no está disponible", () => {
    const plan = calcularCashea({ montoCents: 8500, nivel: 4, cuotas: 6, bajada: false });
    expect(plan.cuotas).toBe(3);
    expect(plan.ajustado).toBe(true);
    expect(plan.cuotasDisponibles).toEqual([3]);
  });

  it("respeta 6 cuotas cuando el monto las habilita", () => {
    const plan = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: false });
    expect(plan.cuotas).toBe(6);
    expect(plan.ajustado).toBe(false);
  });

  it("$118 N4 bajada 6 cuotas: la última absorbe el centavo sobrante", () => {
    const plan = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    expect(plan.pct).toBe(20);
    expect(plan.inicialCents).toBe(2360);
    expect(plan.financiadoCents).toBe(9440);
    expect(plan.cuotaCents).toBe(1573);
    expect(plan.montosCuotasCents).toEqual([1573, 1573, 1573, 1573, 1573, 1575]);
  });

  it("$1350 N1 estándar 3 cuotas: cuotas iguales", () => {
    const plan = calcularCashea({ montoCents: 135000, nivel: 1, cuotas: 3, bajada: false });
    expect(plan.inicialCents).toBe(81000);
    expect(plan.montosCuotasCents).toEqual([18000, 18000, 18000]);
  });

  it("$85 N6 bajada: inicial 0", () => {
    const plan = calcularCashea({ montoCents: 8500, nivel: 6, cuotas: 3, bajada: true });
    expect(plan.inicialCents).toBe(0);
    expect(plan.financiadoCents).toBe(8500);
  });

  // Caso real del 13/9/2026: lo que Seba le dijo a un cliente. Fija el
  // redondeo: inicial al centavo más cercano y la diferencia a la última cuota.
  it("$122 N3 estándar 6 cuotas (caso real del 13/9/2026)", () => {
    const plan = calcularCashea({ montoCents: 12200, nivel: 3, cuotas: 6, bajada: false });
    expect(plan.inicialCents).toBe(3660);
    expect(plan.montosCuotasCents).toEqual([1423, 1423, 1423, 1423, 1423, 1425]);
  });

  it("monto 0 o inválido: todo en cero", () => {
    const plan = calcularCashea({ montoCents: 0, nivel: 3, cuotas: 3, bajada: false });
    expect(plan.inicialCents).toBe(0);
    expect(plan.financiadoCents).toBe(0);
    expect(plan.montosCuotasCents).toEqual([0, 0, 0]);
    expect(calcularCashea({ montoCents: -50, nivel: 3, cuotas: 3, bajada: false }).montoCents).toBe(0);
    expect(calcularCashea({ montoCents: NaN, nivel: 3, cuotas: 3, bajada: false }).montoCents).toBe(0);
  });

  it("inicial + cuotas suma exactamente el monto, sin cuotas negativas", () => {
    for (const monto of [99.99, 100, 100.01, 118, 1350, 0.01, 33.33]) {
      const montoCents = toCents(monto);
      for (const nivel of NIVELES_CASHEA) {
        for (const bajada of [true, false]) {
          for (const cuotas of cuotasDisponibles(montoCents)) {
            const plan = calcularCashea({ montoCents, nivel, cuotas, bajada });
            const suma = plan.montosCuotasCents.reduce((a, b) => a + b, 0);
            expect(plan.inicialCents + suma).toBe(montoCents);
            expect(plan.montosCuotasCents).toHaveLength(cuotas);
            expect(plan.montosCuotasCents.every((c) => c >= 0)).toBe(true);
          }
        }
      }
    }
  });
});

describe("configuración inyectable", () => {
  const clon: ConfigCashea = {
    ...CASHEA,
    UMBRAL_6_CUOTAS_CENTS: 5000,
    INICIAL_ESTANDAR: { ...CASHEA.INICIAL_ESTANDAR, 6: 50 },
  };

  it("cambiar las reglas es cambiar el objeto, no el código", () => {
    expect(cuotasDisponibles(8500, clon)).toEqual([3, 6]);
    const plan = calcularCashea({ montoCents: 8500, nivel: 6, cuotas: 6, bajada: false }, clon);
    expect(plan.pct).toBe(50);
    expect(plan.cuotas).toBe(6);
    expect(plan.ajustado).toBe(false);
    const fila = comparativaNiveles(8500, 6, false, clon).find((f) => f.nivel === 6);
    expect(fila?.pct).toBe(50);
  });
});

describe("cronogramaCashea", () => {
  it("inicial hoy y una cuota cada 14 días", () => {
    const hoy = new Date("2026-10-12T15:00:00Z");
    const plan = calcularCashea({ montoCents: 135000, nivel: 1, cuotas: 3, bajada: false });
    const cronograma = cronogramaCashea(plan, hoy);
    expect(cronograma).toHaveLength(4);
    expect(cronograma.map((c) => c.numero)).toEqual([0, 1, 2, 3]);
    expect(cronograma.map((c) => formatFechaCuota(c.fecha))).toEqual(["12 oct", "26 oct", "9 nov", "23 nov"]);
    expect(cronograma.map((c) => c.montoCents)).toEqual([plan.inicialCents, ...plan.montosCuotasCents]);
  });
});

describe("comparativaNiveles", () => {
  it("devuelve 6 filas N6 a N1 y la de N4 coincide con calcularCashea", () => {
    const filas = comparativaNiveles(11800, 6, true);
    expect(filas.map((f) => f.nivel)).toEqual([6, 5, 4, 3, 2, 1]);
    const n4 = filas.find((f) => f.nivel === 4)!;
    const plan = calcularCashea({ montoCents: 11800, nivel: 4 as NivelCashea, cuotas: 6, bajada: true });
    expect(n4).toEqual({
      nivel: 4,
      pct: plan.pct,
      inicialCents: plan.inicialCents,
      cuotaCents: plan.cuotaCents,
      financiadoCents: plan.financiadoCents,
    });
  });

  it("usa las mismas cuotas efectivas: sin 6 disponibles, 3", () => {
    const filas = comparativaNiveles(8500, 6, false);
    const plan = calcularCashea({ montoCents: 8500, nivel: 6, cuotas: 6, bajada: false });
    expect(filas[0].cuotaCents).toBe(plan.cuotaCents);
  });
});

describe("formatos", () => {
  it("formatUsd usa coma decimal y punto de miles", () => {
    expect(formatUsd(135000)).toBe("$1.350,00");
    expect(formatUsd(1573)).toBe("$15,73");
    expect(formatUsd(0)).toBe("$0,00");
  });
});

describe("mensajeWhatsApp", () => {
  it("cuotas iguales", () => {
    const plan = calcularCashea({ montoCents: 135000, nivel: 1, cuotas: 3, bajada: false });
    expect(mensajeWhatsApp(plan, "Casco LS2")).toBe(
      [
        "¡Hola! Te comparto el plan con Cashea para Casco LS2:",
        "Monto total: $1.350,00",
        "Nivel Cashea: 1",
        "Inicial (60%): $810,00",
        "Resto: 3 cuotas de $180,00, cada 14 días, sin intereses.",
        "¿Te lo apartamos?",
      ].join("\n"),
    );
  });

  it("última cuota distinta de la base", () => {
    const plan = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    expect(mensajeWhatsApp(plan, "Kit de arrastre")).toBe(
      [
        "¡Hola! Te comparto el plan con Cashea para Kit de arrastre:",
        "Monto total: $118,00",
        "Nivel Cashea: 4",
        "Inicial (20%): $23,60",
        "Resto: 6 cuotas: 5 de $15,73 y la última de $15,75, cada 14 días, sin intereses.",
        "¿Te lo apartamos?",
      ].join("\n"),
    );
  });

  it("inicial 0 % no se omite", () => {
    const plan = calcularCashea({ montoCents: 8500, nivel: 6, cuotas: 3, bajada: true });
    expect(mensajeWhatsApp(plan, "Guantes")).toContain("Inicial (0%): $0,00");
  });

  it("sin producto (ausente o vacío) la primera línea no dice «para»", () => {
    const plan = calcularCashea({ montoCents: 8600, nivel: 6, cuotas: 3, bajada: false });
    for (const mensaje of [mensajeWhatsApp(plan), mensajeWhatsApp(plan, ""), mensajeWhatsApp(plan, "  ")]) {
      expect(mensaje.split("\n")[0]).toBe("¡Hola! Te comparto el plan con Cashea:");
      expect(mensaje).not.toContain("para");
    }
  });
});

describe("parseMontoInput", () => {
  it("acepta coma o punto y vacío", () => {
    expect(parseMontoInput("118")).toEqual({ ok: true, value: 118 });
    expect(parseMontoInput("118,5")).toEqual({ ok: true, value: 118.5 });
    expect(parseMontoInput("118.50")).toEqual({ ok: true, value: 118.5 });
    expect(parseMontoInput(" 7 ")).toEqual({ ok: true, value: 7 });
    expect(parseMontoInput("")).toEqual({ ok: true, value: null });
  });

  it("rechaza lo que no es un monto en dólares", () => {
    for (const raw of ["-1", "1.234", "abc", "1,2,3"]) {
      expect(parseMontoInput(raw).ok).toBe(false);
    }
  });

  it("rechaza montos desmedidos", () => {
    expect(parseMontoInput("1000001")).toEqual({ ok: false, error: "Ese monto es demasiado grande." });
  });
});

describe("parseMontoBsInput", () => {
  it("la coma es el decimal y los puntos son de miles", () => {
    expect(parseMontoBsInput("18.524,40")).toEqual({ ok: true, value: 18524.4 });
    expect(parseMontoBsInput("18524,40")).toEqual({ ok: true, value: 18524.4 });
    expect(parseMontoBsInput("1.000.000,5")).toEqual({ ok: true, value: 1000000.5 });
    expect(parseMontoBsInput("18,5")).toEqual({ ok: true, value: 18.5 });
  });

  it("sin coma, un punto con grupos de tres dígitos es de miles", () => {
    expect(parseMontoBsInput("18.524")).toEqual({ ok: true, value: 18524 });
    expect(parseMontoBsInput("1.500")).toEqual({ ok: true, value: 1500 });
    expect(parseMontoBsInput("1.000.000")).toEqual({ ok: true, value: 1000000 });
  });

  it("sin coma, un punto con uno o dos decimales es el decimal", () => {
    expect(parseMontoBsInput("18524.4")).toEqual({ ok: true, value: 18524.4 });
    expect(parseMontoBsInput("2.50")).toEqual({ ok: true, value: 2.5 });
    expect(parseMontoBsInput("18524")).toEqual({ ok: true, value: 18524 });
    expect(parseMontoBsInput(" 7 ")).toEqual({ ok: true, value: 7 });
  });

  it("vacío es válido y significa «todavía no hay monto»", () => {
    expect(parseMontoBsInput("")).toEqual({ ok: true, value: null });
    expect(parseMontoBsInput("   ")).toEqual({ ok: true, value: null });
  });

  it("rechaza lo que no es un monto en bolívares", () => {
    const error = "Escribe un monto en bolívares, por ejemplo 18.524,40.";
    for (const raw of ["18.52,40", "12.3456", "-5", "abc", "1,234,5", "18.524,456", "1.5.0"]) {
      expect(parseMontoBsInput(raw)).toEqual({ ok: false, error });
    }
  });

  it("rechaza montos desmedidos pero acepta el tope", () => {
    expect(parseMontoBsInput("1.000.000.000")).toEqual({ ok: true, value: 1_000_000_000 });
    expect(parseMontoBsInput("1.000.000.001")).toEqual({ ok: false, error: "Ese monto es demasiado grande." });
    expect(parseMontoBsInput("2.000.000.000,50")).toEqual({ ok: false, error: "Ese monto es demasiado grande." });
  });
});

describe("bsDeCents", () => {
  it("convierte centavos de dólar a bolívares con la tasa del día", () => {
    expect(bsDeCents(5450, 100)).toBe(5450);
    expect(bsDeCents(333, 36.1234)).toBe(120.29);
  });

  it("sin tasa válida devuelve null, nunca un cero que parezca verdad", () => {
    expect(bsDeCents(5450, 0)).toBeNull();
    expect(bsDeCents(5450, -3)).toBeNull();
    expect(bsDeCents(5450, NaN)).toBeNull();
    expect(bsDeCents(5450, Infinity)).toBeNull();
  });
});

describe("formatBs", () => {
  it("usa el mismo formato es-VE que formatUsd, con punto de miles siempre", () => {
    expect(formatBs(21800)).toBe("Bs. 21.800,00");
    expect(formatBs(1350.5)).toBe("Bs. 1.350,50");
    expect(formatBs(0)).toBe("Bs. 0,00");
  });
});

describe("lineaInicial y lineaResto", () => {
  it("lineaInicial nombra el porcentaje y el monto", () => {
    const plan = calcularCashea({ montoCents: 21800, nivel: 4, cuotas: 6, bajada: false });
    expect(lineaInicial(plan)).toBe("Inicial (25%): $54,50");
  });

  it("lineaResto: cuotas iguales", () => {
    const plan = calcularCashea({ montoCents: 12000, nivel: 6, cuotas: 3, bajada: false });
    expect(lineaResto(plan)).toBe("Resto: 3 cuotas de $32,00, cada 14 días, sin intereses.");
  });

  it("lineaResto: la última absorbe el centavo sobrante", () => {
    const plan = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    expect(lineaResto(plan)).toBe(
      `Resto: 6 cuotas: 5 de ${formatUsd(plan.cuotaCents)} y la última de ${formatUsd(plan.montosCuotasCents[5])}, cada 14 días, sin intereses.`,
    );
    expect(plan.montosCuotasCents[5]).not.toBe(plan.cuotaCents);
  });

  it("mensajeWhatsApp contiene exactamente esas dos líneas", () => {
    const plan = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    const lineas = mensajeWhatsApp(plan, "Casco").split("\n");
    expect(lineas).toContain(lineaInicial(plan));
    expect(lineas).toContain(lineaResto(plan));
  });
});

describe("AVISO_SEIS_CUOTAS y ELECCION_CASHEA_INICIAL", () => {
  it("el aviso toma el umbral de CASHEA", () => {
    // Es el texto que la calculadora Cashea ya mostraba (12/10/2026): un solo aviso para los dos usos.
    expect(AVISO_SEIS_CUOTAS).toBe("Con montos de $100 o menos solo está disponible el plan de 3 cuotas");
    expect(AVISO_SEIS_CUOTAS).toContain(`$${CASHEA.UMBRAL_6_CUOTAS_CENTS / 100}`);
  });

  it("la elección inicial es nivel 6, 3 cuotas, sin bajada", () => {
    expect(ELECCION_CASHEA_INICIAL).toEqual({ nivel: 6, cuotas: 3, bajada: false });
  });
});
