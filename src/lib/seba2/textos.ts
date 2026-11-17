import type { Area } from "@/lib/seba-v2-config";

/**
 * Textos fijos de Seba v2 (17/11/2026). Los manda el CÓDIGO, no el modelo:
 * literales de la sección «3. Textos fijos» de `docs/seba-v2/system-prompt-seba-v2.md`.
 *
 * Decisiones del operador que estos textos respetan: Seba nunca se presenta por
 * su nombre; nunca confirma un pago ni dice «gracias por tu compra»; el enlace de
 * Cashea lo manda un asesor. Por eso ningún texto de este archivo puede traer esas
 * frases, y `textos.test.ts` lo vigila. Es un módulo puro: sin Supabase, sin Redis.
 */

/** Lo que el cliente lee cuando su caso pasa a un asesor del área. */
export const TEXTO_PASE: Record<Area, string> = {
  ventas: "Ya pasé tu caso a un asesor de ventas, te escribe por este mismo chat.",
  pagos: "Ya pasé tu caso al área de pagos, te escriben por este mismo chat.",
  envios: "Ya pasé tu caso al área de envíos, te escriben por este mismo chat.",
  reclamos: "Lamentamos lo ocurrido. Ya pasé tu caso al área de reclamos y te escriben por este mismo chat.",
};

/** Lo manda `recibirComprobante`. NO dice que el pago esté confirmado: lo verifica un asesor. */
export const TEXTO_COMPROBANTE_RECIBIDO =
  "¡Gracias! Recibimos tu comprobante ✅\nUn asesor lo verifica y te confirma por este mismo chat.";

/** Se suma al comprobante cuando el pedido es con Cashea; con talla si el producto la exige. */
export function lineaCedulaCashea(pedirTalla: boolean): string {
  return pedirTalla
    ? "Mientras tanto, pásame la cédula del titular de Cashea y la talla."
    : "Mientras tanto, pásame la cédula del titular de Cashea.";
}

/** Se suma al comprobante fuera de horario. `cuandoAbre` ya viene redactado («el lunes a las 8:00 am»). */
export function lineaTiendaCerrada(cuandoAbre: string): string {
  return `La tienda abre ${cuandoAbre}; apenas abramos lo revisan.`;
}

export const LINEA_PEDIR_COMPROBANTE = "Cuando pagues, envíame el capture del comprobante 🙌";

/** Con Binance el monto en divisa lo da el asesor (decisión D3): el código no calcula nada. */
export const LINEA_ASESOR_BINANCE =
  "Un asesor te confirma el monto en divisa y los datos de Binance por este mismo chat.";

export const ENCABEZADO_PEDIDO = "Tu pedido:";
export const LINEA_ENVIO_GRATIS_CASHEA = "envío gratis con Cashea";
export const ETIQUETA_TOTAL = "Total";
export const ETIQUETA_TOTAL_CON_ENVIO = "Total con envío MRW incluido";

/**
 * Lo que el cliente recibe cuando el turno no puede redactar (falla de herramienta
 * o del modelo, o una guarda que no se pudo reescribir). Nunca explica el motivo
 * interno: al cliente no le sirve saber qué se rompió.
 */
export const TEXTO_UN_ASESOR_TE_CONFIRMA = "Un asesor te lo confirma por este mismo chat.";

/** Cuando no se pudo leer una foto o un audio. */
export const TEXTO_NO_PUDE_LEER = "No pude ver bien lo que enviaste. ¿Me lo escribes, por favor?";

/**
 * Lo que sale cuando la asignación a un asesor FALLÓ (S6, 17/11/2026): no promete
 * un asesor que no existe y por eso no contiene «asesor». El caso queda sin dueño
 * y lo recoge el reconciliador / «Sin dueño», pero el cliente no se queda callado.
 */
export const TEXTO_SEGUIMOS_POR_AQUI = "Dame un momento, ya te confirmo por este mismo chat.";
