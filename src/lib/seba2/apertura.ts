import { isGreetingOnly } from "@/lib/ai/saludo";
import { esComprobante, esOrdenCashea, type ImageFields } from "@/lib/media-reading-fields";
import { estadoVigente, type EstadoSeba } from "./tipos";

/**
 * La apertura de Seba v2: la bienvenida en dos mensajes (entrega 3 del rework,
 * 17/11/2026, tarea S4; casos A1-A10 de `docs/seba-v2/casos-borde-seba-v2.md`).
 *
 * Una vez por ventana de 24 h: el mensaje 1 es un texto informativo fijo
 * (configurable por el supervisor) y el mensaje 2 es una frase fija elegida por
 * el código —solo si el cliente nada más saludó— o la respuesta del modelo a lo
 * que preguntó. Antes la IA saludaba y se tragaba la pregunta (23 hallazgos del
 * estudio: `05a80d09`, `b60953c5`, `737eccd9`); por eso «Hola, precio del
 * impermeable Givi» NO es «solo saludo».
 *
 * Módulo PURO: sin Supabase, sin Redis y sin reloj global (`now` llega por
 * parámetro), para probarlo sin levantar nada. Enviar lo hace el turno.
 */

/** Caracas no tiene horario de verano: UTC-4 fijo, todo el año. */
const OFFSET_CARACAS_MS = 4 * 60 * 60 * 1000;

/** Quita acentos y pasa a minúsculas, igual que `ai/saludo.ts`. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Toda la ráfaga son saludos (cada línea pasa `isGreetingOnly`) y ninguna lleva
 * «?» ni «¿». Ráfaga vacía (o solo líneas en blanco) → `false`.
 *
 * El signo de pregunta se mira aparte porque `isGreetingOnly` ignora la
 * puntuación: «Hola?» es un saludo para esa función, pero el cliente está
 * preguntando algo y hay que dejar que el modelo lo atienda.
 */
export function esSoloSaludo(rafaga: readonly string[]): boolean {
  const lineas = rafaga.map((linea) => linea.trim()).filter((linea) => linea !== "");
  if (lineas.length === 0) return false;
  return lineas.every((linea) => !/[?¿]/.test(linea) && isGreetingOnly(linea));
}

/**
 * Compra o pago YA hecho, o un envío en curso. Patrones sobre texto normalizado
 * (sin tildes ni mayúsculas): «compré», «pagué», «ya hice el pago», «realicé la
 * compra», «ya cancelé» (en Venezuela «cancelar» es pagar), «guía», «tracking»,
 * «mi pedido/compra/orden».
 *
 * `compre`/`pague` van con un lookbehind contra «cuando», «si» y «para que»:
 * sin tilde son también el subjuntivo («cuando pague te aviso»), que es una
 * intención futura, no una compra hecha — justo lo contrario de postventa.
 */
const PATRONES_POSTVENTA: readonly RegExp[] = [
  /(?<!cuando |si |para que )\b(compre|pague)\b/,
  /\bya (hice|realice) (el|mi) pago\b/,
  /\bhice (el|mi) pago\b/,
  /\brealice (la|mi) compra\b/,
  /\brealice (el|mi) pago\b/,
  /\bya (lo |la |los |las )?(transferi|cancele|pague|pagado)\b/,
  /\bguia\b/,
  /\btracking\b/,
  /\bmi (pedido|compra|orden)\b/,
];

/**
 * ¿El cliente habla de una compra YA hecha o de un envío en curso? Caso A4: es
 * el 24 % de las ventas, y ofrecerle Cashea o el bloque informativo a quien ya
 * pagó fue una de las fricciones medidas.
 *
 * También cuenta la FOTO: un comprobante, una orden de Cashea o una guía de MRW
 * dicen «ya compré» aunque el cliente no escriba ni una palabra.
 */
export function esPostventa(rafaga: readonly string[], lecturas: readonly ImageFields[]): boolean {
  const porTexto = rafaga.some((linea) => {
    const texto = normalizar(linea);
    return PATRONES_POSTVENTA.some((patron) => patron.test(texto));
  });
  if (porTexto) return true;
  return lecturas.some((l) => esComprobante(l) || esOrdenCashea(l) || l.tipo === "guia_mrw");
}

