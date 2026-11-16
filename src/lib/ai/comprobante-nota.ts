import { esComprobante, esOrdenCashea, type ImageFields } from "@/lib/media-reading-fields";

// ---------------------------------------------------------------------------
// El resumen que lee el asesor cuando Seba pasa un comprobante de pago o una
// orden de Cashea (plan "Seba lee fotos y audios", M4, 16/11/2026).
//
// Módulo PURO. Lo arma el CÓDIGO con los campos que leyó el webhook, nunca el
// modelo, y llega al asesor por el `resumen` de `escalateConversation` (la nota
// interna del chat y `agent_turns.summary`). Son dos cosas que el asesor
// necesita y el cliente nunca ve:
//
//   - lo que dice la captura (monto, últimos 6 dígitos de la referencia, banco,
//     fecha), para cotejarla contra el estado de cuenta sin abrir la imagen; y
//   - la advertencia de que NADA de eso está verificado — decisión D3 del
//     operador: Seba no confirma ni valida un pago, lo hace una persona.
//
// "RETIRO EN TIENDA": en una orden de Cashea la modalidad cambia el precio y el
// despacho; un cliente que mandó una orden de retiro pero pidió envío (o al
// revés) es el error más caro de corregir después. Se le avisa al asesor en
// mayúsculas para que lo confirme con el cliente antes de facturar.
//
// 600 caracteres es el tope del `resumen` de una escalada (`RESUMEN_DESCRIBE`,
// tools.ts). Lo que sobre de las capturas leídas se recorta por frases enteras;
// la primera frase, la advertencia de retiro y el cierre nunca se pierden.
// ---------------------------------------------------------------------------

const MAX_RESUMEN_CHARS = 600;
const MAX_BANCO_CHARS = 40;

/** 1234.5 → "1.234,50" (es-VE). A mano, sin `Intl`: no depende de los datos de ICU del Node que corra. */
function montoVE(monto: number): string {
  const [entera, decimales] = Math.abs(monto).toFixed(2).split(".");
  const conMiles = entera.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${monto < 0 ? "-" : ""}${conMiles},${decimales}`;
}

/** La frase "Leído de la captura: …" de un comprobante, o `null` si no se leyó nada. */
function fraseDeComprobante(campos: ImageFields): string | null {
  const c = campos.comprobante;
  if (!c) return null;

  const partes: string[] = [];
  if (c.monto !== null) {
    const prefijo = c.moneda === "VES" ? "Bs " : c.moneda === "USD" ? "$" : "";
    partes.push(`${prefijo}${montoVE(c.monto)}`);
  }
  if (c.referencia) partes.push(`ref. …${c.referencia}`);
  if (c.banco) partes.push(c.banco.slice(0, MAX_BANCO_CHARS));
  if (c.fecha) partes.push(c.fecha);

  return partes.length > 0 ? `Leído de la captura: ${partes.join(" · ")}.` : null;
}

/** La frase "Orden de Cashea: …", o `null` si no se leyó ni la modalidad ni el total. */
function fraseDeOrden(campos: ImageFields): string | null {
  const o = campos.orden_cashea;
  if (!o) return null;

  const partes: string[] = [];
  if (o.modalidad) partes.push(o.modalidad === "retiro" ? "retiro en tienda" : "envío");
  if (o.total_usd !== null) partes.push(`total $${montoVE(o.total_usd)}`);

  return partes.length > 0 ? `Orden de Cashea: ${partes.join(" · ")}.` : null;
}

export function resumenDeComprobante(campos: readonly ImageFields[]): string {
  const hayComprobante = campos.some((c) => esComprobante(c));
  const hayOrden = campos.some((c) => esOrdenCashea(c));

  const quien =
    hayComprobante && hayOrden
      ? "un comprobante de pago y una orden de Cashea"
      : hayOrden
        ? "una orden de Cashea"
        : "un comprobante de pago";
  const apertura = `El cliente envió ${quien}.`;

  // Las capturas en el orden en que llegaron; cada una aporta, a lo sumo, su
  // frase de lo leído (un comprobante) y la suya de la orden.
  const leidas: string[] = [];
  for (const c of campos) {
    const frases = [esComprobante(c) ? fraseDeComprobante(c) : null, esOrdenCashea(c) ? fraseDeOrden(c) : null];
    for (const frase of frases) if (frase) leidas.push(frase);
  }

  const ojo = campos.some((c) => esOrdenCashea(c) && c.orden_cashea?.modalidad === "retiro")
    ? "OJO: la orden quedó con RETIRO EN TIENDA; confirmar con el cliente si quería envío."
    : null;
  const cierre = "Verificar antes de confirmar: Seba no validó el pago.";

  // Lo que SIEMPRE va: apertura, advertencia de retiro y cierre. Lo leído se
  // suma frase por frase mientras quepa.
  const fijas = [apertura, ojo, cierre].filter((p): p is string => p !== null);
  let presupuesto = MAX_RESUMEN_CHARS - fijas.join(" ").length - 1;
  const caben: string[] = [];
  for (const frase of leidas) {
    if (frase.length + 1 > presupuesto) break;
    caben.push(frase);
    presupuesto -= frase.length + 1;
  }

  return [apertura, ...caben, ...(ojo ? [ojo] : []), cierre].join(" ");
}
