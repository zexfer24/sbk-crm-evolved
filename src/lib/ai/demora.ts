import {
  businessMinutesBetween,
  businessStatus,
  type BusinessHours,
} from "@/lib/business-hours";

// ---------------------------------------------------------------------------
// "Nadie sin atender" (T10b-1, Entrega B del plan "Seba encuentra y el mostrador
// no deja esperando", 29/9/2026): la decisión PURA de qué hacer con una
// conversación cuyo cliente lleva esperando a una persona. Sin Supabase, sin
// Redis, sin reloj real: recibe el estado ya leído y `now`, devuelve UNA acción.
// Quien arma el estado (la ruta de cron) y quien la ejecuta (`delay-turn.ts`,
// `claimNextAvailableAgent`) viven aparte a propósito, para poder probar el
// reloj con fechas fijas.
//
// Hay DOS orígenes de episodio y gana el más reciente. La razón es una
// medición en producción (3 días, 283 escaladas): 201 quedaron sin mensaje del
// asesor a los 15 min y en 62 de ellas el cliente no volvió a escribir. La
// despedida de Seba al escalar mueve `last_reply_at` y suele dejar
// `awaiting_reply` en false, así que un reloj atado SOLO al "último mensaje del
// cliente sin respuesta" jamás arrancaría para esas conversaciones:
//
//   1. "escalada": el último traspaso que cambia de manos es `escalada` /
//      `escalada_sin_asesor` (o una cadena de `reasignada_por_demora` que nace
//      de una de ellas) y ningún asesor escribió desde entonces. El episodio es
//      el `created_at` del traspaso ORIGINAL, sin importar `awaiting_reply`.
//   2. "cliente": mensaje del cliente sin respuesta real (`awaiting_reply`,
//      conversación abierta, ventana de 24 h, ráfaga que no es solo cortesía,
//      ningún asesor escribió después). El episodio es `last_customer_message_at`.
//
// `reasignada_por_demora` NO abre un episodio nuevo: continúa el de la
// escalada original (mismo `episode_at`). Si abriera uno, cada reasignación
// reiniciaría el contador en cero, el tope de dos no llegaría nunca y la
// conversación rotaría entre asesores cada 15 min sin fin (segunda corrección
// del operador; la mutación (h) del plan lo verifica).
// ---------------------------------------------------------------------------

/** A los 10 min sin atender, Seba responde una sola vez por episodio. */
export const MINUTOS_PARA_RESPONDER = 10;
/** A los 15 min (de horario laboral) sin atender, se reasigna. */
export const MINUTOS_PARA_REASIGNAR = 15;
/** D3: como máximo dos reasignaciones por episodio; después se avisa al supervisor. */
export const TOPE_REASIGNACIONES = 2;

const MS_POR_MINUTO = 60_000;

export type OrigenEpisodio = "escalada" | "cliente";

export type AccionDemora = "nada" | "responder" | "reasignar" | "avisar_supervisor";

/**
 * Una fila de `conversation_handoffs`. El llamador pasa SOLO las que cambian de
 * manos, con el mismo filtro que `escalationOpen` (`handoffs.ts`): sin las
 * razones de `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`. `reasignada_por_demora` NO
 * está en esa lista (continúa la escalada) y `demora_sin_asesor` SÍ.
 */
export interface TraspasoDemora {
  reason: string;
  createdAt: Date;
}

/** Una fila de `conversation_delay_episodes` (el candado de idempotencia). */
export interface EpisodioGuardado {
  episodeAt: Date;
  origen: OrigenEpisodio;
  respondedAt: Date | null;
  reassignments: number;
  agentesPrevios: string[];
  ultimaReasignacionAt: Date | null;
  supervisorNotifiedAt: Date | null;
}

export interface EstadoDemora {
  /** `agent_settings.demora_activa`. */
  demoraActiva: boolean;
  /** `agent_settings.demora_activa_desde`. Encendida sin fecha = falla cerrado. */
  demoraActivaDesde: Date | null;
  /** `status <> 'closed'`. */
  abierta: boolean;
  awaitingReply: boolean;
  /** Ventana de 24 h de WhatsApp abierta (la misma que decide el composer). */
  ventanaAbierta: boolean;
  /**
   * La ráfaga final del cliente es solo cortesía/sticker (`isCourtesyOnly`,
   * `customerBurst`). La calcula quien arma el estado: este módulo es puro y no
   * conoce el texto de los mensajes.
   */
  rafagaSoloCortesia: boolean;
  asesorAsignadoId: string | null;
  lastCustomerMessageAt: Date | null;
  /** Última salida visible al cliente, de Seba o de un asesor (despedida incluida). */
  ultimaSalidaAt: Date | null;
  /** Último mensaje REAL de un asesor (saliente, `sender_type = 'agent'`, sin notas internas). */
  ultimoMensajeAsesorAt: Date | null;
  traspasos: TraspasoDemora[];
  /** Filas de la conversación en `conversation_delay_episodes` (las que haya; no hace falta filtrar). */
  episodios: EpisodioGuardado[];
}

