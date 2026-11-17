import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SeenMarker } from "@/lib/ai/history-line";
import type { TurnLessons } from "@/lib/ai/lessons";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { readSeen } from "@/lib/ai/turn-seen";
import type { BusinessHours } from "@/lib/business-hours";
import { getRedis } from "@/lib/redis";
import { crearEffectsReales, type DepsDeEffectsReales } from "./effects-real";
import type { ResumenDeTurno } from "./tipos";
import { runSeba2Turn, type EntradaDeTurno } from "./turno";

// ---------------------------------------------------------------------------
// Seba v2 atendiendo DE VERDAD (S9b, 17/11/2026): lo llama la costura de
// `agent.ts` dentro del lock de la conversación, en lugar de `runTurnPhases`,
// cuando el modo es `fuera_de_horario` (con la tienda cerrada) o `siempre`.
//
// No decide nada: lee la marca «visto hasta» de Redis, arma los efectos reales
// con lo que v1 le presta (la puerta de envío `deliver` ya cerrada sobre el turno,
// qué hacer si un envío falla, el «escribiendo…» y la bitácora `logTurn`) y corre
// el turno. Todo lo que es de v1 llega inyectado desde `agent.ts`: este archivo
// no lo importa (import circular).
// ---------------------------------------------------------------------------

export interface EntradaDeVivo {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  target: TurnTarget;
  assignedAgentId: string | null;
  businessHours: BusinessHours;
  lessons: TurnLessons;
  cargarHistorial: EntradaDeTurno["cargarHistorial"];
  entregar: DepsDeEffectsReales["entregar"];
  alFallarEnvio: DepsDeEffectsReales["alFallarEnvio"];
  escribiendo: () => void;
  registrarTurno: DepsDeEffectsReales["registrarTurno"];
  /** Inyección para tests. */
  deps?: {
    correrTurno?: typeof runSeba2Turn;
    leerVisto?: (conversationId: string) => Promise<SeenMarker | null>;
    redisDisponible?: boolean;
    ahora?: () => Date;
  };
}

/** ¿Hay Redis configurado? `getRedis` LANZA sin `REDIS_URL`. */
function hayRedis(): boolean {
  try {
    getRedis();
    return true;
  } catch {
    return false;
  }
}

/**
 * Corre Seba v2 en vivo. Lanza lo que lance el turno: quien llama (el try/catch de
 * v1 alrededor del turno) decide entre reintento y traspaso `entrega_fallida`.
 */
export async function correrSeba2EnVivo(entrada: EntradaDeVivo): Promise<ResumenDeTurno> {
  const { supabase, conversationId } = entrada;
  const correrTurno = entrada.deps?.correrTurno ?? runSeba2Turn;
  const ahora = entrada.deps?.ahora ?? (() => new Date());

  const redisDisponible = entrada.deps?.redisDisponible ?? hayRedis();
  // Sin Redis no hay marca «visto hasta»: el turno trata todo lo del cliente como pendiente.
  const visto = redisDisponible ? await (entrada.deps?.leerVisto ?? readSeen)(conversationId) : null;

  const effects = crearEffectsReales({
    supabase,
    conversationId,
    contactId: entrada.contactId,
    target: entrada.target,
    businessHours: entrada.businessHours,
    ahora,
    assignedAgentId: entrada.assignedAgentId,
    entregar: entrada.entregar,
    alFallarEnvio: entrada.alFallarEnvio,
    escribiendo: entrada.escribiendo,
    registrarTurno: entrada.registrarTurno,
    visto,
    redisDisponible,
  });

  return correrTurno(
    {
      supabase,
      conversationId,
      ahora: ahora(),
      iaGlobal: true,
      visto,
      persistencia: "normal",
      cargarHistorial: entrada.cargarHistorial,
      precargado: { lessons: entrada.lessons, businessHours: entrada.businessHours },
    },
    effects
  );
}
