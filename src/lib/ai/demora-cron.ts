import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseBusinessHours } from "@/lib/business-hours";
import { errorText, log } from "@/lib/log";
import { isComposerWindowOpen } from "@/lib/whatsapp-window";
import { claimNextAvailableAgent } from "@/lib/ai/claim-agent";
import {
  evaluarDemora,
  MINUTOS_PARA_REASIGNAR,
  MINUTOS_PARA_RESPONDER,
  TOPE_REASIGNACIONES,
  type EpisodioGuardado,
  type EstadoDemora,
  type OrigenEpisodio,
  type ResultadoDemora,
  type TraspasoDemora,
} from "@/lib/ai/demora";
import { runDelayTurn } from "@/lib/ai/delay-turn";
import { RAZONES_QUE_NO_CIERRAN_LA_ESCALADA, recordHandoff } from "@/lib/ai/handoffs";
import { customerBurst, historyLine } from "@/lib/ai/history-line";
import { isCourtesyOnly } from "@/lib/ai/saludo";

// ---------------------------------------------------------------------------
// "Nadie sin atender" (T10b-4, Entrega B del plan "Seba encuentra y el mostrador
// no deja esperando", 29/9/2026): la pasada del cron de demora. Lee lo que hace
// falta de la base, arma el `EstadoDemora` de cada candidata, le pregunta a
// `evaluarDemora` (puro) qué toca y EJECUTA esa acción con un candado de
// idempotencia en `conversation_delay_episodes`.
//
// Por qué el candado vive en la base y no en Redis: el cron corre cada minuto
// desde el contenedor de cron, pero un deploy o un reintento pueden solapar dos
// pasadas, y lo que se evita (dos respuestas de Seba, dos asesores nuevos, dos
// avisos al supervisor) debe seguir evitándose aunque cada pasada haya leído
// el mismo estado antes de que la otra escribiera. Cada acción se RECLAMA con
// una escritura condicional y solo quien la gana actúa:
//   - responder:  insert … on conflict do nothing + update responded_at
//                 where responded_at is null returning.
//   - reasignar:  update … where reassignments = <valor leído> returning.
//   - avisar:     update … where supervisor_notified_at is null returning.
//
// La IA NUNCA se reactiva desde acá (`ai_enabled` no se escribe): la demora
// responde una vez por episodio con límites (D2) y reasigna, no devuelve el
// chat a Seba.
//
// Acotado a propósito: la consulta de candidatas nunca recorre la tabla —solo
// conversaciones abiertas, dentro de la ventana de 24 h (origen "cliente") o
// con una escalada de los últimos días (origen "escalada"), con un tope de
// filas por origen— y la pasada actúa sobre `max` conversaciones como máximo
// (el resto espera a la siguiente, un minuto después).
// ---------------------------------------------------------------------------

/** Tope de acciones que una pasada ejecuta (una pasada por minuto). */
export const MAX_ACCIONES_POR_PASADA = 5;

/** Tope de filas leídas por origen de candidata: la pasada nunca escanea la tabla entera. */
const MAX_CANDIDATAS_POR_ORIGEN = 50;

/**
 * Cuánto hacia atrás se buscan escaladas abiertas. Una escalada del viernes
 * 17:50 sin atender llega al lunes 8:05 (≈62 h de pared) antes de cumplir sus
 * 15 min de horario; 4 días cubre un fin de semana largo. Más viejo que eso ya
 * no es una espera que reasignar sino un lead abandonado, y sin este corte las
 * escaladas ya resueltas (tope alcanzado y supervisor avisado) seguirían
 * ocupando el tope de filas para siempre.
 */
const HORIZONTE_ESCALADAS_MS = 4 * 24 * 60 * 60 * 1000;

/** Ventana de WhatsApp: 24 h. */
const VENTANA_MS = 24 * 60 * 60 * 1000;

/** Cuántos mensajes recientes se leen para la ráfaga del cliente, la última salida y la ventana. */
const MENSAJES_RECIENTES = 15;

