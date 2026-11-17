import { describe, expect, it } from "vitest";
import {
  MOTIVOS_DE_VENTA_EN_CURSO,
  MOTIVOS_V2,
  areaDeMotivo,
  categoriaDeReclamo,
  esMotivoV2,
  type MotivoV2,
} from "./motivos";

// La tabla se fija con literales: recorrer el propio objeto no probaría nada.
const ESPERADO: [string, string][] = [
  ["comprobante_pago", "pagos"],
  ["problema_de_pago", "pagos"],
  ["listo_para_comprar", "ventas"],
  ["no_identificado", "ventas"],
  ["negociacion_precio", "ventas"],
  ["mayorista", "ventas"],
  ["apartado_o_aviso", "ventas"],
  ["consulta_tecnica", "ventas"],
  ["no_pudo_leer", "ventas"],
  ["pide_persona", "ventas"],
  ["otro", "ventas"],
  ["pedido_en_camino", "envios"],
  ["cancelar_orden_cashea", "envios"],
  ["problema_app_cashea", "envios"],
  ["reclamo_producto", "reclamos"],
  ["error_de_despacho", "reclamos"],
  ["cambio_o_devolucion", "reclamos"],
  ["garantia", "reclamos"],
];

describe("motivos de Seba v2", () => {
  it("son 18, en el orden del contrato", () => {
    expect(MOTIVOS_V2).toHaveLength(18);
    expect([...MOTIVOS_V2]).toEqual(ESPERADO.map(([motivo]) => motivo));
  });

  it.each(ESPERADO)("%s va al área %s", (motivo, area) => {
    expect(areaDeMotivo(motivo as MotivoV2)).toBe(area);
  });

  it("esMotivoV2 reconoce solo los 18", () => {
    expect(esMotivoV2("garantia")).toBe(true);
    expect(esMotivoV2("Garantia")).toBe(false);
    expect(esMotivoV2("intencion_compra")).toBe(false);
    expect(esMotivoV2("toString")).toBe(false);
    expect(esMotivoV2(null)).toBe(false);
    expect(esMotivoV2(3)).toBe(false);
  });

  it("los motivos que dejan la venta en curso son listo_para_comprar y comprobante_pago", () => {
    expect([...MOTIVOS_DE_VENTA_EN_CURSO]).toEqual(["listo_para_comprar", "comprobante_pago"]);
  });

  it("categoriaDeReclamo: los cinco que etiquetan", () => {
    expect(categoriaDeReclamo("reclamo_producto")).toBe("Producto");
    expect(categoriaDeReclamo("cambio_o_devolucion")).toBe("Producto");
    expect(categoriaDeReclamo("error_de_despacho")).toBe("Envío");
    expect(categoriaDeReclamo("garantia")).toBe("Garantía");
    expect(categoriaDeReclamo("problema_de_pago")).toBe("Pago");
  });

  it("categoriaDeReclamo: el resto no etiqueta", () => {
    expect(categoriaDeReclamo("comprobante_pago")).toBeNull();
    expect(categoriaDeReclamo("pedido_en_camino")).toBeNull();
    expect(categoriaDeReclamo("otro")).toBeNull();
    expect(categoriaDeReclamo("listo_para_comprar")).toBeNull();
  });
});
