import type { Area } from "@/lib/seba-v2-config";

/**
 * Motivo de pase a un asesor → área que lo atiende (Seba v2, 17/11/2026).
 *
 * El motivo lo elige el modelo desde un enum cerrado; el ÁREA la decide esta
 * tabla, nunca el modelo: así un asesor de Envíos no recibe un reclamo porque el
 * modelo se equivocó de área. `satisfies Record<string, Area>` obliga a que cada
 * valor sea un área real; las claves son el enum.
 */
export const AREA_DE_MOTIVO = {
  comprobante_pago: "pagos",
  problema_de_pago: "pagos",
  listo_para_comprar: "ventas",
  no_identificado: "ventas",
  negociacion_precio: "ventas",
  mayorista: "ventas",
  apartado_o_aviso: "ventas",
  consulta_tecnica: "ventas",
  no_pudo_leer: "ventas",
  pide_persona: "ventas",
  otro: "ventas",
  pedido_en_camino: "envios",
  cancelar_orden_cashea: "envios",
  problema_app_cashea: "envios",
  reclamo_producto: "reclamos",
  error_de_despacho: "reclamos",
  cambio_o_devolucion: "reclamos",
  garantia: "reclamos",
} as const satisfies Record<string, Area>;

export type MotivoV2 = keyof typeof AREA_DE_MOTIVO;

/** Las claves de la tabla, en el orden en que están escritas. */
export const MOTIVOS_V2 = Object.keys(AREA_DE_MOTIVO) as readonly MotivoV2[];

export function esMotivoV2(valor: unknown): valor is MotivoV2 {
  // `Object.hasOwn`: «toString» y compañía existen en el prototipo y no son motivos.
  return typeof valor === "string" && Object.hasOwn(AREA_DE_MOTIVO, valor);
}

export function areaDeMotivo(motivo: MotivoV2): Area {
  return AREA_DE_MOTIVO[motivo];
}

/** Motivos que dejan la venta «en progreso» (`deal_status = in_progress`). */
export const MOTIVOS_DE_VENTA_EN_CURSO: readonly MotivoV2[] = ["listo_para_comprar", "comprobante_pago"];

const CATEGORIA_DE_RECLAMO: Partial<Record<MotivoV2, "Producto" | "Envío" | "Garantía" | "Pago">> = {
  reclamo_producto: "Producto",
  cambio_o_devolucion: "Producto",
  error_de_despacho: "Envío",
  garantia: "Garantía",
  problema_de_pago: "Pago",
};

/** Categoría de la etiqueta «Reclamo · <cat>» por motivo, o `null` si el motivo no etiqueta. */
export function categoriaDeReclamo(motivo: MotivoV2): "Producto" | "Envío" | "Garantía" | "Pago" | null {
  return CATEGORIA_DE_RECLAMO[motivo] ?? null;
}
