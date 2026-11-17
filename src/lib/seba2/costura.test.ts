import { describe, expect, it } from "vitest";
import { SEBA_V2_MODES } from "@/lib/seba-v2-config";
import { decidirVersion, muestraDeConversacion, type EntradaDeVersion } from "./costura";

// Entrega 3 del rework de Seba (S9a, 17/11/2026): la decisión de versión es
// una función pura, así que la tabla de verdad se recorre ENTERA en vez de
// probar casos sueltos -- una combinación que nadie pensó es justo la que
// acaba mandando la versión equivocada al cliente.

const BASE: EntradaDeVersion = {
  modo: "apagado",
  canRun: true,
  shadowCanRun: true,
  tiendaAbierta: true,
  muestra: 5,
  samplePct: 20,
};

const VERDADEROS_FALSOS = [true, false] as const;

describe("decidirVersion — tabla de verdad completa", () => {
  it("apagado: v1 si la IA puede correr, ninguno si no; nunca sin enviar", () => {
    for (const canRun of VERDADEROS_FALSOS) {
      for (const shadowCanRun of VERDADEROS_FALSOS) {
        for (const tiendaAbierta of VERDADEROS_FALSOS) {
          const d = decidirVersion({ ...BASE, modo: "apagado", canRun, shadowCanRun, tiendaAbierta, muestra: 0, samplePct: 100 });
          expect(d).toEqual({ vivo: canRun ? "v1" : "ninguno", sinEnviar: null });
        }
      }
    }
  });

  it.each(["sombra", "copiloto"] as const)("%s: vivo como apagado; sinEnviar solo con shadowCanRun y muestra < samplePct", (modo) => {
    for (const canRun of VERDADEROS_FALSOS) {
      for (const shadowCanRun of VERDADEROS_FALSOS) {
        for (const tiendaAbierta of VERDADEROS_FALSOS) {
          // por debajo, igual y por encima del porcentaje
          for (const [muestra, samplePct, entra] of [
            [4, 5, true],
            [5, 5, false],
            [6, 5, false],
            [0, 0, false],
            [0, 100, true],
            [99, 100, true],
          ] as const) {
            const d = decidirVersion({ modo, canRun, shadowCanRun, tiendaAbierta, muestra, samplePct });
            expect(d.vivo).toBe(canRun ? "v1" : "ninguno");
            expect(d.sinEnviar).toBe(shadowCanRun && entra ? modo : null);
          }
        }
      }
    }
  });

  it("fuera_de_horario: v2 solo con canRun y la tienda cerrada; si no, como apagado; nunca sin enviar", () => {
    for (const canRun of VERDADEROS_FALSOS) {
      for (const shadowCanRun of VERDADEROS_FALSOS) {
        for (const tiendaAbierta of VERDADEROS_FALSOS) {
          const d = decidirVersion({ ...BASE, modo: "fuera_de_horario", canRun, shadowCanRun, tiendaAbierta, muestra: 0, samplePct: 100 });
          const vivo = canRun && !tiendaAbierta ? "v2" : canRun ? "v1" : "ninguno";
          expect(d).toEqual({ vivo, sinEnviar: null });
        }
      }
    }
  });

  it("siempre: v2 si la IA puede correr, ninguno si no; nunca sin enviar", () => {
    for (const canRun of VERDADEROS_FALSOS) {
      for (const shadowCanRun of VERDADEROS_FALSOS) {
        for (const tiendaAbierta of VERDADEROS_FALSOS) {
          const d = decidirVersion({ ...BASE, modo: "siempre", canRun, shadowCanRun, tiendaAbierta, muestra: 0, samplePct: 100 });
          expect(d).toEqual({ vivo: canRun ? "v2" : "ninguno", sinEnviar: null });
        }
      }
    }
  });

  it("un modo desconocido (cadena rara de la base) se trata como apagado", () => {
    for (const canRun of VERDADEROS_FALSOS) {
      const d = decidirVersion({ ...BASE, modo: "modo_inventado" as never, canRun, muestra: 0, samplePct: 100 });
      expect(d).toEqual({ vivo: canRun ? "v1" : "ninguno", sinEnviar: null });
    }
  });

  it("la tabla recorre los cinco modos que conoce la configuración", () => {
    // Si alguien suma un modo a SEBA_V2_MODES, este test obliga a decidir qué
    // hace la costura con él en vez de caer en silencio al caso «apagado».
    expect([...SEBA_V2_MODES].sort()).toEqual(["apagado", "copiloto", "fuera_de_horario", "siempre", "sombra"]);
  });
});

describe("muestraDeConversacion", () => {
  it("es estable: misma entrada, misma salida", () => {
    expect(muestraDeConversacion("conv-1", "2026-11-17")).toBe(muestraDeConversacion("conv-1", "2026-11-17"));
  });

  it("cambia con el día para la misma conversación (en algún día de una semana)", () => {
    const dias = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"];
    const muestras = new Set(dias.map((d) => muestraDeConversacion("conv-1", d)));
    expect(muestras.size).toBeGreaterThan(1);
  });

  it("queda en 0-99 y es un entero para 1.000 ids", () => {
    for (let i = 0; i < 1000; i++) {
      const m = muestraDeConversacion(`conv-${i}-${i * 7919}`, "2026-11-17");
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(99);
    }
  });

  it("reparte razonablemente: con 1.000 ids al 20 %, entre 150 y 250 caen por debajo de 20", () => {
    let debajo = 0;
    for (let i = 0; i < 1000; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      if (muestraDeConversacion(id, "2026-11-17") < 20) debajo++;
    }
    expect(debajo).toBeGreaterThanOrEqual(150);
    expect(debajo).toBeLessThanOrEqual(250);
  });
});