const MS_POR_MINUTO = 60_000;

export interface ResumenDemora {
  /** false = la demora está apagada (o sin fecha de encendido): no se hizo nada. */
  activa: boolean;
  candidatas: number;
  /** Conversaciones sobre las que `evaluarDemora` decidió una acción (con o sin éxito al ejecutarla). */
  intentos: number;
  responder: number;
  reasignar: number;
  avisar_supervisor: number;
  /** Reasignaciones que no encontraron a quién pasarle el caso (se reintentan en la próxima pasada). */
  sinCandidato: number;
  /** Acciones que otra pasada ya había reclamado. */
  yaReclamadas: number;
  errores: number;
}

type Supabase = SupabaseClient<Database>;

const CAMPOS_CONVERSACION = "id, status, awaiting_reply, assigned_agent_id, last_customer_message_at";

interface ConversacionCandidata {
  id: string;
  status: string;
  awaiting_reply: boolean;
  assigned_agent_id: string | null;
  last_customer_message_at: string | null;
}

/**
 * La pasada. `max` es el tope de conversaciones sobre las que se ACTÚA (no de
 * las revisadas). Nunca lanza: un error en una conversación se registra y las
 * demás siguen; un error de lectura de las candidatas corta la pasada entera
 * (falla cerrado: sin candidatas fiables no se reasigna a ciegas).
 */
export async function procesarDemoras(
  supabase: Supabase,
  opciones: { now?: Date; max?: number } = {}
): Promise<ResumenDemora> {
  const now = opciones.now ?? new Date();
  const max = opciones.max ?? MAX_ACCIONES_POR_PASADA;
  const resumen: ResumenDemora = {
    activa: false,
    candidatas: 0,
    intentos: 0,
    responder: 0,
    reasignar: 0,
    avisar_supervisor: 0,
    sinCandidato: 0,
    yaReclamadas: 0,
    errores: 0,
  };

  try {
    // -- Interruptor ---------------------------------------------------------
    const { data: ajustes, error: ajustesError } = await supabase
      .from("agent_settings")
      .select("business_hours, demora_activa, demora_activa_desde")
      .eq("id", true)
      .maybeSingle();
    if (ajustesError) {
      log.error("demora_ajustes_no_legibles", { detail: errorText(ajustesError) });
      resumen.errores++;
      return resumen;
    }
    if (!ajustes?.demora_activa) return resumen;
    const desdeMs = ajustes.demora_activa_desde ? Date.parse(ajustes.demora_activa_desde) : NaN;
    if (Number.isNaN(desdeMs)) {
      // Encendida sin fecha: sin corte no hay forma de separar el backlog de lo
      // nuevo. `evaluarDemora` también falla cerrado, pero acá se evita leer.
      log.warn("demora_encendida_sin_fecha");
      return resumen;
    }
    resumen.activa = true;
    const businessHours = parseBusinessHours(ajustes.business_hours ?? undefined);
    const desdeIso = new Date(desdeMs).toISOString();

    // -- Candidatas ----------------------------------------------------------
    const candidatas = await leerCandidatas(supabase, now, desdeMs);
    resumen.candidatas = candidatas.length;
    if (candidatas.length === 0) return resumen;
    const ids = candidatas.map((c) => c.conversacion.id);

    const [traspasosPorConv, episodiosPorConv] = await Promise.all([
      leerTraspasos(supabase, ids, desdeIso),
      leerEpisodios(supabase, ids),
    ]);

    // -- Una por una, hasta llenar el tope -----------------------------------
    for (const { conversacion } of candidatas) {
      if (resumen.intentos >= max) break;
      try {
        const estado = await armarEstado(supabase, conversacion, {
          now,
          desde: new Date(desdeMs),
          traspasos: traspasosPorConv.get(conversacion.id) ?? [],
          episodios: episodiosPorConv.get(conversacion.id) ?? [],
        });
        const decision = evaluarDemora(estado, now, businessHours);
        if (decision.accion === "nada" || !decision.episodio) continue;

        resumen.intentos++;
        const resultado = await ejecutar(supabase, conversacion.id, estado, decision, now);
        if (resultado === "hecha") resumen[decision.accion]++;
        else if (resultado === "sin_candidato") resumen.sinCandidato++;
        else resumen.yaReclamadas++;
      } catch (err) {
        // Una conversación que falla no frena a las demás.
        resumen.errores++;
        log.error("demora_conversacion_fallida", { conversationId: conversacion.id, detail: errorText(err) });
      }
    }
  } catch (err) {
    resumen.errores++;
    log.error("demora_pasada_fallida", { detail: errorText(err) });
  }
  return resumen;
}

