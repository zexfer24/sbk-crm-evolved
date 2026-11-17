import type { SebaV2Mode } from "@/lib/seba-v2-config";

// ---------------------------------------------------------------------------
// La decisión de versión de la costura entre Seba v1 y Seba v2 (S9a, entrega 3
// del rework de Seba, 17/11/2026). Módulo PURO: sin imports de servidor, sin
// Supabase, sin reloj, sin azar -- recibe los hechos ya consultados y devuelve
// qué versión atiende el turno EN VIVO (la que le escribe al cliente) y si
// además corre otra «sin enviar» (la sombra/copiloto de v2: redacta, guarda el
// borrador y no manda nada).
//
// Dos preguntas distintas a propósito: «quién habla» (`vivo`) y «quién mira»
// (`sinEnviar`). En `sombra` y `copiloto` quien habla sigue siendo v1 -- o
// nadie, con la IA global apagada, que es el estado de producción el 17/11 --
// y v2 redacta en paralelo sobre una muestra de conversaciones. De ahí que
// `shadow_can_run()` (otro interruptor, otro tope de gasto) sea independiente
// de `agent_can_run()`.
// ---------------------------------------------------------------------------

export interface EntradaDeVersion {
  modo: SebaV2Mode;
  /** `agent_can_run()`: interruptor global de la IA y tope de gasto de v1. */
  canRun: boolean;
  /** `shadow_can_run()`: modo sombra/copiloto y gasto de la sombra bajo su tope. */
  shadowCanRun: boolean;
  tiendaAbierta: boolean;
  /** 0-99, estable por conversación y día (`muestraDeConversacion`). */
  muestra: number;
  /** `agent_settings.shadow_sample_pct`, 0-100. */
  samplePct: number;
}

export interface DecisionDeVersion {
  /** Quién le escribe al cliente. `ninguno`: la IA no puede correr. */
  vivo: "v1" | "v2" | "ninguno";
  /** Si además corre v2 sin enviar, y con qué etiqueta guarda su borrador. */
  sinEnviar: "sombra" | "copiloto" | null;
}

export function decidirVersion(i: EntradaDeVersion): DecisionDeVersion {
  // Como `apagado`: el comportamiento de hoy, v1 o nadie.
  const comoApagado: DecisionDeVersion["vivo"] = i.canRun ? "v1" : "ninguno";

  switch (i.modo) {
    case "sombra":
    case "copiloto": {
      // `<` y no `<=`: con `samplePct` = 0 NADIE entra (muestra 0 incluido) y
      // con 100 entran todas (la muestra máxima es 99).
      const entra = i.shadowCanRun && i.muestra < i.samplePct;
      return { vivo: comoApagado, sinEnviar: entra ? i.modo : null };
    }
    case "fuera_de_horario":
      return { vivo: i.canRun && !i.tiendaAbierta ? "v2" : comoApagado, sinEnviar: null };
    case "siempre":
      return { vivo: i.canRun ? "v2" : "ninguno", sinEnviar: null };
    case "apagado":
    default:
      // Un modo desconocido (una cadena rara que llegue de la base) cae acá a
      // propósito: ante la duda, lo que ya corría.
      return { vivo: comoApagado, sinEnviar: null };
  }
}

/**
 * 0-99 determinista a partir del id de la conversación y el día de Caracas
 * («YYYY-MM-DD»): FNV-1a de 32 bits sobre `id|dia`, módulo 100. Sin
 * `Math.random` y sin `Date`: el mismo cliente cae en la misma muestra todo
 * el día (la sombra no entra y sale a mitad de una conversación) y al día
 * siguiente se re-sortea, para que no sea siempre la misma gente.
 */
export function muestraDeConversacion(conversationId: string, dia: string): number {
  const texto = `${conversationId}|${dia}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    hash ^= texto.charCodeAt(i);
    // 16777619 = 0x01000193, el primo de FNV; `Math.imul` mantiene los 32 bits.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}
