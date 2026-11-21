import { describe, expect, it } from "vitest";
import { INICIO_PANELES } from "./periodos";
import { mesesDelTablero, mesesDesdeElPrimerEnvio, rotuloDelMes } from "./meses";

/**
 * Plan "Paneles" (15/11/2026): la regla «un mes sin registro no es un cero» la
 * comparten Analíticas y el Dashboard. Los envíos a SAINT existen desde
 * finales de octubre de 2026; enero a septiembre pintados como $0,00 parecían «no vendimos».
 */
const mes = (clave: string, online = 0, tienda = 0, envios = 0) => ({ clave, online, tienda, envios });

describe("mesesDesdeElPrimerEnvio", () => {
  it("descarta los meses anteriores al primero con algún envío", () => {
    const meses = [mes("2026-08"), mes("2026-09"), mes("2026-10", 10, 0, 1), mes("2026-11")];
    expect(mesesDesdeElPrimerEnvio(meses).map((m) => m.clave)).toEqual(["2026-10", "2026-11"]);
  });

  it("un mes vacío entre dos con envíos se conserva: ahí sí hay registro y fue cero", () => {
    const meses = [mes("2026-08", 10, 0, 1), mes("2026-09"), mes("2026-10", 5, 0, 1)];
    expect(mesesDesdeElPrimerEnvio(meses)).toHaveLength(3);
  });

  it("acepta los meses futuros del año sin tratarlos como envíos", () => {
    const meses = [mes("2026-09"), mes("2026-10", 0, 3, 1), mes("2026-11"), mes("2026-12")];
    expect(mesesDesdeElPrimerEnvio(meses).map((m) => m.clave)).toEqual(["2026-10", "2026-11", "2026-12"]);
  });

  it("sin ningún envío devuelve una lista vacía", () => {
    expect(mesesDesdeElPrimerEnvio([mes("2026-10"), mes("2026-11")])).toEqual([]);
  });
});

describe("mesesDelTablero (21/11/2026: los paneles cuentan desde el 16/11)", () => {
  // Enero a diciembre de 2026, en orden: el índice es el mes (0 = enero).
  const anio2026 = Array.from({ length: 12 }, (_, i) => mes(`2026-${String(i + 1).padStart(2, "0")}`));
  const conEnvios = (i: number) => {
    const copia = anio2026.map((m) => ({ ...m }));
    copia[i] = { ...copia[i], online: 10, envios: 1 };
    return copia;
  };

  it("con piso arranca en el mes del piso, sin mirar si hubo envíos antes", () => {
    const meses = conEnvios(9); // un envío en octubre: el piso lo deja fuera
    expect(mesesDelTablero(meses, 2026, INICIO_PANELES).map((m) => m.clave)).toEqual(["2026-11", "2026-12"]);
  });

  it("conserva los meses posteriores al del piso aunque estén vacíos", () => {
    expect(mesesDelTablero(anio2026, 2026, INICIO_PANELES)).toHaveLength(2);
  });

  it("acepta un arreglo que solo llega al mes en curso (Analíticas)", () => {
    expect(mesesDelTablero(anio2026.slice(0, 11), 2026, INICIO_PANELES).map((m) => m.clave)).toEqual(["2026-11"]);
  });

  it("sin piso se comporta como mesesDesdeElPrimerEnvio", () => {
    const meses = conEnvios(9);
    expect(mesesDelTablero(meses, 2026, null)).toEqual(mesesDesdeElPrimerEnvio(meses));
  });

  it("con un piso de un año anterior se comporta como mesesDesdeElPrimerEnvio", () => {
    const meses = conEnvios(2);
    expect(mesesDelTablero(meses, 2027, INICIO_PANELES)).toEqual(mesesDesdeElPrimerEnvio(meses));
  });
});

describe("rotuloDelMes", () => {
  it("el mes del piso lleva «(desde el 16)»", () => {
    expect(rotuloDelMes("Nov", 2026, 11, INICIO_PANELES)).toBe("Nov (desde el 16)");
  });

  it("otros meses, otro año o sin piso, el rótulo tal cual", () => {
    expect(rotuloDelMes("Dic", 2026, 12, INICIO_PANELES)).toBe("Dic");
    expect(rotuloDelMes("Nov", 2027, 11, INICIO_PANELES)).toBe("Nov");
    expect(rotuloDelMes("Nov", 2026, 11, null)).toBe("Nov");
  });

  it("un piso en día 1 no necesita aclaración", () => {
    expect(rotuloDelMes("Nov", 2026, 11, new Date("2026-11-01T04:00:00Z"))).toBe("Nov");
  });
});