// ---------------------------------------------------------------------------
// Lectura de candidatas
// ---------------------------------------------------------------------------

async function leerCandidatas(
  supabase: Supabase,
  now: Date,
  desdeMs: number
): Promise<{ conversacion: ConversacionCandidata; referenciaMs: number }[]> {
  const porId = new Map<string, { conversacion: ConversacionCandidata; referenciaMs: number }>();
  const agregar = (conversacion: ConversacionCandidata, referenciaMs: number) => {
    const previa = porId.get(conversacion.id);
    if (!previa || referenciaMs < previa.referenciaMs) porId.set(conversacion.id, { conversacion, referenciaMs });
  };

  // Origen "cliente": mensaje sin respuesta real, dentro de la ventana, con al
  // menos 10 min de espera (antes no hay nada que hacer todavía) y posterior al
  // encendido (el backlog no dispara).
  const desdeCliente = new Date(Math.max(desdeMs, now.getTime() - VENTANA_MS)).toISOString();
  const hastaCliente = new Date(now.getTime() - MINUTOS_PARA_RESPONDER * MS_POR_MINUTO).toISOString();
  // `awaiting_reply` es una columna GENERADA que `database.types.ts` no trae (los
  // tipos son copia a mano, ver CLAUDE.md): mismo camino sin tipos que usa
  // `reconciler.ts` para leerla.
  const conversaciones = supabase as unknown as SupabaseClient;
  const { data: esperando, error: esperandoError } = await conversaciones
    .from("conversations")
    .select(CAMPOS_CONVERSACION)
    .neq("status", "closed")
    .eq("awaiting_reply", true)
    .gt("last_customer_message_at", desdeCliente)
    .lte("last_customer_message_at", hastaCliente)
    .order("last_customer_message_at", { ascending: true })
    .limit(MAX_CANDIDATAS_POR_ORIGEN);
  if (esperandoError) {
    log.error("demora_candidatas_no_legibles", { origen: "cliente", detail: errorText(esperandoError) });
    throw new Error(`candidatas (cliente) no legibles: ${errorText(esperandoError)}`);
  }
  for (const fila of (esperando ?? []) as ConversacionCandidata[]) {
    if (fila.last_customer_message_at) agregar(fila, Date.parse(fila.last_customer_message_at));
  }

  // Origen "escalada": un traspaso `escalada`/`escalada_sin_asesor` posterior al
  // encendido, de hace 15 min o más (antes no puede haber cumplido nada). No
  // depende de `awaiting_reply`: la despedida de Seba lo apaga. Las más nuevas
  // primero, para que las ya resueltas —que envejecen— salgan del tope.
  const desdeEscalada = new Date(Math.max(desdeMs, now.getTime() - HORIZONTE_ESCALADAS_MS)).toISOString();
  const hastaEscalada = new Date(now.getTime() - MINUTOS_PARA_REASIGNAR * MS_POR_MINUTO).toISOString();
  const { data: escaladas, error: escaladasError } = await supabase
    .from("conversation_handoffs")
    .select("conversation_id, created_at")
    .in("reason", ["escalada", "escalada_sin_asesor"])
    .gt("created_at", desdeEscalada)
    .lte("created_at", hastaEscalada)
    .order("created_at", { ascending: false })
    .limit(MAX_CANDIDATAS_POR_ORIGEN);
  if (escaladasError) {
    log.error("demora_candidatas_no_legibles", { origen: "escalada", detail: errorText(escaladasError) });
    throw new Error(`candidatas (escalada) no legibles: ${errorText(escaladasError)}`);
  }
  const referenciaEscalada = new Map<string, number>();
  for (const fila of escaladas ?? []) {
    const ms = Date.parse(fila.created_at);
    const previa = referenciaEscalada.get(fila.conversation_id);
    if (previa === undefined || ms < previa) referenciaEscalada.set(fila.conversation_id, ms);
  }
  if (referenciaEscalada.size > 0) {
    const { data: escaladasAbiertas, error } = await conversaciones
      .from("conversations")
      .select(CAMPOS_CONVERSACION)
      .in("id", [...referenciaEscalada.keys()])
      .neq("status", "closed");
    if (error) {
      log.error("demora_candidatas_no_legibles", { origen: "escalada_conversaciones", detail: errorText(error) });
      throw new Error(`conversaciones escaladas no legibles: ${errorText(error)}`);
    }
    for (const fila of (escaladasAbiertas ?? []) as ConversacionCandidata[]) {
      agregar(fila, referenciaEscalada.get(fila.id) ?? now.getTime());
    }
  }

  // Más antiguas primero: la que lleva más esperando se atiende antes.
  return [...porId.values()].sort((a, b) => a.referenciaMs - b.referenciaMs);
}

