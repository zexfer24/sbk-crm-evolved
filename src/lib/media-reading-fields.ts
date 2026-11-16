// ---------------------------------------------------------------------------
// Campos de la lectura de una imagen del cliente (plan "Seba lee fotos y
// audios", 16/11/2026).
//
// Módulo PURO a propósito: sin `server-only`, sin zod, sin imports de `ai/`.
// Lo usan el servidor (la lectura que se guarda en `message_readings.fields`)
// y el navegador (la bandeja pinta el comprobante y la orden de Cashea), y
// arrastrar el SDK de IA al bundle del cliente por una lista de tipos sería
// pagar mucho por nada. El schema de zod con que se le pide la salida al
// modelo vive en `ai/media-reading.ts`; acá solo el contrato de lo guardado.
//
// `parseImageFields` es tolerante a propósito: `fields` es un jsonb que puede
// traer una forma vieja o corrupta, y una lectura que no se entiende no puede
// tumbar la pantalla de una conversación.
// ---------------------------------------------------------------------------

export type ReadingStatus = "ok" | "vacio" | "alucinacion" | "fallo";
/** Lo que guarda la base: además de los cuatro resultados, "aún no se lee". */
export type StoredReadingStatus = "pendiente" | ReadingStatus;

export const IMAGE_TIPOS = [
  "repuesto",
  "casco_o_accesorio",
  "moto",
  "comprobante_pago",
  "orden_cashea",
  "guia_mrw",
  "producto_danado",
  "captura_de_chat_o_publicacion",
  "documento_identidad",
  "otro",
] as const;
export type ImageTipo = (typeof IMAGE_TIPOS)[number];

export interface ComprobanteLeido {
  monto: number | null;
  moneda: "VES" | "USD" | null;
  /** Solo los últimos 6 dígitos: la referencia completa no se guarda. */
  referencia: string | null;
  banco: string | null;
  fecha: string | null;
}

export interface OrdenCasheaLeida {
  modalidad: "envio" | "retiro" | null;
  total_usd: number | null;
}

export interface ImageFields {
  tipo: ImageTipo;
  es_comprobante_pago: boolean;
  /** Literal, ≤ 500 caracteres; "" si no hay. */
  texto_visible: string;
  /** Como lo nombraría un vendedor: "casco integral", "kit de arrastre". */
  producto_visible: string | null;
  marca_visible: string | null;
  modelo_moto_visible: string | null;
  medida_visible: string | null;
  comprobante: ComprobanteLeido | null;
  orden_cashea: OrdenCasheaLeida | null;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Texto no vacío o null: un string en blanco no es un dato leído. */
function textoONull(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  return limpio === "" ? null : limpio;
}

function numeroONull(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function parseComprobante(valor: unknown): ComprobanteLeido | null {
  if (!esObjeto(valor)) return null;
  const moneda = valor.moneda === "VES" || valor.moneda === "USD" ? valor.moneda : null;
  return {
    monto: numeroONull(valor.monto),
    moneda,
    referencia: ultimosSeisDigitos(typeof valor.referencia === "string" ? valor.referencia : null),
    banco: textoONull(valor.banco),
    fecha: textoONull(valor.fecha),
  };
}

function parseOrdenCashea(valor: unknown): OrdenCasheaLeida | null {
  if (!esObjeto(valor)) return null;
  const modalidad = valor.modalidad === "envio" || valor.modalidad === "retiro" ? valor.modalidad : null;
  return { modalidad, total_usd: numeroONull(valor.total_usd) };
}

/**
 * Lee `message_readings.fields` (jsonb, llega como `unknown`). Nunca lanza:
 * `null` si no es un objeto o su `tipo` no es uno de la lista; cualquier otro
 * campo ausente o de tipo equivocado cae a su vacío ("" / null / false).
 */
export function parseImageFields(value: unknown): ImageFields | null {
  if (!esObjeto(value)) return null;
  const tipo = IMAGE_TIPOS.find((t) => t === value.tipo);
  if (!tipo) return null;

  return {
    tipo,
    es_comprobante_pago: value.es_comprobante_pago === true,
    texto_visible: typeof value.texto_visible === "string" ? value.texto_visible : "",
    producto_visible: textoONull(value.producto_visible),
    marca_visible: textoONull(value.marca_visible),
    modelo_moto_visible: textoONull(value.modelo_moto_visible),
    medida_visible: textoONull(value.medida_visible),
    comprobante: parseComprobante(value.comprobante),
    orden_cashea: parseOrdenCashea(value.orden_cashea),
  };
}

/** Comprobante por la bandera del modelo o por el tipo: las dos vías valen. */
export function esComprobante(fields: ImageFields | null | undefined): boolean {
  return Boolean(fields && (fields.es_comprobante_pago || fields.tipo === "comprobante_pago"));
}

export function esOrdenCashea(fields: ImageFields | null | undefined): boolean {
  return fields?.tipo === "orden_cashea";
}

/**
 * Referencia de un pago reducida a sus últimos 6 dígitos. La referencia
 * completa identifica una operación bancaria: para cotejar un pago alcanzan
 * los seis últimos y no hay motivo para guardar más.
 */
export function ultimosSeisDigitos(referencia: string | null | undefined): string | null {
  if (!referencia) return null;
  const digitos = referencia.replace(/\D/g, "");
  return digitos === "" ? null : digitos.slice(-6);
}