/**
 * Elige una frase de `followups` distinta de `ultimaFraseUsada`, de forma
 * determinista por conversación y día (fecha de Caracas): suma de los códigos de
 * `conversationId + YYYY-MM-DD` módulo el número de candidatas. Nada de
 * `Math.random`: la misma entrada da la misma frase (un reintento del turno no
 * cambia lo que se le dice al cliente) y mañana cambia sola.
 *
 * Descarta las frases vacías. Si la única candidata es la última usada, la
 * devuelve igual: mejor repetir que callar. `null` si no hay ninguna utilizable.
 */
export function elegirFrase(
  followups: readonly string[],
  ultimaFraseUsada: string | null,
  conversationId: string,
  now: Date,
): string | null {
  const utilizables = followups.filter((frase) => frase.trim() !== "");
  if (utilizables.length === 0) return null;

  const distintas = utilizables.filter((frase) => frase !== ultimaFraseUsada);
  const candidatas = distintas.length > 0 ? distintas : utilizables;

  const diaCaracas = new Date(now.getTime() - OFFSET_CARACAS_MS).toISOString().slice(0, 10);
  const semilla = `${conversationId}${diaCaracas}`;
  let suma = 0;
  for (let i = 0; i < semilla.length; i++) suma += semilla.charCodeAt(i);
  return candidatas[suma % candidatas.length];
}

export interface EntradaDeApertura {
  conversationId: string;
  /** No hay un mensaje anterior del cliente, o el anterior a esta ráfaga tiene 24 h o más. */
  ventanaNueva: boolean;
  rafaga: readonly string[];
  lecturas: readonly ImageFields[];
  asesorAtendiendo: boolean;
  escaladaAbierta: boolean;
  estado: EstadoSeba | null;
  now: Date;
  welcomeText: string;
  followups: readonly string[];
  ultimaFraseUsada: string | null;
}

export interface DecisionDeApertura {
  /** ¿Este turno abre ventana (y por tanto hay que recordar la frase usada)? */
  apertura: boolean;
  /** El bloque informativo, o `null` si no corresponde (o el supervisor lo dejó vacío). */
  mensaje1: string | null;
  /** Frase fija del mensaje 2; `null` = el mensaje 2 lo redacta el modelo. */
  mensaje2Fijo: string | null;
}

const SIN_APERTURA: DecisionDeApertura = { apertura: false, mensaje1: null, mensaje2Fijo: null };

/** Etapas en las que el cliente ya está cerrando una compra: el bloque informativo estorba. */
const ETAPAS_DE_COMPRA_EN_CURSO: ReadonlySet<EstadoSeba["etapa"]> = new Set(["eligiendo_pago", "datos_enviados"]);

/**
 * Decide la apertura de un turno. UNA sola decisión para toda la ráfaga (A7): el
 * turno la calcula con lo que el cliente escribió hasta el último mensaje.
 *
 * Reglas, en este orden:
 * 1. Sin ventana nueva, o con asesor atendiendo o escalada abierta (A5): nada.
 *    Antes Seba saludó al mismo segundo que el asesor (`f04c8f82`, `eacbd193`).
 * 2. Postventa (A4): se abre, pero sin bloque informativo ni frase fija.
 * 3. Pedido vigente (< 7 días) en `eligiendo_pago` o `datos_enviados` (A6): sin
 *    bloque informativo; retoma el pedido.
 * 4. Si no, el bloque informativo es `welcomeText` (vacío → `null`).
 * 5. La frase fija del mensaje 2 solo si el cliente nada más saludó. Si hay una
 *    foto o un audio leído en la ráfaga (A3) NO sale la frase fija, aunque el
 *    texto sea «Hola»: el modelo tiene que responder sobre lo leído.
 */
export function decidirApertura(i: EntradaDeApertura): DecisionDeApertura {
  if (!i.ventanaNueva || i.asesorAtendiendo || i.escaladaAbierta) return SIN_APERTURA;

  if (esPostventa(i.rafaga, i.lecturas)) {
    return { apertura: true, mensaje1: null, mensaje2Fijo: null };
  }

  const vigente = estadoVigente(i.estado, i.now);
  const compraEnCurso = vigente !== null && ETAPAS_DE_COMPRA_EN_CURSO.has(vigente.etapa);
  const bienvenida = i.welcomeText.trim() === "" ? null : i.welcomeText;
  const mensaje1 = compraEnCurso ? null : bienvenida;

  const soloSaludo = i.lecturas.length === 0 && esSoloSaludo(i.rafaga);
  const mensaje2Fijo = soloSaludo ? elegirFrase(i.followups, i.ultimaFraseUsada, i.conversationId, i.now) : null;

  return { apertura: true, mensaje1, mensaje2Fijo };
}
