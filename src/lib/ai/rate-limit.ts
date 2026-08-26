import "server-only";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El único cuello por el que salen las llamadas al proveedor del modelo.
//
// Antes no existía ninguno. AGENT_MAX_CONCURRENT_TURNS limitaba TURNOS, que no
// es lo que cuenta el proveedor: un turno gasta hasta siete peticiones
// —escenario, clasificación y hasta cinco pasos del tool loop—, así que tres
// turnos simultáneos pueden ser veintiuna peticiones dentro del mismo minuto.
// Contra un techo de veinte por minuto eso desborda, y los reintentos internos
// del SDK (dos, separados por ~2 s) vuelven a pegar dentro de la misma ventana
// y lo empeoran. De ahí el 429 en cadena.
//
// Esto se aplica como middleware del modelo (ver model.ts), no en cada punto
// de llamada, y esa es la diferencia que importa: envuelve el modelo, así que
// cubre TODAS las peticiones que salgan de él —incluidos los pasos internos
// del ToolLoopAgent, que ningún envoltorio en el punto de llamada alcanza.
//
// Dos frenos, en este orden:
//   1. Concurrencia: cuántas peticiones pueden estar en vuelo a la vez.
//   2. Ritmo: cuántas pueden salir por minuto, en ventana deslizante.
//
// El objetivo de ritmo va DEBAJO del techo real (15 contra 20) porque los
// reintentos también gastan cuota: apuntando a 20, el primer 429 dejaría la
// ventana sin margen para reintentar y el turno moriría igual.
//
// Alcance: el estado es por proceso. Con una sola instancia —que es como corre
// hoy— es el ritmo real del sistema. Si algún día hay varias, el tope por
// minuto hay que repartirlo entre ellas o moverlo a Redis, como ya está el
// tope de turnos.
// ---------------------------------------------------------------------------

const VENTANA_MS = 60_000;

/** Margen para no despertar justo en el borde y encontrar la ventana todavía llena. */
const MARGEN_MS = 250;

/** Primera espera del backoff. En segundos: el límite se mide por minuto, no por milisegundo. */
const BASE_SEGUNDOS = 5;

/** Techo de una espera. Más allá conviene fallar el turno y dejar que la cola lo retome. */
const TOPE_ESPERA_SEGUNDOS = 60;

/**
 * Desorden que se le suma a cada espera.
 *
 * Sin esto, varios turnos que chocan con el mismo 429 esperan lo mismo y
 * vuelven todos juntos, reproduciendo el pico que causó el 429.
 */
const JITTER_SEGUNDOS = 3;

/** Peticiones en vuelo a la vez. Tres es el arranque; se ajusta sin recompilar. */
function topeConcurrente(): number {
  const configurado = Number(process.env.AI_MAX_CONCURRENT_REQUESTS);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 3;
}

/** Objetivo de ritmo. Debajo del techo del proveedor a propósito: ver el encabezado. */
function topePorMinuto(): number {
  const configurado = Number(process.env.AI_MAX_REQUESTS_PER_MINUTE);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 15;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Freno 1: concurrencia ---------------------------------------------------

let enVuelo = 0;
const esperandoCupo: Array<() => void> = [];

function adquirirCupo(): Promise<void> {
  if (enVuelo < topeConcurrente()) {
    enVuelo++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => esperandoCupo.push(resolve));
}

function liberarCupo(): void {
  // El cupo se traspasa a quien esperaba en vez de bajar la cuenta y volver a
  // subirla: entre las dos operaciones se colaría cualquiera que llegue nuevo,
  // y el que lleva más tiempo esperando nunca entraría.
  const siguiente = esperandoCupo.shift();
  if (siguiente) siguiente();
  else enVuelo--;
}

// --- Freno 2: ritmo por minuto ----------------------------------------------

let emitidas: number[] = [];

/**
 * Serializa la reserva de hueco.
 *
 * Sin esto, varias peticiones miran la ventana a la vez, todas ven lugar y
 * todas salen: el tope se pasaría por la misma carrera que evita el script
 * Lua de los cupos de turno.
 */
let turnoDeVentana: Promise<unknown> = Promise.resolve();

function reservarHueco(fase: string): Promise<void> {
  const mio = turnoDeVentana.then(async () => {
    for (;;) {
      const ahora = Date.now();
      emitidas = emitidas.filter((instante) => ahora - instante < VENTANA_MS);

      const tope = topePorMinuto();
      if (emitidas.length < tope) {
        emitidas.push(ahora);
        return;
      }

      const esperaMs = VENTANA_MS - (ahora - emitidas[0]) + MARGEN_MS;
      // La línea que hay que mirar para saber si el throttle está bien
      // calibrado: si aparece seguido, el objetivo está por debajo de lo que
      // el sistema necesita; si no aparece nunca y sigue habiendo 429, el
      // problema no es nuestro ritmo sino el techo del proveedor.
      log.warn("ia_ritmo_al_tope", {
        fase,
        enVentana: emitidas.length,
        tope,
        esperaSegundos: Math.round(esperaMs / 100) / 10,
      });
      await dormir(esperaMs);
    }
  });

  // La cadena no se puede romper: si una reserva falla, la siguiente tiene que
  // poder seguir igual o el ritmo se cierra para siempre.
  turnoDeVentana = mio.catch(() => {});
  return mio;
}

// --- Reintentos --------------------------------------------------------------

function esRateLimit(err: unknown): boolean {
  if (APICallError.isInstance(err)) return err.statusCode === 429;
  // Red de seguridad para el proveedor que envuelve el 429 en otra cosa.
  return /\b429\b|rate limit/i.test(errorText(err));
}

/**
 * Segundos que pide el proveedor, si los pide.
 *
 * Se respeta por encima de nuestro backoff: el proveedor sabe cuándo se le
 * abre la ventana y nosotros solo lo estimamos. El header admite dos formas
 * —segundos o fecha HTTP— y se ven las dos en la práctica.
 */
function retryAfterSegundos(err: unknown): number | null {
  if (!APICallError.isInstance(err)) return null;

  const headers = err.responseHeaders;
  const crudo = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!crudo) return null;

  const segundos = Number(crudo);
  if (Number.isFinite(segundos) && segundos >= 0) return segundos;

  const instante = Date.parse(crudo);
  if (Number.isFinite(instante)) return Math.max(0, (instante - Date.now()) / 1000);

  return null;
}

