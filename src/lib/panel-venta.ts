import { CAMPOS_COPIA, type OpcionesCopia } from "@/lib/copia-carrito";
import type { EstadoSaint } from "@/lib/saint-borradores";

/**
 * Las reglas puras del panel de venta del chat (28/10/2026, plan "Facturar en
 * SAINT sale del fondo del panel", T3). Antes el botón de facturar estaba al
 * fondo del bloque del carrito, igual a otros tres botones grises, y «Cerrar
 * venta» arriba era siempre el único negro: el asesor cerraba la venta sin
 * pasar por SAINT. Ahora el camino visible es armar → facturar en SAINT →
 * cerrar, y estas funciones deciden qué paso va en qué estado y cuál botón
 * lleva el énfasis. Los componentes solo las pintan.
 */

export type EstadoPaso = "hecho" | "en_curso" | "error" | "pendiente";

export interface PasoVenta {
  clave: "armar" | "saint" | "cerrar";
  etiqueta: string;
  estado: EstadoPaso;
}

interface EntradaPasos {
  hayRenglones: boolean;
  /** Estado del ÚLTIMO envío a SAINT de esta conversación; `null` si nunca se envió. */
  estadoEnvio: EstadoSaint | null;
  ventaCerrada: boolean;
}

function estadoDelEnvio(estadoEnvio: EstadoSaint | null): EstadoPaso {
  switch (estadoEnvio) {
    case "pendiente":
    case "procesando":
      return "en_curso";
    case "creado":
      return "hecho";
    case "error":
      return "error";
    default:
      return "pendiente";
  }
}

/** Los tres pasos de la venta con su estado. «En espera en SAINT» solo es «hecho» cuando SAINT creó la factura. */
export function pasosDeVenta({ hayRenglones, estadoEnvio, ventaCerrada }: EntradaPasos): PasoVenta[] {
  return [
    { clave: "armar", etiqueta: "Armar", estado: hayRenglones ? "hecho" : "pendiente" },
    { clave: "saint", etiqueta: "En espera en SAINT", estado: estadoDelEnvio(estadoEnvio) },
    { clave: "cerrar", etiqueta: "Cerrar", estado: ventaCerrada ? "hecho" : "pendiente" },
  ];
}

/**
 * Cómo se pinta «Cerrar venta». Es `primary` solo cuando es la acción que toca:
 * sin carrito (no hay nada que facturar) o con la factura de SAINT ya creada.
 * Con carrito y sin factura creada el protagonista es «Facturar en SAINT»
 * (también `primary`), así que «Cerrar venta» baja a `secondary` y nunca hay
 * dos botones negros a la vez. Con la venta cerrada también es `secondary`.
 */
export function varianteCerrarVenta({
  ventaCerrada,
  hayRenglones,
  estadoEnvio,
}: {
  ventaCerrada: boolean;
  hayRenglones: boolean;
  estadoEnvio: EstadoSaint | null;
}): "primary" | "secondary" {
  if (ventaCerrada) return "secondary";
  if (hayRenglones && estadoEnvio !== "creado") return "secondary";
  return "primary";
}

/**
 * «N de 7» del pliegue «Qué copiar». El nombre del producto siempre va (por eso
 * cuenta siempre) y «Plan Cashea» no se ofrece en el chat. Se calcula de
 * `CAMPOS_COPIA`, no se escribe a mano: una casilla nueva cambia el total sola.
 */
export function contarCamposCopia(opciones: OpcionesCopia): { marcados: number; total: number } {
  const campos = CAMPOS_COPIA.filter((campo) => !campo.soloInventario);
  return {
    marcados: 1 + campos.filter((campo) => opciones[campo.clave]).length,
    total: 1 + campos.length,
  };
}
