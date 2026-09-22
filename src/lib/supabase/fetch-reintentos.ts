import "server-only";
import { log, errorText } from "@/lib/log";
import {
  esFalloTransitorioDeBase,
  esReintentoSeguro,
  STATUS_HTTP_TRANSITORIOS,
  type RespuestaDeBase,
} from "@/lib/supabase/errores-base";

// ---------------------------------------------------------------------------
// El `fetch` con el que `createAdminClient()` envuelve a PostgREST/Storage/
// RPC (T1, plan "Nada se pierde en un corte ni en un deploy", 21-22/9/2026).
//
// `errores-base.ts` decide QUÉ es transitorio y CUÁNDO es seguro reintentar;
// acá se decide QUÉ HACER con eso: leer el cuerpo sin consumirlo (el
// llamador real, supabase-js, todavía tiene que poder parsear la respuesta),
// esperar, reintentar, respetar un `signal` ya abortado y dejar rastro con
// `lib/log.ts` en cada reintento y al rendirse. El llamador (cualquier
// método de supabase-js) sigue viendo exactamente lo que vería sin esto: una
// `Response` o una excepción — nunca un tipo nuevo.
// ---------------------------------------------------------------------------

type FetchLike = typeof fetch;

export interface OpcionesReintento {
  /**
   * Cuántos REINTENTOS admite, sin contar el intento inicial. Con el valor
   * por defecto (2) hay hasta 3 llamadas totales a `fetchBase`.
   */
  intentos?: number;
  /**
   * Milisegundos de espera antes de cada reintento, en orden (el índice 0 es
   * la espera antes del segundo intento). Si hay más reintentos que
   * entradas, se repite la última.
   */
  esperasMs?: number[];
  /** Inyectable para tests: evita esperar de verdad. */
  dormir?: (ms: number) => Promise<void>;
}

const INTENTOS_POR_DEFECTO = 2;
const ESPERAS_MS_POR_DEFECTO = [300, 1000];

function dormirReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * El método viaja en `init.method` (forma más común al llamar `fetch`) o,
 * si `input` es un `Request`, en `input.method` — supabase-js/storage-js
 * pueden llamar de cualquiera de las dos formas. Sin ninguno, `fetch` asume
 * `GET`, así que acá también.
 */
function metodoDe(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof Request !== "undefined" && input instanceof Request) return input.method;
  return "GET";
}

function esperaParaElIntento(esperasMs: number[], numeroDeReintento: number): number {
  const indice = numeroDeReintento - 1;
  if (indice < esperasMs.length) return esperasMs[indice];
  return esperasMs[esperasMs.length - 1] ?? 0;
}

/** Recorta el cuerpo antes de meterlo en un log: no hace falta el JSON
 * entero de un error de Envoy/PostgREST para diagnosticar, y un cuerpo
 * larguísimo no debería inflar cada línea de log. */
function detalleDeRespuesta(status: number, cuerpo: string): string {
  const recortado = cuerpo.length > 200 ? `${cuerpo.slice(0, 200)}…` : cuerpo;
  return `${status} ${recortado}`;
}

/**
 * Envuelve `fetchBase` (el `fetch` global de verdad) con reintentos cortos
 * para cortes transitorios de la base. Pensado para pasarlo como
 * `global.fetch` a `createClient` de supabase-js: cubre PostgREST, las RPC y
 * Storage (storage-js usa el mismo `fetch`) sin que ningún llamador tenga
 * que saber que existe.
 */
export function fetchConReintentos(fetchBase: FetchLike, opciones: OpcionesReintento = {}): FetchLike {
  const intentos = opciones.intentos ?? INTENTOS_POR_DEFECTO;
  const esperasMs = opciones.esperasMs ?? ESPERAS_MS_POR_DEFECTO;
  const dormir = opciones.dormir ?? dormirReal;
  const totalDeIntentos = 1 + intentos;

  return async function fetchConReintentosImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const metodo = metodoDe(input, init);

    for (let numeroDeIntento = 1; numeroDeIntento <= totalDeIntentos; numeroDeIntento++) {
      const esUltimoIntento = numeroDeIntento === totalDeIntentos;

      let respuesta: Response;
      try {
        respuesta = await fetchBase(input, init);
      } catch (err) {
        // El llamador canceló a propósito: no es un fallo de la base, no se
        // reintenta ni se loguea, se relanza tal cual.
        if (init?.signal?.aborted) throw err;

        if (!esFalloTransitorioDeBase(err)) throw err;

        if (!esUltimoIntento && esReintentoSeguro(metodo, err)) {
          log.warn("base_reintento", { intento: numeroDeIntento, metodo, detail: errorText(err) });
          await dormir(esperaParaElIntento(esperasMs, numeroDeIntento));
          continue;
        }

        log.error("base_agotada", {
          metodo,
          reintentado: numeroDeIntento > 1,
          detail: errorText(err),
        });
        throw err;
      }

      // Camino rápido: la enorme mayoría de las respuestas no son un corte
      // de la base, y leer el cuerpo (aunque sea con `clone()`) tiene un
      // costo que no vale la pena pagar salvo en los tres status que
      // pueden serlo.
      if (!STATUS_HTTP_TRANSITORIOS.includes(respuesta.status)) return respuesta;

      if (init?.signal?.aborted) return respuesta;

      // `clone()` ANTES de leer: el llamador real (supabase-js) todavía
      // necesita poder leer este mismo cuerpo si no reintentamos.
      const cuerpo = await respuesta
        .clone()
        .text()
        .catch(() => "");
      const fallo: RespuestaDeBase = { status: respuesta.status, cuerpo };

      if (!esFalloTransitorioDeBase(fallo)) return respuesta;

      if (!esUltimoIntento && esReintentoSeguro(metodo, fallo)) {
        log.warn("base_reintento", {
          intento: numeroDeIntento,
          metodo,
          detail: detalleDeRespuesta(fallo.status, fallo.cuerpo),
        });
        await dormir(esperaParaElIntento(esperasMs, numeroDeIntento));
        continue;
      }

      log.error("base_agotada", {
        metodo,
        reintentado: numeroDeIntento > 1,
        detail: detalleDeRespuesta(fallo.status, fallo.cuerpo),
      });
      return respuesta;
    }

    // Inalcanzable: el bucle siempre `return`/`throw` en su última vuelta
    // (numeroDeIntento === totalDeIntentos ⇒ esUltimoIntento ⇒ no hay
    // `continue`). TypeScript no lo sabe sin esto.
    throw new Error("fetchConReintentos: se agotó el bucle sin resolver (no debería pasar)");
  };
}
