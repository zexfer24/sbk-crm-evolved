import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { TurnLessons } from "@/lib/ai/lessons";
import { conTelemetriaDeTurno } from "@/lib/ai/turn-telemetry";
import type { BusinessHours } from "@/lib/business-hours";
import { errorText, log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { crearEffectsDeSombra, leerVistoDeSombra } from "./effects-sombra";
import { runSeba2Turn, type EntradaDeTurno } from "./turno";

// ---------------------------------------------------------------------------
// El turno de Seba v2 «sin enviar» que dispara la costura de `agent.ts` (S9b,
// 17/11/2026). En modo `sombra` o `copiloto`, además del camino de siempre de v1
// (o de la IA global apagada), v2 redacta el mismo turno y guarda su borrador en
// `agent_shadow_drafts` — para medirlo o para que el asesor lo vea como sugerencia.
//
// REGLA DURA: esto NUNCA puede afectar el turno de v1. `correrSombra` no lanza ni
// rechaza jamás (cualquier fallo queda en `log.warn("sombra_fallo")`) y corre en su
// propio registro de telemetría: sus llamadas al proveedor no se mezclan con las de
// v1 (que `logTurn` vuelca a `agent_turn_calls` con el `turn_id` de v1).
// ---------------------------------------------------------------------------

/** Cuánto vive el candado de un turno de sombra: el anti-duplicado de los reintentos inmediatos. */
export const SOMBRA_LOCK_SEGUNDOS = 90;

/**
 * Cuánto espera `runAgentTurn` a que la sombra termine antes de salir sin ella
 * (`agent.ts`). Un proveedor colgado no puede dejar un turno de v1 sin cerrar.
 */
export const SOMBRA_ESPERA_MAX_MS = 60_000;

/** Lo único que la sombra le pide a Redis: el `SET … EX … NX` del candado y, para liberarlo, `get` y `del`. */
interface RedisDeCandado {
  set(key: string, value: string, ex: "EX", segundos: number, nx: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** Un candado tomado: lo que hace falta para liberarlo solo si sigue siendo el propio. */
interface CandadoTomado {
  redis: RedisDeCandado;
  clave: string;
  valor: string;
}

export interface EntradaDeSombra {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  modo: "sombra" | "copiloto";
  /** `agent_can_run()`: solo para el registro del borrador (`contexto.ia_global`). */
  iaGlobal: boolean;
  asesorAsignado: boolean;
  businessHours: BusinessHours;
  lessons: TurnLessons;
  cargarHistorial: EntradaDeTurno["cargarHistorial"];
  /** Inyección para tests. */
  deps?: {
    correrTurno?: typeof runSeba2Turn;
    redis?: () => RedisDeCandado | null;
    ahora?: () => Date;
  };
}

/**
 * Toma el candado `sombra:<conversationId>` (`SET … NX EX 90`) con un valor aleatorio PROPIO. Devuelve:
 *   - un `CandadoTomado` si lo ganó (hay que liberarlo al terminar),
 *   - `"sin_candado"` si no había Redis o falló (corre igual, sin candado: peor un borrador duplicado que ninguno),
 *   - `false` solo si otro disparo del mismo turno ya lo tiene.
 * Se libera al terminar (`liberarCandado`); el vencimiento de 90 s es solo la red de seguridad si el proceso muere
 * a mitad del turno.
 */
async function tomarCandado(entrada: EntradaDeSombra): Promise<CandadoTomado | "sin_candado" | false> {
  const { conversationId } = entrada;
  let redis: RedisDeCandado | null;
  try {
    redis = entrada.deps?.redis ? entrada.deps.redis() : getRedis();
  } catch (err) {
    // `getRedis` LANZA sin `REDIS_URL`.
    log.warn("sombra_sin_candado", { conversationId, detail: errorText(err) });
    return "sin_candado";
  }
  if (!redis) {
    log.warn("sombra_sin_candado", { conversationId, detail: "sin Redis" });
    return "sin_candado";
  }

  const clave = `sombra:${conversationId}`;
  const valor = randomUUID();
  try {
    const puesto = await redis.set(clave, valor, "EX", SOMBRA_LOCK_SEGUNDOS, "NX");
    if (puesto === "OK") return { redis, clave, valor };
    log.info("sombra_ya_en_curso", { conversationId });
    return false;
  } catch (err) {
    log.warn("sombra_sin_candado", { conversationId, detail: errorText(err) });
    return "sin_candado";
  }
}

/**
 * Libera el candado al terminar el turno, y solo si el valor sigue siendo el propio: si venció a los 90 s y otro
 * disparo tomó el suyo mientras este turno seguía corriendo, no se le borra. NUNCA lanza: un candado que no se pudo
 * liberar vence solo a los 90 s.
 *
 * Caso real (R1/C2, 17/11/2026): el candado no se liberaba y un cliente que escribía «hola» y 30 s después su
 * pregunta real veía el segundo turno salir por `sombra_ya_en_curso`: esa pregunta no dejaba borrador. La
 * comprobación `get` + `del` no es atómica (un disparo podría tomar el candado entre las dos); la ventana es de
 * milisegundos y el peor caso es borrar el candado de otro turno, que a lo sumo deja correr un disparo repetido.
 */
async function liberarCandado(candado: CandadoTomado, conversationId: string): Promise<void> {
  try {
    const actual = await candado.redis.get(candado.clave);
    if (actual === candado.valor) await candado.redis.del(candado.clave);
  } catch (err) {
    log.warn("sombra_candado_no_liberado", { conversationId, detail: errorText(err) });
  }
}

/** Corre el turno sin enviar. NUNCA lanza ni rechaza: cualquier fallo queda en `log.warn("sombra_fallo")`. */
export async function correrSombra(entrada: EntradaDeSombra): Promise<void> {
  const { supabase, conversationId, modo } = entrada;
  let candado: CandadoTomado | null = null;
  try {
    const tomado = await tomarCandado(entrada);
    if (tomado === false) return;
    if (tomado !== "sin_candado") candado = tomado;

    const correrTurno = entrada.deps?.correrTurno ?? runSeba2Turn;
    const ahora = entrada.deps?.ahora ?? (() => new Date());
    const inicio = Date.now();

    // Su propio registro de telemetría: dentro de `runAgentTurn` ya hay uno abierto
    // (el de v1) y sin este las llamadas de la sombra se colarían en el `turn_id` de v1.
    const resumen = await conTelemetriaDeTurno(async () => {
      const visto = await leerVistoDeSombra(supabase, conversationId, modo);
      const effects = crearEffectsDeSombra({
        supabase,
        conversationId,
        modo,
        businessHours: entrada.businessHours,
        ahora,
        asesorAsignado: entrada.asesorAsignado,
      });
      return correrTurno(
        {
          supabase,
          conversationId,
          ahora: ahora(),
          iaGlobal: entrada.iaGlobal,
          visto,
          persistencia: "sombra",
          cargarHistorial: entrada.cargarHistorial,
          precargado: { lessons: entrada.lessons, businessHours: entrada.businessHours },
        },
        effects
      );
    });

    log.info("sombra_turno", { conversationId, modo, accion: resumen.accion, duracionMs: Date.now() - inicio });
  } catch (err) {
    log.warn("sombra_fallo", { conversationId, modo, detail: errorText(err) });
  } finally {
    // También si el turno lanzó: un candado de un turno que ya terminó solo estorba al siguiente (R1/C2).
    if (candado) await liberarCandado(candado, conversationId);
  }
}
