import { resumenDeComprobante } from "@/lib/ai/comprobante-nota";
import { esComprobante, esOrdenCashea, formatoMontoVE, type ImageFields } from "@/lib/media-reading-fields";
import type { EstadoSeba } from "./tipos";

// ---------------------------------------------------------------------------
// La nota interna que lee el asesor de pagos cuando Seba recibe un comprobante
// (S6, Seba v2, 17/11/2026).
//
// Módulo PURO. La arma el CÓDIGO, nunca el modelo, y envuelve a
// `resumenDeComprobante` (entrega 1) en vez de duplicarlo: lo que ESTE módulo
// agrega es el contexto que el resumen no tiene — qué pidió el cliente, cuánto
// debía pagar y las tres cosas que el asesor no puede dejar pasar (la captura
// no cuadra con el total, la orden de Cashea es de retiro pero se pidió envío,
// queda una sola unidad). Seba no verifica nada: el asesor coteja contra el
// estado de cuenta, y esta nota le ahorra abrir la imagen y reconstruir el pedido.
// ---------------------------------------------------------------------------

/** La nota completa cabe en la nota interna y en el `resumen` de la bitácora. */
const MAX_NOTA_CHARS = 900;
/** Un pedido largo se recorta hasta este mínimo antes de tocar la lectura de la captura. */
const MIN_PEDIDO_CHARS = 60;
/** Cierre fijo de `resumenDeComprobante`: nunca se pierde al recortar. */
const CIERRE_DEL_RESUMEN = "Verificar antes de confirmar: Seba no validó el pago.";

export interface RenglonDeNota {
  cantidad: number;
  nombre: string;
  saintCode: string | null;
  stock: number;
}

export interface EntradaDeNotaDeComprobante {
  estado: EstadoSeba | null;
  /** Los renglones del estado ya resueltos a nombre. */
  pedido: RenglonDeNota[];
  /** Etiqueta de la forma de pago elegida. */
  formaLabel: string | null;
  /** SOLO las lecturas de comprobante u orden de Cashea (igual se filtra por si acaso). */
  lecturas: readonly ImageFields[];
}

function recortar(texto: string, max: number): string {
  return texto.length <= max ? texto : `${texto.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function lineaDePedido(pedido: RenglonDeNota[]): string {
  if (pedido.length === 0) return "Pedido: sin pedido armado por Seba";
  const renglones = pedido.map((r) => `${r.cantidad} × ${r.nombre}${r.saintCode ? ` (SAINT ${r.saintCode})` : ""}`);
  return `Pedido: ${renglones.join("; ")}`;
}

function lineaDeTotal(estado: EstadoSeba | null): string | null {
  if (!estado) return null;
  const usd = estado.totalUsd !== null ? `$${formatoMontoVE(estado.totalUsd)} BCV` : null;
  const bs = estado.totalBs !== null ? `Bs. ${formatoMontoVE(estado.totalBs)}` : null;
  if (usd && bs) return `Total esperado: ${usd} (${bs})`;
  if (usd || bs) return `Total esperado: ${usd ?? bs}`;
  return null;
}

function lineaDeEntrega(estado: EstadoSeba | null): string | null {
  if (!estado?.entrega) return null;
  if (estado.entrega === "retiro") return "Entrega: retiro";
  if (estado.entrega === "delivery") return "Entrega: delivery";
  return estado.ciudad ? `Entrega: envío a ${estado.ciudad}` : "Entrega: envío";
}

/** Céntimos enteros: la comparación «al céntimo» no se rompe por el punto flotante. */
function centimos(valor: number): number {
  return Math.round(valor * 100);
}

/**
 * «DIFERENCIA: esperado …, leído …» por moneda. Si el cliente pagó en dos partes
 * (dos capturas), se SUMAN las de la misma moneda antes de comparar: cada captura
 * suelta cuadraría mal contra el total y avisaría de más. Sin total esperado en
 * esa moneda, sin moneda o sin monto leído no se compara nada: no se inventa.
 */
function lineasDeDiferencia(estado: EstadoSeba | null, lecturas: readonly ImageFields[]): string[] {
  if (!estado) return [];
  const leido = { VES: null as number | null, USD: null as number | null };
  for (const l of lecturas) {
    const c = esComprobante(l) ? l.comprobante : null;
    if (!c || c.monto === null || c.moneda === null) continue;
    leido[c.moneda] = (leido[c.moneda] ?? 0) + c.monto;
  }

  const lineas: string[] = [];
  if (leido.VES !== null && estado.totalBs !== null && Math.abs(centimos(leido.VES) - centimos(estado.totalBs)) > 1) {
    lineas.push(`DIFERENCIA: esperado Bs. ${formatoMontoVE(estado.totalBs)}, leído Bs. ${formatoMontoVE(leido.VES)}`);
  }
  if (leido.USD !== null && estado.totalUsd !== null && Math.abs(centimos(leido.USD) - centimos(estado.totalUsd)) > 1) {
    lineas.push(`DIFERENCIA: esperado $${formatoMontoVE(estado.totalUsd)}, leído $${formatoMontoVE(leido.USD)}`);
  }
  return lineas;
}

/** Nota interna para el asesor que verifica el pago. Máximo 900 caracteres. */
export function notaDeComprobante(i: EntradaDeNotaDeComprobante): string {
  const lecturas = i.lecturas.filter((l) => esComprobante(l) || esOrdenCashea(l));

  const total = lineaDeTotal(i.estado);
  const forma = i.formaLabel ? `Forma: ${i.formaLabel}` : null;
  const entrega = lineaDeEntrega(i.estado);

  const ordenDeRetiro = lecturas.some((l) => esOrdenCashea(l) && l.orden_cashea?.modalidad === "retiro");
  const alertas = [
    ...lineasDeDiferencia(i.estado, lecturas),
    ordenDeRetiro && i.estado?.entrega === "envio" ? "ORDEN CON RETIRO EN TIENDA y el cliente pidió envío" : null,
    i.pedido.some((r) => r.stock === 1) ? "ÚLTIMA UNIDAD: verificar existencia antes de confirmar" : null,
  ].filter((l): l is string => l !== null);

  let pedido = lineaDePedido(i.pedido);
  let captura = lecturas.length > 0 ? resumenDeComprobante(lecturas) : "Sin captura legible";
  const otras = [total, forma, entrega].filter((l): l is string => l !== null);

  const armar = () => [pedido, ...otras, captura, ...alertas].join("\n");

  // Recorte por prioridad: primero el pedido (lo más largo y lo más fácil de
  // reconstruir mirando el chat), después el cuerpo de la captura. Las
  // advertencias (diferencia, retiro, última unidad) y el cierre nunca se pierden.
  let nota = armar();
  if (nota.length > MAX_NOTA_CHARS) {
    const sinPedido = nota.length - pedido.length;
    pedido = recortar(pedido, Math.max(MIN_PEDIDO_CHARS, MAX_NOTA_CHARS - sinPedido));
    nota = armar();
  }
  if (nota.length > MAX_NOTA_CHARS && captura.endsWith(CIERRE_DEL_RESUMEN)) {
    const exceso = nota.length - MAX_NOTA_CHARS;
    const cuerpo = captura.slice(0, captura.length - CIERRE_DEL_RESUMEN.length).trimEnd();
    captura = `${recortar(cuerpo, cuerpo.length - exceso)} ${CIERRE_DEL_RESUMEN}`;
    nota = armar();
  }
  return nota.length > MAX_NOTA_CHARS ? recortar(nota, MAX_NOTA_CHARS) : nota;
}