/**
 * Traspasos que CAMBIAN DE MANOS, con el mismo filtro que `escalationOpen`
 * (`RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` fuera) y posteriores al encendido de la
 * demora (`evaluarDemora` ignora los anteriores de todos modos).
 */
async function leerTraspasos(supabase: Supabase, ids: string[], desdeIso: string): Promise<Map<string, TraspasoDemora[]>> {
  const { data, error } = await supabase
    .from("conversation_handoffs")
    .select("conversation_id, reason, created_at")
    .in("conversation_id", ids)
    .gt("created_at", desdeIso)
    .not("reason", "in", `(${RAZONES_QUE_NO_CIERRAN_LA_ESCALADA.join(",")})`)
    .order("created_at", { ascending: false });
  if (error) {
    log.error("demora_traspasos_no_legibles", { detail: errorText(error) });
    throw new Error(`traspasos no legibles: ${errorText(error)}`);
  }
  const porConv = new Map<string, TraspasoDemora[]>();
  for (const fila of data ?? []) {
    const lista = porConv.get(fila.conversation_id) ?? [];
    lista.push(aTraspasoDemora(fila));
    porConv.set(fila.conversation_id, lista);
  }
  return porConv;
}

/**
 * Una fila de `conversation_handoffs` tal cual, SIN reinterpretar su razón:
 * `reasignada_por_demora` viaja como lo que es y `evaluarDemora` la atraviesa
 * hasta la escalada original. Si acá se la disfrazara de `escalada`, cada
 * reasignación abriría un episodio nuevo con el contador en cero y el tope de
 * dos no llegaría nunca (segunda corrección del operador, mutación (h) del plan).
 */
function aTraspasoDemora(fila: { reason: string; created_at: string }): TraspasoDemora {
  return { reason: fila.reason, createdAt: new Date(fila.created_at) };
}

async function leerEpisodios(supabase: Supabase, ids: string[]): Promise<Map<string, EpisodioGuardado[]>> {
  const { data, error } = await supabase.from("conversation_delay_episodes").select("*").in("conversation_id", ids);
  if (error) {
    log.error("demora_episodios_no_legibles", { detail: errorText(error) });
    throw new Error(`episodios no legibles: ${errorText(error)}`);
  }
  const porConv = new Map<string, EpisodioGuardado[]>();
  for (const fila of data ?? []) {
    const lista = porConv.get(fila.conversation_id) ?? [];
    lista.push({
      episodeAt: new Date(fila.episode_at),
      origen: fila.origen as OrigenEpisodio,
      respondedAt: fila.responded_at ? new Date(fila.responded_at) : null,
      reassignments: fila.reassignments,
      agentesPrevios: fila.agentes_previos ?? [],
      ultimaReasignacionAt: fila.ultima_reasignacion_at ? new Date(fila.ultima_reasignacion_at) : null,
      supervisorNotifiedAt: fila.supervisor_notified_at ? new Date(fila.supervisor_notified_at) : null,
    });
    porConv.set(fila.conversation_id, lista);
  }
  return porConv;
}

