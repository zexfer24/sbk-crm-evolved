import { describe, expect, it, vi } from "vitest";
import { hrefsDePaneles, HREFS_PANELES_LIMPIOS } from "@/lib/paneles/hrefs";

// Estos tests describen el canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

/**
 * 15/11/2026: las pestañas internas de los paneles se quitaron y su trabajo —que
 * cambiar de panel no pierda el período ni el canal elegidos— lo hacen ahora las
 * tres entradas del rail y de la barra superior. La regla es la de las pestañas:
 * el período viaja a los tres paneles (Asesores solo admite hoy/7d/30d y lo
 * normaliza); la vista (canal) solo a Dashboard y Analíticas. Fuera de los
 * paneles los enlaces quedan limpios.
 */

const q = (s: string) => new URLSearchParams(s);

describe("hrefsDePaneles", () => {
  it("fuera de los paneles los enlaces quedan limpios, aunque la URL traiga ?periodo", () => {
    for (const ruta of ["/ventas", "/inbox", "/recorrido", "/", "/panelx", "/inventario"]) {
      expect(hrefsDePaneles(ruta, q("periodo=7d&vista=online"))).toEqual(HREFS_PANELES_LIMPIOS);
    }
    expect(HREFS_PANELES_LIMPIOS).toEqual({
      dashboard: "/panel",
      analiticas: "/panel/analiticas",
      asesores: "/panel/asesores",
    });
  });

  it("dentro de un panel arrastran el período a los tres y la vista solo a Dashboard y Analíticas", () => {
    expect(hrefsDePaneles("/panel", q("periodo=7d&vista=online"))).toEqual({
      dashboard: "/panel?periodo=7d&vista=online",
      analiticas: "/panel/analiticas?periodo=7d&vista=online",
      asesores: "/panel/asesores?periodo=7d",
    });
  });

  it("sin vista en la URL (p. ej. estando en Asesores) no inventa una", () => {
    expect(hrefsDePaneles("/panel/asesores", q("periodo=30d"))).toEqual({
      dashboard: "/panel?periodo=30d",
      analiticas: "/panel/analiticas?periodo=30d",
      asesores: "/panel/asesores?periodo=30d",
    });
  });

  it("sin ?periodo en un panel lleva el predeterminado (hoy), como las pestañas", () => {
    expect(hrefsDePaneles("/panel/analiticas", q(""))).toEqual({
      dashboard: "/panel?periodo=hoy",
      analiticas: "/panel/analiticas?periodo=hoy",
      asesores: "/panel/asesores?periodo=hoy",
    });
  });

  it("Asesores normaliza un período que no admite (mes, año) a hoy; los otros lo conservan", () => {
    expect(hrefsDePaneles("/panel", q("periodo=mes&vista=tienda"))).toEqual({
      dashboard: "/panel?periodo=mes&vista=tienda",
      analiticas: "/panel/analiticas?periodo=mes&vista=tienda",
      asesores: "/panel/asesores?periodo=hoy",
    });
  });

  it("un período o vista inválidos se normalizan: nunca se copia basura de la URL", () => {
    expect(hrefsDePaneles("/panel", q("periodo=zzz&vista=otra"))).toEqual({
      dashboard: "/panel?periodo=hoy",
      analiticas: "/panel/analiticas?periodo=hoy",
      asesores: "/panel/asesores?periodo=hoy",
    });
  });

  it("acepta una ruta de panel con barra final o subruta, y searchParams nulos", () => {
    expect(hrefsDePaneles("/panel/", null).dashboard).toBe("/panel?periodo=hoy");
    expect(hrefsDePaneles("/panel/asesores/x", q("periodo=7d")).dashboard).toBe("/panel?periodo=7d");
    expect(hrefsDePaneles(null, null)).toEqual(HREFS_PANELES_LIMPIOS);
  });
});
