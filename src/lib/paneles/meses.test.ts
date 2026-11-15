import { describe, expect, it } from "vitest";
import { mesesDesdeElPrimerEnvio } from "./meses";

/**
 * Plan "Paneles" (15/11/2026): la regla «un mes sin registro no es un cero» la
 * comparten Analíticas y el Dashboard. Los envíos a SAINT existen desde el
 * 26/10/2026; enero a septiembre pintados como $0,00 parecían «no vendimos».
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
