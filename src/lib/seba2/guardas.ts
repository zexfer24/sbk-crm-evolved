// ---------------------------------------------------------------------------
// Guardas de salida de Seba v2 (entrega 3 del rework, tarea S7, 17/11/2026).
//
// Regla del sistema: ninguna cifra sale del modelo; Seba nunca confirma un
// pago; nunca se presenta por su nombre («Seba» es un nombre interno, D7); y el
// enlace y las cuotas de Cashea los da un asesor (D4). Una prohibición en el
// prompt no es una garantía, así que esta función PURA revisa el texto que el
// modelo redactó antes de que llegue al cliente y dice QUÉ regla lo frenó. El
// reintento de redacción (uno solo; si vuelve a fallar, pase a ventas con
// `TEXTO_PASE.ventas`) lo hace el turno, no este módulo.
//
// Casos reales que motivan cada regla:
//   - estado_interno: «La búsqueda de catálogo está temporalmente apagada»
//     (el modelo contándole al cliente el interruptor de una herramienta).
//   - nombre_interno: «Te va a atender el Asesor 2» (la etiqueta interna del
//     roster, no un nombre que el cliente conozca).
//   - pago_confirmado: «¡Gracias por tu compra! Ya estamos procesando tu
//     pedido» (confirmar un pago que solo un asesor verifica).
//   - cashea_calculada: «inicial $36,60 y 6 cuotas de $14,23» (13/9/2026: una
//     cuenta de memoria que ya se había prohibido en el guion).
//   - nombre_propio: «Soy Seba».
//   - dato_de_pago: un número de cuenta inventado por el modelo.
//
// Se REUTILIZAN, sin tocarlas, las tres guardas de v1 (`identity-guard`,
// `price-guard`, `promise-guard`). Módulo puro a propósito, igual que ellas:
// sin Supabase, sin `server-only`, sin Redis — lo importa el turno, pero
// también debe poder probarse sin levantar nada.
// ---------------------------------------------------------------------------

import { revealsIdentity } from "@/lib/ai/identity-guard";
import { findUnsourcedFigure } from "@/lib/ai/price-guard";
import { afirmaPromesaDeAsesor } from "@/lib/ai/promise-guard";

/** En el orden en que se evalúan: se devuelve la primera que falla. */
export const GUARDAS = [
  "identidad",
  "nombre_propio",
  "cifra_sin_fuente",
  "promesa_sin_pase",
  "estado_interno",
  "nombre_interno",
  "pago_confirmado",
  "dato_de_pago",
  "cashea_calculada",
] as const;

export type Guarda = (typeof GUARDAS)[number];

export interface ContextoDeSalida {
  /** Textos de los que una cifra, un enlace o un dato puede salir legítimamente: lo que devolvieron las herramientas EN ESTE turno y las lecciones del equipo. */
  fuentes: string[];
  /** ¿Este turno ya le pasó el caso a un asesor (o había una escalada abierta)? */
  pasoEnEsteTurno: boolean;
  /** `display_name` de los asesores, para que el modelo no nombre a ninguno. */
  nombresDeAsesores: string[];
  /** Lo que el cliente escribió en la ráfaga que se está respondiendo. */
  rafaga: string[];
}

export type VeredictoDeSalida = { ok: true } | { ok: false; guarda: Guarda; fragmento: string };

const MAX_FRAGMENTO = 120;

// ---------------------------------------------------------------------------
// Texto normalizado CON mapa de índices
// ---------------------------------------------------------------------------
// Las reglas de texto comparan sin tildes ni mayúsculas, pero el fragmento que
// se devuelve (y que se le cita al modelo en el reintento) tiene que ser el
// trozo ORIGINAL. Normalizar por unidad de código y guardar de qué posición
// vino cada carácter deja recortar el original sin suponer que NFD conserva el
// largo (un diacrítico suelto, ya descompuesto en la entrada, lo rompería).

const MARCAS_COMBINANTES = /[̀-ͯ]/g;

interface Vista {
  original: string;
  /** Minúsculas y sin diacríticos. */
  plano: string;
  /** `mapa[i]` = posición en `original` del carácter `plano[i]`. */
  mapa: number[];
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(MARCAS_COMBINANTES, "").toLowerCase();
}