// ---------------------------------------------------------------------------
// Armado del estado
// ---------------------------------------------------------------------------

async function armarEstado(
  supabase: Supabase,
  conversacion: ConversacionCandidata,
  contexto: {
    now: Date;
    desde: Date;
    traspasos: TraspasoDemora[];
    episodios: EpisodioGuardado[];
  }
): Promise<EstadoDemora> {
  const { now, traspasos, episodios } = contexto;
  const conversationId = conversacion.id;

  // Último mensaje REAL de un asesor: el mismo predicado que apaga la IA por
  // trigger (`handle_agent_message_silences_ai`) — una nota interna no cuenta.
  const { data: delAsesor, error: asesorError } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .eq("direction", "outbound")
    .eq("is_internal_note", false)
    .order("created_at", { ascending: false })
    .limit(1);
  if (asesorError) throw new Error(`mensajes del asesor no legibles: ${errorText(asesorError)}`);

  const { data: recientes, error: recientesError } = await supabase
    .from("messages")
    .select("created_at, direction, sender_type, content, is_internal_note, message_type, whatsapp_status, whatsapp_error_code")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MENSAJES_RECIENTES);
  if (recientesError) throw new Error(`mensajes recientes no legibles: ${errorText(recientesError)}`);
  const cronologicos = [...(recientes ?? [])].reverse();

  // Última salida visible al cliente (Seba o asesor, despedida incluida); un
  // envío fallido no le llegó a nadie y una nota interna no es una salida.
  let ultimaSalidaAt: Date | null = null;
  for (const fila of [...cronologicos].reverse()) {
    if (fila.direction === "outbound" && !fila.is_internal_note && fila.sender_type !== "system" && fila.whatsapp_status !== "failed") {
      ultimaSalidaAt = new Date(fila.created_at);
      break;
    }
  }

  // Ventana de 24 h: la MISMA regla que el composer (24 h del último mensaje
  // del cliente Y que Meta no la haya cerrado con un 131047).
  const ventanaAbierta = isComposerWindowOpen(
    conversacion.last_customer_message_at,
    cronologicos.map((fila) => ({
      direction: fila.direction as "inbound" | "outbound",
      messageType: (fila.message_type ?? "text") as never,
      whatsappStatus: (fila.whatsapp_status ?? null) as never,
      whatsappErrorCode: fila.whatsapp_error_code ?? null,
      createdAt: fila.created_at,
    })),
    now
  );

  return {
    demoraActiva: true, // ya se comprobó el interruptor al arrancar la pasada
    demoraActivaDesde: contexto.desde,
    abierta: conversacion.status !== "closed",
    awaitingReply: conversacion.awaiting_reply,
    ventanaAbierta,
    rafagaSoloCortesia: rafagaEsSoloCortesia(cronologicos),
    asesorAsignadoId: conversacion.assigned_agent_id,
    lastCustomerMessageAt: conversacion.last_customer_message_at ? new Date(conversacion.last_customer_message_at) : null,
    ultimaSalidaAt,
    ultimoMensajeAsesorAt: delAsesor?.[0] ? new Date(delAsesor[0].created_at) : null,
    traspasos,
    episodios,
  };
}

