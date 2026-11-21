import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BcvEstadoLectura } from "@/lib/bcv-alerta";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Estado de la lectura del BCV: cada intento REAL a bcv.org.ve deja su
// resultado en `bcv_fetch_status` (una sola fila, migración
// 20261121010000), para que el CRM pueda decir "la tasa lleva N horas sin
// actualizarse" en vez de esperar a que alguien lea el log. Nació del
// incidente del 19/11/2026: cada lectura falló dos días sin que nadie lo
// notara, porque el único aviso era un `console.error` por minuto.
//
// EL CÓDIGO SE DESPLIEGA ANTES QUE LA MIGRACIÓN: si la tabla o la RPC todavía
// no existen, la tasa se sigue leyendo exactamente igual y solo se pierde el
// estado. Por eso NADA de este archivo lanza, y el aviso de "no disponible"
// sale una sola vez por proceso (no una vez por minuto, que es justo el ruido
// que este plan viene a quitar).
// ---------------------------------------------------------------------------

export interface ResultadoRegistro {
  /** Fallos seguidos DESPUÉS de este intento (0 si fue un éxito). */
  fallosSeguidos: number;
  /** Fallos seguidos que había ANTES de este intento. */
  fallosPrevios: number;
  /** Último error guardado ANTES de este intento. */
  errorPrevio: string | null;
}

let avisoNoDisponibleEmitido = false;

function avisarNoDisponibleUnaVez(detail: string): void {
  if (avisoNoDisponibleEmitido) return;
  avisoNoDisponibleEmitido = true;
  log.warn("bcv_estado_no_disponible", { detail });
}

/** Solo para tests: el "una vez por proceso" es una variable de módulo. */
export function resetBcvStatusForTests(): void {
  avisoNoDisponibleEmitido = false;
}

interface FilaRegistro {
  consecutive_failures: number;
  previous_failures: number;
  previous_error: string | null;
}

/**
 * Anota el resultado de un intento real contra bcv.org.ve. Usa el cliente
 * admin (la escritura es solo de service_role) sin importar con qué cliente
 * llegó `getBcvRate`: la bandeja llama con la sesión de un asesor, que no
 * puede escribir ahí.
 *
 * Nunca lanza: ante cualquier error (tabla/RPC inexistente, red) devuelve
 * `null` y `getBcvRate` cae a su contador en memoria.
 */
export async function registrarIntentoBcv(ok: boolean, error: string | null): Promise<ResultadoRegistro | null> {
  try {
    const admin = createAdminClient();
    // La RPC la crea la migración 20261121010000: sin ella, esto da error y
    // se cae al contador en memoria (el código llega antes que la migración).
    const { data, error: rpcError } = await admin.rpc("bcv_registrar_intento", {
      p_ok: ok,
      p_error: error ?? undefined,
    });

    if (rpcError) {
      avisarNoDisponibleUnaVez(errorText(rpcError));
      return null;
    }

    const fila = (Array.isArray(data) ? data[0] : data) as FilaRegistro | null | undefined;
    if (!fila) {
      avisarNoDisponibleUnaVez("bcv_registrar_intento no devolvió ninguna fila");
      return null;
    }

    return {
      fallosSeguidos: Number(fila.consecutive_failures),
      fallosPrevios: Number(fila.previous_failures),
      errorPrevio: fila.previous_error ?? null,
    };
  } catch (err) {
    avisarNoDisponibleUnaVez(errorText(err));
    return null;
  }
}

interface FilaEstado {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

/**
 * Lee la fila única de `bcv_fetch_status` con el cliente que le pasen (RLS de
 * lectura: agentes y caja). `null` si no hay fila o si algo falla — sin log
 * ruidoso: a lo sumo el mismo aviso único por proceso.
 */
export async function leerEstadoBcv(supabase: SupabaseClient<Database>): Promise<BcvEstadoLectura | null> {
  try {
    const { data, error } = await supabase
      .from("bcv_fetch_status")
      .select("last_attempt_at, last_success_at, last_failure_at, last_error, consecutive_failures")
      .maybeSingle();

    if (error) {
      avisarNoDisponibleUnaVez(errorText(error));
      return null;
    }
    if (!data) return null;

    const fila = data as FilaEstado;
    return {
      lastAttemptAt: fila.last_attempt_at ?? null,
      lastSuccessAt: fila.last_success_at ?? null,
      lastFailureAt: fila.last_failure_at ?? null,
      lastError: fila.last_error ?? null,
      consecutiveFailures: Number(fila.consecutive_failures ?? 0),
    };
  } catch (err) {
    avisarNoDisponibleUnaVez(errorText(err));
    return null;
  }
}
