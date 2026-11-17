import { tool } from "ai";
import { z } from "zod";
import { errorText, log } from "@/lib/log";
import { esComprobante, esOrdenCashea, type ImageFields } from "@/lib/media-reading-fields";
import type { TurnEffects } from "./effects";
import { notaDeComprobante, type RenglonDeNota } from "./nota-asesor";
import type { SesionDeTurno } from "./sesion";
import {
  TEXTO_COMPROBANTE_RECIBIDO,
  TEXTO_SEGUIMOS_POR_AQUI,
  lineaCedulaCashea,
  lineaTiendaCerrada,
} from "./textos";

// ---------------------------------------------------------------------------
// `recibirComprobante`: lo que pasa cuando el cliente manda la captura de su
// pago o su orden de Cashea (S6, Seba v2, 17/11/2026).
//
// Seba NUNCA confirma un pago: lo verifica una persona de pagos. Por eso este
// módulo solo (1) arma la nota con lo que dice la captura y lo que se esperaba,
// (2) pasa el caso al área de pagos y recién DESPUÉS (3) le avisa al cliente que
// el comprobante se recibió. El monto leído de la captura va a la nota del
// asesor y jamás al cliente: si no cuadra con el total, lo decide el asesor.
//
// La disparan dos caminos: el modelo (herramienta) y el turno por código, sin
// modelo, cuando alguna lectura de la ráfaga es un comprobante o una orden de
// Cashea (`hayComprobanteEnLaRafaga`). Una foto de producto NO lo dispara
// (caso E5: el cliente manda la foto de lo que quiere después de recibir los
// datos de pago).
// ---------------------------------------------------------------------------

export type MedioDePago = "pago_movil" | "transferencia" | "cashea" | "binance" | "desconocido";

export const NOMBRE_RECIBIR_COMPROBANTE = "recibirComprobante";

export interface DepsDeComprobante {
  effects: TurnEffects;
  sesion: SesionDeTurno;
  /** Lo que el cliente escribió en la ráfaga que se está respondiendo. */
  rafaga: string[];
  /** Las lecturas de imagen de la ráfaga (todas). */
  lecturas: readonly ImageFields[];
  pedido: RenglonDeNota[];
  formaLabel: string | null;
}

const AVISO_YA_RECIBIDO = "El comprobante ya se recibió y el caso está con pagos. No escribas nada más.";
const AVISO_SIN_ASIGNAR = "No se pudo asignar el caso; ya se le avisó al cliente. No escribas nada más.";

/** Una cédula venezolana suelta, con o sin letra: la ráfaga ya la trae y no hay que volver a pedirla. */
const CEDULA = /\b[VEve]?-?\s?\d{6,8}\b/;
const TALLA = /\btalla\b|\b(xs|s|m|l|xl|xxl|2xl|3xl)\b/i;
/** Productos que se venden por talla: Cashea necesita saberla para armar la orden. */
const PRODUCTO_CON_TALLA = /casco|chaqueta|guante|bota|impermeable|pantal[oó]n|jersey|braga/i;

/** ¿Alguna lectura de la ráfaga es un comprobante de pago o una orden de Cashea? */
export function hayComprobanteEnLaRafaga(lecturas: readonly ImageFields[]): boolean {
  return lecturas.some((l) => esComprobante(l) || esOrdenCashea(l));
}

/** La usa la herramienta Y el turno, que la dispara por código si una lectura de la ráfaga es un comprobante. */
export async function recibirComprobante(deps: DepsDeComprobante, medio: MedioDePago): Promise<string> {
  const { effects, sesion } = deps;
  sesion.herramientas.push(NOMBRE_RECIBIR_COMPROBANTE);

  // Un segundo comprobante con el caso ya en manos de pagos no vuelve a avisar
  // ni a asignar: el cliente ya recibió su acuse y el asesor ya tiene la nota.
  if (sesion.estado.etapa === "comprobante_recibido" && (sesion.escaladaAbierta || sesion.paso !== null)) {
    sesion.terminado = true;
    return AVISO_YA_RECIBIDO;
  }

  const lecturas = deps.lecturas.filter((l) => esComprobante(l) || esOrdenCashea(l));
  const nota = notaDeComprobante({
    estado: sesion.estado,
    pedido: deps.pedido,
    formaLabel: deps.formaLabel,
    lecturas,
  });

  // Asignar ANTES de enviar: si fallara después del acuse, el cliente creería
  // que un asesor tiene su comprobante cuando nadie sabe que existe.
  let resultado;
  try {
    resultado = await effects.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota });
  } catch (error) {
    log.error("seba2_comprobante_no_asignado", { medio, detail: errorText(error) });
    await effects.enviarTexto(TEXTO_SEGUIMOS_POR_AQUI, "fijo");
    sesion.terminado = true;
    return AVISO_SIN_ASIGNAR;
  }

  await effects.enviarTexto(TEXTO_COMPROBANTE_RECIBIDO, "fijo");

  const textoDeLaRafaga = deps.rafaga.join("\n");
  const esCashea = medio === "cashea" || lecturas.some((l) => esOrdenCashea(l));
  if (esCashea && !CEDULA.test(textoDeLaRafaga)) {
    const pedirTalla = deps.pedido.some((r) => PRODUCTO_CON_TALLA.test(r.nombre)) && !TALLA.test(textoDeLaRafaga);
    await effects.enviarTexto(lineaCedulaCashea(pedirTalla), "fijo");
  }

  if (!resultado.abierta && resultado.cuandoAbre) {
    await effects.enviarTexto(lineaTiendaCerrada(resultado.cuandoAbre), "fijo");
  }

  sesion.paso = { area: "pagos", motivo: "comprobante_pago" };
  sesion.estado = { ...sesion.estado, etapa: "comprobante_recibido", actualizadoEn: sesion.ahora.toISOString() };
  sesion.terminado = true;
  return AVISO_YA_RECIBIDO;
}

export function buildRecibirComprobanteTool(deps: DepsDeComprobante) {
  return tool({
    description:
      "Úsala cuando el cliente manda la captura de su pago (pago móvil, transferencia, Binance) o su orden de Cashea. Le avisa que el comprobante se recibió y pasa el caso al área de pagos, que lo verifica. Tú nunca confirmas ni apruebas un pago. Después de llamarla no escribas nada más.",
    inputSchema: z.object({
      medio: z
        .enum(["pago_movil", "transferencia", "cashea", "binance", "desconocido"])
        .describe("Cómo pagó el cliente, según lo que se ve o lo que dijo. Si no está claro, «desconocido»."),
    }),
    execute: async ({ medio }) => recibirComprobante(deps, medio),
  });
}