/**
 * ¿Lo último que dijo el cliente es solo cortesía o un sticker ("ok", "gracias",
 * 👍)? Se mide sobre la ráfaga FINAL del cliente, ignorando lo que Seba o un
 * asesor hayan dicho después (la despedida de la escalada no borra lo que el
 * cliente escribió antes). Sin ninguna línea legible del cliente en el historial
 * reciente no hay nada que contestar: también cuenta como cortesía (falla
 * cerrado hacia no molestar). Un marcador de media ("[El cliente envió una
 * foto…]") NO es cortesía: una foto sin atender sí espera a una persona.
 */
function rafagaEsSoloCortesia(
  cronologicos: {
    created_at: string;
    sender_type: string;
    content: string | null;
    is_internal_note: boolean | null;
    message_type: string | null;
  }[]
): boolean {
  const lineas = cronologicos
    .map((fila) => ({ linea: historyLine(fila), createdAt: fila.created_at }))
    .filter((x): x is { linea: NonNullable<ReturnType<typeof historyLine>>; createdAt: string } => x.linea !== null)
    .map((x) => ({ role: x.linea.role, content: x.linea.content, createdAt: x.createdAt }));

  let ultimaDelCliente = -1;
  for (let i = lineas.length - 1; i >= 0; i--) {
    if (lineas[i].role === "user") {
      ultimaDelCliente = i;
      break;
    }
  }
  if (ultimaDelCliente === -1) return true;

  const rafaga = customerBurst(lineas.slice(0, ultimaDelCliente + 1));
  // Ráfaga vacía con líneas de cliente = solo stickers (`customerBurst` los salta).
  return rafaga.every((texto) => isCourtesyOnly(texto));
}

// ---------------------------------------------------------------------------
// Ejecución de la acción
// ---------------------------------------------------------------------------

type ResultadoEjecucion = "hecha" | "ya_reclamada" | "sin_candidato";

async function ejecutar(
  supabase: Supabase,
  conversationId: string,
  estado: EstadoDemora,
  decision: ResultadoDemora,
  now: Date
): Promise<ResultadoEjecucion> {
  const episodio = decision.episodio!;
  const fila = estado.episodios.find((e) => e.episodeAt.getTime() === episodio.episodeAt.getTime()) ?? null;
  const contexto = { conversationId, estado, decision, episodio, fila, now };

  switch (decision.accion) {
    case "responder":
      return responder(supabase, contexto);
    case "reasignar":
      return reasignar(supabase, contexto);
    case "avisar_supervisor":
      return avisarSupervisor(supabase, contexto);
    default:
      return "ya_reclamada";
  }
}

interface ContextoAccion {
  conversationId: string;
  estado: EstadoDemora;
  decision: ResultadoDemora;
  episodio: { origen: OrigenEpisodio; episodeAt: Date };
  fila: EpisodioGuardado | null;
  now: Date;
}

/** `insert … on conflict do nothing`: garantiza que la fila del episodio exista antes de reclamarla. */
async function asegurarEpisodio(supabase: Supabase, c: ContextoAccion): Promise<void> {
  const { error } = await supabase.from("conversation_delay_episodes").upsert(
    {
      conversation_id: c.conversationId,
      episode_at: c.episodio.episodeAt.toISOString(),
      origen: c.episodio.origen,
    },
    { onConflict: "conversation_id,episode_at", ignoreDuplicates: true }
  );
  if (error) throw new Error(`no se pudo asegurar el episodio: ${errorText(error)}`);
}