export interface ResultadoDemora {
  accion: AccionDemora;
  /** Episodio evaluado (la clave `(conversation_id, episode_at)` de la fila candado). Ausente si no hay episodio. */
  episodio?: { origen: OrigenEpisodio; episodeAt: Date };
  /** Minutos enteros de espera: para `responder`, desde el mensaje que Seba contesta; para el resto, desde `episodeAt`. */
  esperaMinutos?: number;
  /** Solo con `reasignar`: asesor actual + los que ya rotaron en el episodio (D4). */
  excluir?: string[];
  /** Reasignaciones ya hechas en el episodio. */
  reasignaciones?: number;
  /** Motivo corto, para el log. */
  razon: string;
}

const RAZONES_ESCALADA = new Set(["escalada", "escalada_sin_asesor"]);
const RAZON_REASIGNADA = "reasignada_por_demora";

/**
 * `created_at` del traspaso ORIGINAL de la escalada abierta, o `null` si el
 * último traspaso que cambia de manos no es una escalada. Una cadena de
 * `reasignada_por_demora` se atraviesa hasta la escalada que la originó.
 */
function fechaDeLaEscalada(traspasos: readonly TraspasoDemora[]): Date | null {
  const ordenados = [...traspasos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let i = 0;
  while (i < ordenados.length && ordenados[i].reason === RAZON_REASIGNADA) i++;
  const raiz = ordenados[i];
  if (!raiz || !RAZONES_ESCALADA.has(raiz.reason)) return null;
  return raiz.createdAt;
}

function nada(razon: string, extra: Partial<ResultadoDemora> = {}): ResultadoDemora {
  return { accion: "nada", razon, ...extra };
}

/**
 * Decide qué hacer AHORA con una conversación. Una sola acción por llamada; el
 * llamador la ejecuta, actualiza la fila de `conversation_delay_episodes` y la
 * vuelve a evaluar en la siguiente pasada.
 *
 * Precedencia entre acciones: a los 15 min de horario laboral gana reasignar
 * (o avisar al supervisor) sobre responder — el asesor nuevo es lo que el
 * cliente necesita, y así una respuesta que no pudo salir no traba la rotación.
 * Fuera de horario no hay reasignación, así que Seba responde (y su texto
 * nombra la próxima apertura).
 */
export function evaluarDemora(estado: EstadoDemora, now: Date, businessHours: BusinessHours): ResultadoDemora {
  if (!estado.demoraActiva) return nada("demora_apagada");
  // Encendida sin fecha de encendido: sin corte no hay forma de distinguir el
  // backlog de lo nuevo, y encender de golpe la demora sobre cientos de chats
  // viejos es justo lo que `demora_activa_desde` evita. Falla cerrado.
  const desde = estado.demoraActivaDesde;
  if (!desde) return nada("demora_sin_fecha_de_encendido");
  if (!estado.abierta) return nada("conversacion_cerrada");

  const asesorAt = estado.ultimoMensajeAsesorAt;
  const lcma = estado.lastCustomerMessageAt;
  const posteriorAlEncendido = (fecha: Date) => fecha.getTime() > desde.getTime();

  // Origen 1: escalada abierta, sin mensaje de asesor desde ella.
  const escaladaAt = fechaDeLaEscalada(estado.traspasos);
  const escaladaAbierta = escaladaAt !== null && !(asesorAt && asesorAt.getTime() > escaladaAt.getTime());
  const origen1 = escaladaAbierta && posteriorAlEncendido(escaladaAt) ? escaladaAt : null;

  // Origen 2: mensaje del cliente sin respuesta real.
  const origen2 =
    lcma !== null &&
    estado.awaitingReply &&
    estado.ventanaAbierta &&
    !estado.rafagaSoloCortesia &&
    posteriorAlEncendido(lcma) &&
    !(asesorAt && asesorAt.getTime() > lcma.getTime())
      ? lcma
      : null;

  if (!origen1 && !origen2) return nada("sin_episodio");

  // Gana el más reciente; en un empate exacto, la escalada.
  const gana2 = origen2 !== null && (origen1 === null || origen2.getTime() > origen1.getTime());
  const origen: OrigenEpisodio = gana2 ? "cliente" : "escalada";
  const episodeAt = (gana2 ? origen2 : origen1) as Date;
  const episodio = { origen, episodeAt };

  const fila = estado.episodios.find((e) => e.episodeAt.getTime() === episodeAt.getTime());
  const reasignaciones = fila?.reassignments ?? 0;

  // Desde qué instante corren los 10 min de Seba. En el origen "cliente" es el
  // mensaje mismo. En el origen "escalada" Seba ya respondió al escalar: solo
  // vuelve a hablar si el cliente escribió algo NUEVO después de esa respuesta
  // (y de la escalada), y entonces los 10 min cuentan desde ese mensaje. Un
  // "ok"/"gracias"/sticker no cuenta como mensaje nuevo.
  let relojResponder: Date | null = null;
  if (origen === "cliente") {
    relojResponder = episodeAt;
  } else if (
    lcma !== null &&
    lcma.getTime() > episodeAt.getTime() &&
    (estado.ultimaSalidaAt === null || lcma.getTime() > estado.ultimaSalidaAt.getTime()) &&
    !estado.rafagaSoloCortesia
  ) {
    relojResponder = lcma;
  }

  const puedeResponder =
    relojResponder !== null &&
    estado.ventanaAbierta &&
    !fila?.respondedAt &&
    now.getTime() - relojResponder.getTime() >= MINUTOS_PARA_RESPONDER * MS_POR_MINUTO;

  // A los 15 min, solo en horario laboral, y solo si hay a quién rotar: un
  // asesor asignado o una escalada abierta que sigue sin dueño. Los 15 min son
  // de HORARIO (`businessMinutesBetween`): una escalada de las 17:50 no cumple
  // sus 15 min a las 8:00 del día siguiente por haber dormido 14 horas de
  // pared — el asesor tiene que tener 15 minutos de tienda abierta para
  // atenderla, o el tope de dos se gastaría en la primera hora de la mañana.
  const puedeRotar = estado.asesorAsignadoId !== null || escaladaAbierta;
  const relojRotacion = fila?.ultimaReasignacionAt ?? episodeAt;
  const enHorario = businessStatus(now, businessHours).open;
  const cumplioRotacion =
    puedeRotar &&
    enHorario &&
    cumplioMinutosDeHorario(relojRotacion, now, businessHours, MINUTOS_PARA_REASIGNAR);

  if (cumplioRotacion) {
    if (reasignaciones < TOPE_REASIGNACIONES) {
      const excluir = [
        ...new Set([...(fila?.agentesPrevios ?? []), ...(estado.asesorAsignadoId ? [estado.asesorAsignadoId] : [])]),
      ];
      return {
        accion: "reasignar",
        episodio,
        esperaMinutos: minutosEnteros(now, episodeAt),
        excluir,
        reasignaciones,
        razon: "quince_minutos_sin_asesor",
      };
    }
    if (!fila?.supervisorNotifiedAt) {
      return {
        accion: "avisar_supervisor",
        episodio,
        esperaMinutos: minutosEnteros(now, episodeAt),
        reasignaciones,
        razon: "tope_de_reasignaciones",
      };
    }
    // Tope alcanzado y supervisor ya avisado: no se rota más. Seba todavía
    // puede responder si nunca lo hizo.
  }

  if (puedeResponder && relojResponder) {
    return {
      accion: "responder",
      episodio,
      esperaMinutos: minutosEnteros(now, relojResponder),
      reasignaciones,
      razon: "diez_minutos_sin_respuesta",
    };
  }

  return nada("esperando", { episodio, reasignaciones });
}

/**
 * `businessMinutesBetween` redondea al minuto más cercano: 14 min 59 s salen
 * como 15 y adelantarían la reasignación un segundo. Restarle 30 s a `hasta`
 * vuelve exacto el umbral (round(x − 0,5) >= n  <=>  x >= n) sin reescribir la
 * función compartida con el tablero de atascados.
 */
function cumplioMinutosDeHorario(desde: Date, hasta: Date, hours: BusinessHours, minutos: number): boolean {
  return businessMinutesBetween(desde, new Date(hasta.getTime() - MS_POR_MINUTO / 2), hours) >= minutos;
}

function minutosEnteros(now: Date, desde: Date): number {
  return Math.floor((now.getTime() - desde.getTime()) / MS_POR_MINUTO);
}
