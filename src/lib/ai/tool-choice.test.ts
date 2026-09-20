// ---------------------------------------------------------------------------
// Tarea K, "El resguardo antes del push" (20/9/2026). Ver tool-choice.ts
// para el caso real (`db8d3120…`, casco LS2 cotizado de memoria) y el
// porqué de forzar `buscarRepuesto` en el paso 0.
import { describe, expect, it } from "vitest";
import { CATALOG_TOOL_NAME, firstStepToolChoice } from "@/lib/ai/tool-choice";
import type { Intent } from "@/lib/ai/classify";

const FORZADO = { toolChoice: { type: "tool", toolName: CATALOG_TOOL_NAME } } as const;

describe("firstStepToolChoice", () => {
  it("consulta_disponibilidad + catálogo encendido + paso 0: fuerza buscarRepuesto", () => {
    expect(firstStepToolChoice("consulta_disponibilidad", true, 0)).toEqual(FORZADO);
  });

  it("consulta_disponibilidad + catálogo encendido + paso 1: no fuerza nada", () => {
    expect(firstStepToolChoice("consulta_disponibilidad", true, 1)).toBeUndefined();
  });

  it("consulta_disponibilidad + catálogo encendido + paso 2: tampoco (no solo el paso 1)", () => {
    expect(firstStepToolChoice("consulta_disponibilidad", true, 2)).toBeUndefined();
  });

  it("otra intención en el paso 0: no fuerza nada, aunque el catálogo esté encendido", () => {
    const otras: Intent[] = ["otro", "devolucion", "queja", "fuera_de_tema"];
    for (const intent of otras) {
      expect(firstStepToolChoice(intent, true, 0)).toBeUndefined();
    }
  });

  it("consulta_disponibilidad en el paso 0 sin la herramienta (catálogo apagado): no fuerza nada", () => {
    expect(firstStepToolChoice("consulta_disponibilidad", false, 0)).toBeUndefined();
  });

  it("ni intención ni herramienta correctas: no fuerza nada", () => {
    expect(firstStepToolChoice("otro", false, 0)).toBeUndefined();
  });
});
