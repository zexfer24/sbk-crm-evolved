import { describe, expect, it } from "vitest";
import { decideReadOnArrival, shouldFlushDeferred } from "@/lib/read-on-arrival";

describe("decideReadOnArrival", () => {
  const casos: Array<{
    nombre: string;
    visibilityState: DocumentVisibilityState;
    hasFocus: boolean;
    esperado: "mark" | "defer";
  }> = [
    {
      nombre: "pestaña al frente y ventana con foco: se vio de verdad",
      visibilityState: "visible",
      hasFocus: true,
      esperado: "mark",
    },
    {
      nombre: "pestaña al frente pero ventana sin foco: mirando otra app",
      visibilityState: "visible",
      hasFocus: false,
      esperado: "defer",
    },
    {
      nombre: "pestaña de fondo aunque la ventana tenga foco: el caso de las dos pestañas",
      visibilityState: "hidden",
      hasFocus: true,
      esperado: "defer",
    },
    {
      nombre: "pestaña de fondo y ventana sin foco: doblemente afuera",
      visibilityState: "hidden",
      hasFocus: false,
      esperado: "defer",
    },
  ];

  it.each(casos)("$nombre → $esperado", ({ visibilityState, hasFocus, esperado }) => {
    expect(decideReadOnArrival({ visibilityState, hasFocus })).toBe(esperado);
  });
});

describe("shouldFlushDeferred", () => {
  it("suelta lo pendiente cuando la pestaña vuelve a estar al frente", () => {
    expect(shouldFlushDeferred("visible")).toBe(true);
  });

  it("no suelta nada mientras la pestaña sigue oculta", () => {
    expect(shouldFlushDeferred("hidden")).toBe(false);
  });
});