async function responder(supabase: Supabase, c: ContextoAccion): Promise<ResultadoEjecucion> {
  const episodeIso = c.episodio.episodeAt.toISOString();
  const nowIso = c.now.toISOString();
  await asegurarEpisodio(supabase, c);

  // El candado: solo una pasada ve `responded_at is null` y lo cambia.
  const { data: reclamada, error } = await supabase
    .from("conversation_delay_episodes")
    .update({ responded_at: nowIso })
    .eq("conversation_id", c.conversationId)
    .eq("episode_at", episodeIso)
    .is("responded_at", null)
    .select("conversation_id");
  if (error) throw new Error(`no se pudo reclamar la respuesta: ${errorText(error)}`);
  if (!reclamada || reclamada.length === 0) {
    log.info("demora_respuesta_ya_reclamada", { conversationId: c.conversationId });
    return "ya_reclamada";
  }

  try {
    const resultado = await runDelayTurn(c.conversationId, {
      episodeAt: c.episodio.episodeAt,
      esperaMinutos: c.decision.esperaMinutos ?? MINUTOS_PARA_RESPONDER,
      now: c.now,
    });
    if (!resultado.enviado) {
      // El turno decidió no hablar (IA apagada global, un asesor se adelantó,
      // ventana cerrada…): el episodio queda reclamado a propósito, para no
      // reintentar cada minuto lo que el turno ya resolvió.
      log.info("demora_respuesta_no_enviada", { conversationId: c.conversationId, motivo: resultado.motivo });
    }
  } catch (err) {
    // Un fallo del turno (proveedor caído, corte de base) es transitorio: se
    // libera el candado para que la próxima pasada lo reintente. Solo se libera
    // lo que ESTA pasada reclamó (`responded_at = nowIso`).
    const { error: liberarError } = await supabase
      .from("conversation_delay_episodes")
      .update({ responded_at: null })
      .eq("conversation_id", c.conversationId)
      .eq("episode_at", episodeIso)
      .eq("responded_at", nowIso);
    if (liberarError) {
      log.error("demora_respuesta_candado_no_liberado", { conversationId: c.conversationId, detail: errorText(liberarError) });
    }
    throw err;
  }
  return "hecha";
}

async function reasignar(supabase: Supabase, c: ContextoAccion): Promise<ResultadoEjecucion> {
  const { conversationId, estado, decision, fila, now } = c;
  const episodeIso = c.episodio.episodeAt.toISOString();
  const nowIso = now.toISOString();
  const saliente = estado.asesorAsignadoId;

  // Primero el asesor: si no hay a quién pasarle el caso NO se escribe nada (ni
  // episodio ni traspaso) y la próxima pasada lo reintenta con los asesores que
  // haya para entonces. `excluir` trae al dueño actual y a los que ya rotaron
  // en este episodio: el reparto nunca le devuelve el caso a quien lo dejó
  // 15 min sin contestar (D4).
  const nuevo = await claimNextAvailableAgent(supabase, { excluir: decision.excluir ?? [] });
  if (!nuevo) {
    log.warn("reasignacion_sin_candidato", { conversationId, excluidos: (decision.excluir ?? []).length });
    return "sin_candidato";
  }

  await asegurarEpisodio(supabase, c);

  // El candado: el contador leído tiene que seguir siendo el de la base. Dos
  // pasadas que leyeron `reassignments = N` a la vez: solo una lo sube a N+1.
  const leidas = fila?.reassignments ?? 0;
  const previos = [...new Set([...(fila?.agentesPrevios ?? []), ...(saliente ? [saliente] : [])])];
  const { data: avanzada, error: avanzarError } = await supabase
    .from("conversation_delay_episodes")
    .update({ reassignments: leidas + 1, agentes_previos: previos, ultima_reasignacion_at: nowIso })
    .eq("conversation_id", conversationId)
    .eq("episode_at", episodeIso)
    .eq("reassignments", leidas)
    .select("conversation_id");
  if (avanzarError) throw new Error(`no se pudo reclamar la reasignación: ${errorText(avanzarError)}`);
  if (!avanzada || avanzada.length === 0) {
    log.info("demora_reasignacion_ya_reclamada", { conversationId, agenteDescartado: nuevo.id });
    return "ya_reclamada";
  }

  // La conversación pasa al asesor nuevo SOLO si sigue con el dueño que se leyó:
  // si un asesor la tomó mientras tanto, no se le quita. `ai_enabled` no se toca.
  const cambio = supabase.from("conversations").update({ assigned_agent_id: nuevo.id }).eq("id", conversationId);
  const { data: movida, error: moverError } = await (saliente === null
    ? cambio.is("assigned_agent_id", null)
    : cambio.eq("assigned_agent_id", saliente)
  ).select("id");
  if (moverError) throw new Error(`no se pudo reasignar la conversación: ${errorText(moverError)}`);
  if (!movida || movida.length === 0) {
    log.warn("demora_reasignacion_perdio_carrera", { conversationId, agenteDescartado: nuevo.id });
    return "ya_reclamada";
  }

  await recordHandoff(supabase, {
    conversationId,
    toKind: "human",
    toId: nuevo.id,
    fromKind: saliente ? "human" : "unassigned",
    fromId: saliente,
    reason: "reasignada_por_demora",
  });

  const nombreSaliente = saliente ? await nombreDeAsesor(supabase, saliente) : null;
  const esperaMinutos = decision.esperaMinutos ?? MINUTOS_PARA_REASIGNAR;
  const { error: notaError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    message_type: "system_event",
    is_internal_note: true,
    content: saliente
      ? `Reasignada por demora: ${nombreSaliente ?? "el asesor anterior"} no contestó en ${esperaMinutos} min. Pasó a ${nuevo.displayName} (reasignación ${leidas + 1} de ${TOPE_REASIGNACIONES}).`
      : `Asignada por demora: la escalada llevaba ${esperaMinutos} min sin dueño. Pasó a ${nuevo.displayName} (reasignación ${leidas + 1} de ${TOPE_REASIGNACIONES}).`,
  });
  if (notaError) log.warn("demora_nota_no_escrita", { conversationId, detail: errorText(notaError) });

  log.info("reasignada_por_demora", {
    conversationId,
    de: saliente,
    a: nuevo.id,
    reasignaciones: leidas + 1,
    esperaMinutos,
    origen: c.episodio.origen,
  });
  return "hecha";
}

