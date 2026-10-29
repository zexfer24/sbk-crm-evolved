import { describe, expect, it } from "vitest";
import { OPCIONES_COPIA_INICIALES } from "@/lib/copia-carrito";
import { contarCamposCopia, pasosDeVenta, varianteCerrarVenta } from "@/lib/panel-venta";

/**
 * 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T3): las tres
 * reglas puras del panel del chat. Los componentes solo las pintan.
 */

const ESTADOS = (args: Parameters<typeof pasosDeVenta>[0]) => pasosDeVenta(args).map((p) => p.estado);

describe("pasosDeVenta", () => {
  it("son tres pasos, en orden, con su etiqueta", () => {
    const pasos = pasosDeVenta({ hayRenglones: true, estadoEnvio: null, ventaCerrada: false });

    expect(pasos.map((p) => p.etiqueta)).toEqual(["Armar", "En espera en SAINT", "Cerrar"]);
  });

  it("con renglones y sin envío: armar hecho, lo demás pendiente", () => {
    expect(ESTADOS({ hayRenglones: true, estadoEnvio: null, ventaCerrada: false })).toEqual([
      "hecho",
      "pendiente",
      "pendiente",
    ]);
  });

  it("sin renglones, armar sigue pendiente", () => {
    expect(ESTADOS({ hayRenglones: false, estadoEnvio: null, ventaCerrada: false })[0]).toBe("pendiente");
  });

  it.each(["pendiente", "procesando"] as const)("un envío %s deja el paso 2 en curso, nunca hecho", (estadoEnvio) => {
    expect(ESTADOS({ hayRenglones: true, estadoEnvio, ventaCerrada: false })).toEqual([
      "hecho",
      "en_curso",
      "pendiente",
    ]);
  });

  it("un envío creado deja el paso 2 hecho", () => {
    expect(ESTADOS({ hayRenglones: true, estadoEnvio: "creado", ventaCerrada: false })).toEqual([
      "hecho",
      "hecho",
      "pendiente",
    ]);
  });

  it("un envío con error deja el paso 2 con error", () => {
    expect(ESTADOS({ hayRenglones: true, estadoEnvio: "error", ventaCerrada: false })).toEqual([
      "hecho",
      "error",
      "pendiente",
    ]);
  });

  it("la venta cerrada deja el paso 3 hecho", () => {
    expect(ESTADOS({ hayRenglones: true, estadoEnvio: "creado", ventaCerrada: true })).toEqual([
      "hecho",
      "hecho",
      "hecho",
    ]);
  });
});

describe("varianteCerrarVenta", () => {
  it("sin carrito: primary (no hay nada que facturar antes)", () => {
    expect(varianteCerrarVenta({ ventaCerrada: false, hayRenglones: false, estadoEnvio: null })).toBe("primary");
  });

  it("con carrito y sin envío: secondary, el botón principal es facturar", () => {
    expect(varianteCerrarVenta({ ventaCerrada: false, hayRenglones: true, estadoEnvio: null })).toBe("secondary");
  });

  it.each(["pendiente", "procesando", "error"] as const)(
    "con carrito y un envío %s: secondary",
    (estadoEnvio) => {
      expect(varianteCerrarVenta({ ventaCerrada: false, hayRenglones: true, estadoEnvio })).toBe("secondary");
    },
  );

  it("con carrito y el envío creado: primary, ahora toca cerrar", () => {
    expect(varianteCerrarVenta({ ventaCerrada: false, hayRenglones: true, estadoEnvio: "creado" })).toBe("primary");
  });

  it("venta cerrada: secondary pase lo que pase", () => {
    expect(varianteCerrarVenta({ ventaCerrada: true, hayRenglones: true, estadoEnvio: "creado" })).toBe("secondary");
    expect(varianteCerrarVenta({ ventaCerrada: true, hayRenglones: false, estadoEnvio: null })).toBe("secondary");
  });
});

describe("contarCamposCopia", () => {
  it("con todo encendido cuenta el nombre más las seis casillas del chat: 7 de 7", () => {
    expect(contarCamposCopia(OPCIONES_COPIA_INICIALES)).toEqual({ marcados: 7, total: 7 });
  });

  it("el nombre siempre cuenta, aunque se apague todo", () => {
    const todoApagado = {
      codigo: false,
      cantidad: false,
      precioUnitario: false,
      subtotal: false,
      totalUsd: false,
      totalBs: false,
      planCashea: false,
    };
    expect(contarCamposCopia(todoApagado)).toEqual({ marcados: 1, total: 7 });
  });

  it("«Plan Cashea» no entra: el chat no lo ofrece", () => {
    expect(contarCamposCopia({ ...OPCIONES_COPIA_INICIALES, planCashea: false })).toEqual({ marcados: 7, total: 7 });
  });

  it("cada casilla apagada resta una", () => {
    expect(contarCamposCopia({ ...OPCIONES_COPIA_INICIALES, codigo: false, totalBs: false })).toEqual({
      marcados: 5,
      total: 7,
    });
  });
});