export interface RitmoOptions {
  /** Qué fase del turno pide la llamada. Solo para los registros. */
  fase: string;
  /**
   * Reintentos ante rate limit.
   *
   * Cero salvo para clasificar. Reintentar la redacción es reintentar el
   * camino que termina en un envío, y sin clave de idempotencia eso arriesga
   * un duplicado (ver turn-delivery.ts). Clasificar no toca al cliente: es
   * seguro repetirlo.
   */
  reintentos?: number;
}

async function conRitmo<T>(options: RitmoOptions, ejecutar: () => PromiseLike<T>): Promise<T> {
  const reintentos = options.reintentos ?? 0;

  for (let intento = 0; ; intento++) {
    try {
      await adquirirCupo();
      try {
        await reservarHueco(options.fase);
        return await ejecutar();
      } finally {
        // Se suelta antes de dormir el backoff: retener el cupo durante la
        // espera dejaría al resto del sistema parado por un turno que ya sabe
        // que va a esperar segundos.
        liberarCupo();
      }
    } catch (err) {
      if (!esRateLimit(err)) throw err;

      if (intento >= reintentos) {
        log.error("ia_rate_limit_agotado", {
          fase: options.fase,
          intentos: intento + 1,
          detail: errorText(err),
        });
        throw err;
      }

      const sugerido = retryAfterSegundos(err);
      const base = Math.min(sugerido ?? BASE_SEGUNDOS * 2 ** intento, TOPE_ESPERA_SEGUNDOS);
      const espera = base + Math.random() * JITTER_SEGUNDOS;

      log.warn("ia_rate_limit", {
        fase: options.fase,
        intento: intento + 1,
        reintentosRestantes: reintentos - intento,
        esperaSegundos: Math.round(espera * 10) / 10,
        segunRetryAfter: sugerido !== null,
      });

      await dormir(espera * 1000);
    }
  }
}

/**
 * Middleware que somete el modelo a los dos frenos.
 *
 * `wrapStream` pasa por el ritmo pero no reintenta: un stream que ya empezó a
 * emitir no se puede repetir sin duplicar lo emitido. Hoy el agente no
 * transmite, así que es una precaución, no un camino en uso.
 */
export function rateLimitMiddleware(options: RitmoOptions): LanguageModelMiddleware {
  return {
    wrapGenerate: ({ doGenerate }) => conRitmo(options, doGenerate),
    wrapStream: ({ doStream }) => conRitmo({ fase: options.fase }, doStream),
  };
}

/**
 * Vacía la ventana y los cupos. Solo para pruebas: sin esto, un archivo de
 * pruebas que emite muchas llamadas deja la ventana llena para el siguiente.
 */
export function resetRitmoParaPruebas(): void {
  emitidas = [];
  enVuelo = 0;
  esperandoCupo.length = 0;
  turnoDeVentana = Promise.resolve();
}
