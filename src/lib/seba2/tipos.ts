import type { ConsultaCatalogo } from "@/lib/ai/tools";
import type { Area } from "@/lib/seba-v2-config";
import type { CartPriceKind } from "@/lib/types";

/**
 * Tipos compartidos por todo el turno de Seba v2 (entrega 3 del rework, 17/11/2026).
 *
 * Módulo PURO: solo `import type` de lo que arrastra `server-only` (`ai/tools`),
 * así que lo puede importar cualquier archivo —incluido un test— sin levantar
 * Supabase, Redis ni los SDK de IA.
 */

export type { Area };

/** Quién escribió el texto que sale al cliente: el modelo, el código (textos fijos) o una herramienta. */
export type OrigenTexto = "modelo" | "fijo" | "herramienta";

export const ETAPAS = [
  "entender",
  "cotizado",
  "eligiendo_pago",
  "datos_enviados",
  "comprobante_recibido",
  "con_asesor",
] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ENTREGAS = ["envio", "retiro", "delivery"] as const;
export type Entrega = (typeof ENTREGAS)[number];

export interface LineaDePedido {
  productId: string;
  cantidad: number;
}

/** Lo que Seba recuerda del pedido de ESTA conversación entre un turno y el siguiente. */
export interface EstadoSeba {
  etapa: Etapa;
  lineas: LineaDePedido[];
  /** `"cashea"` o la key de una forma de contado (`payment_methods`). */
  forma: string | null;
  entrega: Entrega | null;
  ciudad: string | null;
  totalUsd: number | null;
  totalBs: number | null;
  priceKind: CartPriceKind | null;
  complementoSugerido: boolean;
  ultimaFraseApertura: string | null;
  /** ISO. Decide la vigencia (`estadoVigente`). */
  actualizadoEn: string;
}

/** Pasado este plazo sin tocarse, el estado guardado se ignora: el pedido ya es historia. */
export const ESTADO_VIGENCIA_DIAS = 7;

/** Una línea del pedido admite de 1 a 20 unidades; fuera de eso es dato corrupto, no un pedido. */
const CANTIDAD_MIN = 1;
const CANTIDAD_MAX = 20;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Estado nuevo y vacío (etapa «entender»). */
export function estadoInicial(ahora: Date): EstadoSeba {
  return {
    etapa: "entender",
    lineas: [],
    forma: null,
    entrega: null,
    ciudad: null,
    totalUsd: null,
    totalBs: null,
    priceKind: null,
    complementoSugerido: false,
    ultimaFraseApertura: null,
    actualizadoEn: ahora.toISOString(),
  };
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

function textoONull(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null;
}

function numeroONull(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function parseLineas(valor: unknown): LineaDePedido[] {
  if (!Array.isArray(valor)) return [];
  const lineas: LineaDePedido[] = [];
  for (const item of valor) {
    if (!esObjeto(item)) continue;
    const { productId, cantidad } = item;
    if (typeof productId !== "string" || productId === "") continue;
    if (typeof cantidad !== "number" || !Number.isInteger(cantidad)) continue;
    if (cantidad < CANTIDAD_MIN || cantidad > CANTIDAD_MAX) continue;
    lineas.push({ productId, cantidad });
  }
  return lineas;
}

/**
 * Lee un valor desconocido —el jsonb de la base, que cualquier asesor con acceso
 * puede escribir a mano— y devuelve un `EstadoSeba` válido o `null`. NUNCA lanza.
 *
 * Una línea mal formada se descarta sola (el resto del pedido sigue en pie); una
 * etapa o una entrega desconocida invalida el estado ENTERO: no hay forma segura
 * de adivinar en qué punto de la venta iba la conversación, y Seba prefiere
 * empezar de cero a seguir un guion que no entiende.
 */
export function parseEstadoSeba(valor: unknown): EstadoSeba | null {
  if (!esObjeto(valor)) return null;

  const { etapa, entrega, priceKind } = valor;
  if (typeof etapa !== "string" || !(ETAPAS as readonly string[]).includes(etapa)) return null;

  let entregaLeida: Entrega | null = null;
  if (entrega !== null && entrega !== undefined) {
    if (typeof entrega !== "string" || !(ENTREGAS as readonly string[]).includes(entrega)) return null;
    entregaLeida = entrega as Entrega;
  }

  return {
    etapa: etapa as Etapa,
    lineas: parseLineas(valor.lineas),
    forma: textoONull(valor.forma),
    entrega: entregaLeida,
    ciudad: textoONull(valor.ciudad),
    totalUsd: numeroONull(valor.totalUsd),
    totalBs: numeroONull(valor.totalBs),
    priceKind: priceKind === "promocion" || priceKind === "estandar" ? priceKind : null,
    complementoSugerido: valor.complementoSugerido === true,
    ultimaFraseApertura: textoONull(valor.ultimaFraseApertura),
    // Sin fecha legible se conserva vacía: `estadoVigente` la leerá como vencida.
    actualizadoEn: typeof valor.actualizadoEn === "string" ? valor.actualizadoEn : "",
  };
}

/**
 * Devuelve el estado si `actualizadoEn` tiene menos de `ESTADO_VIGENCIA_DIAS`
 * respecto de `ahora`; si no (o si la fecha no se puede leer), `null`.
 */
export function estadoVigente(estado: EstadoSeba | null, ahora: Date): EstadoSeba | null {
  if (estado === null) return null;
  const desde = Date.parse(estado.actualizadoEn);
  if (Number.isNaN(desde)) return null;
  return ahora.getTime() - desde < ESTADO_VIGENCIA_DIAS * MS_POR_DIA ? estado : null;
}

export interface MensajeDeTurno {
  orden: number;
  tipo: "texto" | "imagen";
  texto: string;
  origen: OrigenTexto;
  mediaUrl?: string;
}

export interface GuardaDisparada {
  guarda: string;
  fragmento: string;
}

export interface ContextoDeTurno {
  iaGlobal: boolean;
  asesorAsignado: boolean;
  asesorEscribioHaceMin: number | null;
}

export interface TokensDeTurno {
  input: number;
  output: number;
  cachedInput: number;
  reasoning: number;
}

export interface ResumenDeTurno {
  accion: "answered" | "escalated" | "skipped" | "error";
  /** Una línea para la bitácora. */
  resumen: string;
  rafaga: string[];
  triggerMessageId: string | null;
  estadoAntes: EstadoSeba | null;
  estadoDespues: EstadoSeba | null;
  herramientas: string[];
  /** Ids de producto cotizados o pedidos en el turno. */
  productos: string[];
  guardas: GuardaDisparada[];
  contexto: ContextoDeTurno;
  tokens: TokensDeTurno | null;
  modelo: string | null;
  duracionMs: number;
  consultasCatalogo?: ConsultaCatalogo[];
}

export interface LineaDeCarrito {
  productId: string;
  cantidad: number;
  priceKind: CartPriceKind;
}

export interface ResultadoDePase {
  asignado: boolean;
  /** ¿La tienda está abierta ahora? */
  abierta: boolean;
  /** Cuándo abre, ya redactado («el lunes a las 8:00 am»); `null` si está abierta. */
  cuandoAbre: string | null;
  yaTeniaAsesor: boolean;
}