async function avisarSupervisor(supabase: Supabase, c: ContextoAccion): Promise<ResultadoEjecucion> {
  const { conversationId, estado, decision, now } = c;
  const episodeIso = c.episodio.episodeAt.toISOString();
  const nowIso = now.toISOString();
  await asegurarEpisodio(supabase, c);

  const { data: reclamado, error } = await supabase
    .from("conversation_delay_episodes")
    .update({ supervisor_notified_at: nowIso })
    .eq("conversation_id", conversationId)
    .eq("episode_at", episodeIso)
    .is("supervisor_notified_at", null)
    .select("conversation_id");
  if (error) throw new Error(`no se pudo reclamar el aviso: ${errorText(error)}`);
  if (!reclamado || reclamado.length === 0) return "ya_reclamada";

  // Al MISMO dueño: el aviso no mueve el caso. Es el rastro que lee el
  // `AssignmentNotifier` de supervisores y admins.
  const dueno = estado.asesorAsignadoId;
  const escrito = await recordHandoff(supabase, {
    conversationId,
    toKind: dueno ? "human" : "unassigned",
    toId: dueno,
    fromKind: dueno ? "human" : "unassigned",
    fromId: dueno,
    reason: "demora_sin_asesor",
  });
  if (!escrito) {
    // Sin el traspaso nadie se entera: se libera el candado para que la próxima
    // pasada lo reintente, en vez de dar el aviso por hecho.
    await supabase
      .from("conversation_delay_episodes")
      .update({ supervisor_notified_at: null })
      .eq("conversation_id", conversationId)
      .eq("episode_at", episodeIso)
      .eq("supervisor_notified_at", nowIso);
    return "ya_reclamada";
  }

  log.info("demora_sin_asesor", {
    conversationId,
    asesor: dueno,
    reasignaciones: decision.reasignaciones ?? TOPE_REASIGNACIONES,
    esperaMinutos: decision.esperaMinutos ?? null,
  });
  return "hecha";
}

async function nombreDeAsesor(supabase: Supabase, agentId: string): Promise<string | null> {
  const { data } = await supabase.from("agents").select("display_name").eq("id", agentId).maybeSingle();
  return data?.display_name ?? null;
}