function crearVista(original: string): Vista {
  let plano = "";
  const mapa: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const unidad = normalizar(original[i]!);
    for (let k = 0; k < unidad.length; k++) {
      plano += unidad[k]!;
      mapa.push(i);
    }
  }
  return { original, plano, mapa };
}

/** El trozo del texto ORIGINAL que cubre un calce hecho sobre `vista.plano`. */
function trozoOriginal(vista: Vista, indice: number, largo: number): string {
  const inicio = vista.mapa[indice] ?? 0;
  const ultimo = vista.mapa[indice + Math.max(largo, 1) - 1] ?? vista.original.length - 1;
  return vista.original.slice(inicio, ultimo + 1);
}

/** El primer patrón (en el orden de la lista) que calza sobre el texto plano. */
function primerCalce(vista: Vista, patrones: readonly RegExp[]): string | null {
  for (const patron of patrones) {
    const calce = patron.exec(vista.plano);
    if (calce) return trozoOriginal(vista, calce.index, calce[0].length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

// nombre_propio (D7). `\b` de JS no entiende tildes, pero «seba» no lleva
// ninguna: «Sebastián» (nombre de un cliente posible), «Sebas» y «cebada» no
// calzan porque después de «seba» sigue una letra.
const NOMBRE_PROPIO = /\bseba\b/i;

// estado_interno. Sobre texto plano (sin tildes, minúsculas).
// «el sistema» pelado delata la maquinaria («el sistema no me muestra eso»),
// pero el catálogo de esta tienda vende partes de un sistema: «el sistema de
// frenos», «el sistema eléctrico» no son el sistema interno.
const PARTES_DEL_SISTEMA =
  "frenos|escape|suspension|arranque|encendido|carga|enfriamiento|alimentacion|inyeccion|transmision|embrague|combustible|lubricacion";
const PATRONES_ESTADO_INTERNO: readonly RegExp[] = [
  new RegExp(
    String.raw`\bel sistema\b(?! de (?:${PARTES_DEL_SISTEMA})\b)(?! (?:electrico|hidraulico|abs)\b)`
  ),
  // «el catálogo» solo cuando va con un verbo de estado o de falla: «te envío
  // el catálogo» y «en el catálogo aparece» son lenguaje normal de vendedor.
  /\bel catalogo (?:no (?:responde|carga|abre|funciona|sirve|esta|aparece|muestra|me)|esta (?:apagad|caid|fuera|temporal|inactiv|desactivad|en mantenimiento|sin\b|fallando|presentando|cargando|vacio|actualizand)|se (?:cayo|cae|apago|esta)|sigue (?:apagad|caid|fallando|sin\b)|anda\b|falla|fallo|presenta (?:un )?(?:error|falla|problema)|tiene (?:un )?(?:error|falla|problema))/,
  /\bno (?:me )?(?:carga|abre|funciona|responde|sale|aparece|muestra|sirve)\w* (?:el )?catalogo\b/,
  /\bla busqueda\b/,
  /\bla herramienta\b/,
  /\bbase de datos\b/,
  /\bapagad/,
  /\bfuera de servicio\b/,
  /\binformacion disponible\b/,
  /\bno tengo registrad/,
];

// nombre_interno: la etiqueta «Asesor 2» / «asesora3» del roster.
const ETIQUETA_DE_ASESOR = /\basesor(?:a)?\s?\d+\b/i;

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** El nombre de un asesor como palabra o frase completa, o `null` si no aparece. */
function nombreDeAsesorEnTexto(vista: Vista, nombres: string[]): string | null {
  for (const nombre of nombres) {
    const limpio = normalizar(nombre).trim().replace(/\s+/g, " ");
    if (limpio.length < 3) continue;
    const patron = new RegExp(
      `(?<![a-z0-9])${escaparRegex(limpio).replace(/ /g, "\\s+")}(?![a-z0-9])`
    );
    const calce = patron.exec(vista.plano);
    if (calce) return trozoOriginal(vista, calce.index, calce[0].length);
  }
  return null;
}

// pago_confirmado. Confirmar un pago o una compra solo lo hace un asesor;
// «recibimos tu comprobante» no calza a propósito (recibir no es confirmar).
const PATRONES_PAGO_CONFIRMADO: readonly RegExp[] = [
  /\bgracias por (?:tu|su) compra\b/,
  /\b(?:pago|compra) (?:(?:ya )?(?:fue|ha sido|quedo|esta) )?(?:verificad|confirmad|aprobad)[oa]s?\b/,
  /\bpago recibido con exito\b/,
];

// dato_de_pago: lo que el modelo no puede inventar. Un enlace o un número que
// vino de la ráfaga del cliente o de lo que trajo una herramienta en ESTE turno
// (el enlace de un catálogo, el de la ubicación) es legítimo.
const SECUENCIA_LARGA_DE_DIGITOS = /\d{7,}/g;
const CORREO = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ENLACE = /(?:https?:\/\/|www\.)\S+/gi;
// Puntuación o formato de WhatsApp (*negrita*, _cursiva_) pegado al final de un
// enlace o correo: no es parte de él, y sin quitarla «…/catalogo.» no sería
// subcadena de la fuente que dice «…/catalogo».
const COLA_DE_PUNTUACION = /[.,;:!?)\]}»"'*_]+$/;

function datoDePagoSinFuente(texto: string, ctx: ContextoDeSalida): string | null {
  const respaldo = [...ctx.rafaga, ...ctx.fuentes];
  const respaldado = (dato: string) => respaldo.some((fuente) => fuente.includes(dato));

  const candidatos: string[] = [];
  for (const m of texto.matchAll(new RegExp(ENLACE.source, ENLACE.flags))) {
    candidatos.push(m[0].replace(COLA_DE_PUNTUACION, ""));
  }
  for (const m of texto.matchAll(new RegExp(CORREO.source, CORREO.flags))) {
    candidatos.push(m[0].replace(COLA_DE_PUNTUACION, ""));
  }
  for (const m of texto.matchAll(new RegExp(SECUENCIA_LARGA_DE_DIGITOS.source, "g"))) {
    candidatos.push(m[0]);
  }
  return candidatos.find((dato) => !respaldado(dato)) ?? null;
}

// cashea_calculada (D4). La inicial, las cuotas y el nivel de Cashea los
// calcula y los dice un asesor. Aun con la cifra respaldada por una fuente, una
// CUENTA de Cashea no es un dato de herramienta. «cuotas desde 100 $» (lo dice
// el sistema) no calza: el `\bde\b` no empata con «desde».
const MONTO = String.raw`(?:\$|\bbs\b|\bdolares?\b|\bbolivares?\b|\busd\b|\d+[.,]\d+)`;
const PATRONES_CASHEA_MONTO: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:inicial|cuotas?) de\b[\s\S]{0,12}?${MONTO}`),
  // «inicial $36,60» sin el «de»: igual es la cuenta calculada.
  /\binicial[\s:*_]{0,4}(?:\$|bs\b)/,
];
const PALABRA_DE_CASHEA = /\b(?:inicial|nivel|cuotas?)\b/;
const VENTANA_DE_PORCENTAJE = 40;

function porcentajeDeCashea(vista: Vista): string | null {
  for (const m of vista.plano.matchAll(/\d+\s?%/g)) {
    const desde = Math.max(0, m.index - VENTANA_DE_PORCENTAJE);
    const hasta = m.index + m[0].length + VENTANA_DE_PORCENTAJE;
    if (PALABRA_DE_CASHEA.test(vista.plano.slice(desde, hasta))) {
      return trozoOriginal(vista, m.index, m[0].length);
    }
  }
  return null;
}

interface Regla {
  guarda: Guarda;
  /** El fragmento que la disparó, o `null` si el texto pasa esta regla. */
  revisar(vista: Vista, ctx: ContextoDeSalida): string | null;
}

// El orden de esta lista ES el orden de evaluación (el de `GUARDAS`): un texto
// que viola dos reglas devuelve la primera.
const REGLAS: readonly Regla[] = [
  {
    guarda: "identidad",
    revisar: (v) => revealsIdentity(v.original)?.fragmento ?? null,
  },
  {
    guarda: "nombre_propio",
    revisar: (v) => NOMBRE_PROPIO.exec(v.original)?.[0] ?? null,
  },
  {
    guarda: "cifra_sin_fuente",
    revisar: (v, ctx) => findUnsourcedFigure(v.original, [...ctx.fuentes, ...ctx.rafaga]),
  },
  {
    guarda: "promesa_sin_pase",
    revisar: (v, ctx) => (ctx.pasoEnEsteTurno ? null : afirmaPromesaDeAsesor(v.original)),
  },
  {
    guarda: "estado_interno",
    revisar: (v) => primerCalce(v, PATRONES_ESTADO_INTERNO),
  },
  {
    guarda: "nombre_interno",
    revisar: (v, ctx) =>
      ETIQUETA_DE_ASESOR.exec(v.original)?.[0] ?? nombreDeAsesorEnTexto(v, ctx.nombresDeAsesores),
  },
  {
    guarda: "pago_confirmado",
    revisar: (v) => primerCalce(v, PATRONES_PAGO_CONFIRMADO),
  },
  {
    guarda: "dato_de_pago",
    revisar: (v, ctx) => datoDePagoSinFuente(v.original, ctx),
  },
  {
    guarda: "cashea_calculada",
    revisar: (v) => primerCalce(v, PATRONES_CASHEA_MONTO) ?? porcentajeDeCashea(v),
  },
];

function recortar(fragmento: string): string {
  const limpio = fragmento.trim();
  return limpio.length > MAX_FRAGMENTO ? limpio.slice(0, MAX_FRAGMENTO) : limpio;
}

/**
 * Decide si un texto redactado por el modelo puede llegarle al cliente. Se
 * aplica solo a textos de origen «modelo»: los textos fijos del código (pase,
 * cotización armada) no pasan por acá. Devuelve la PRIMERA regla que falla y el
 * trozo del texto que la disparó (recortado a 120 caracteres).
 */
export function revisarSalida(texto: string, ctx: ContextoDeSalida): VeredictoDeSalida {
  const vista = crearVista(texto);
  for (const regla of REGLAS) {
    const fragmento = regla.revisar(vista, ctx);
    if (fragmento !== null) {
      return { ok: false, guarda: regla.guarda, fragmento: recortar(fragmento) };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Instrucción de reescritura
// ---------------------------------------------------------------------------

const NOMBRE_INTERNO_EN_FRAGMENTO = /\bseba\b/gi;

/**
 * Una frase para pedirle al modelo UNA reescritura sin el fragmento señalado.
 * Nunca nombra a «Seba» (ni siquiera si el fragmento lo trae, p. ej. dentro de
 * una URL) y no explica el sistema: dice qué no puede dar y, si hace falta,
 * que un asesor lo confirma. Para `nombre_propio` no cita el fragmento — el
 * fragmento ES el nombre, y citarlo sería nombrarlo —; pide no usar ninguno.
 */
export function instruccionDeReescritura(veredicto: { guarda: Guarda; fragmento: string }): string {
  const cita = `«${veredicto.fragmento.replace(NOMBRE_INTERNO_EN_FRAGMENTO, "…")}»`;
  switch (veredicto.guarda) {
    case "identidad":
      return `Reescribe tu respuesta sin decir ${cita}: no te describas ni digas qué eres; céntrate en ayudar con lo que el cliente pidió.`;
    case "nombre_propio":
      return "Reescribe tu respuesta sin presentarte con ningún nombre propio: no digas cómo te llamas.";
    case "cifra_sin_fuente":
      return `Reescribe tu respuesta sin la cifra ${cita}: no puedes dar ese monto; si hace falta, di que un asesor lo confirma.`;
    case "promesa_sin_pase":
      return `Reescribe tu respuesta sin decir ${cita}: todavía no le has pasado el caso a nadie, así que no prometas que un asesor lo atiende.`;
    case "estado_interno":
      return `Reescribe tu respuesta sin decir ${cita}: no hables de herramientas, sistemas ni estados internos; si no tienes el dato, di que un asesor lo confirma.`;
    case "nombre_interno":
      return `Reescribe tu respuesta sin nombrar ${cita}: no menciones nombres ni números de asesores; di solo «un asesor».`;
    case "pago_confirmado":
      return `Reescribe tu respuesta sin decir ${cita}: no puedes confirmar pagos ni compras; di que un asesor verifica el pago.`;
    case "dato_de_pago":
      return `Reescribe tu respuesta sin incluir ${cita}: no puedes dar números, correos ni enlaces que no vengan de esta conversación; si hace falta, di que un asesor los envía.`;
    case "cashea_calculada":
      return `Reescribe tu respuesta sin decir ${cita}: no calcules ni menciones inicial, cuotas ni porcentajes de Cashea; di que un asesor lo confirma.`;
  }
}
