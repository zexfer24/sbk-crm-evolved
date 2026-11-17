import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { escalateConversation, type EscalateResult } from "@/lib/ai/escalate";
import { recordHandoff } from "@/lib/ai/handoffs";
import type { SeenMarker } from "@/lib/ai/history-line";
import { sendAgentImage, sendAgentText, type DeliveryOutcome } from "@/lib/ai/send";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { writeSeen } from "@/lib/ai/turn-seen";
import { businessStatus, type BusinessHours, type BusinessStatus } from "@/lib/business-hours";
import { errorText, log } from "@/lib/log";
import { escribirCarritoDeSeba } from "./carrito-servidor";
import type { TurnEffects } from "./effects";
import type { MotivoV2 } from "./motivos";
import {
  estadoVigente,
  parseEstadoSeba,
  type Area,
  type EstadoSeba,
  type LineaDeCarrito,
  type ResultadoDePase,
  type ResumenDeTurno,
} from "./tipos";

/**
 * Efectos REALES de Seba v2 (S2b, 17/11/2026): lo que el turno hace de verdad —
 * envía por WhatsApp, asigna asesor, guarda el carrito y el estado del pedido.
 *
 * DECISIÓN DE DISEÑO (evita un import circular con `agent.ts`): este módulo NO
 * importa nada de `agent.ts`. Lo que es del turno de v1 —la puerta de envío
 * `deliver`, qué hacer si un envío sale `failed`, el indicador de «escribiendo» y
 * la bitácora `logTurn`— llega INYECTADO como funciones en `DepsDeEffectsReales`;
 * la costura las conecta. Así este archivo se prueba sin levantar el turno.
 *
 * Todo texto o imagen sale por `deps.entregar`, que es el `deliver()` de v1 ya
 * cerrado sobre el turno (guardas de humano, ventana de 24 h, lock): si una guarda
 * frena un envío, el turno deja de hablar. Lo mismo si un envío sale `failed`.
 */

export interface DepsDeEffectsReales {
  /** Cliente admin (service role). */
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  target: TurnTarget;
  businessHours: BusinessHours;
  ahora: () => Date;
  /** Había asesor asignado al abrir el turno: toda salida es `is_auto_reply` (el cliente espera a esa persona). */
  asesorAsignadoAlAbrir: boolean;
  /** La puerta de envío de v1 (`deliver`) ya cerrada sobre el turno. `null` = una guarda frenó (y ya dejó su traspaso). */
  entregar: (enviar: () => Promise<DeliveryOutcome>) => Promise<DeliveryOutcome | null>;
  /** Qué hace v1 cuando un envío sale `failed` (`deliveryFailed`): deja traspaso y resetea la etapa. */
  alFallarEnvio: (entrega: DeliveryOutcome, yaEscalada: boolean) => Promise<void>;
  /** Dispara el indicador de «escribiendo…» (no espera, no lanza). */
  escribiendo: () => void;
  /** Escribe la bitácora del turno (`logTurn` con `agent_version = 'v2'`). */
  registrarTurno: (resumen: ResumenDeTurno, pase: { area: Area; motivo: MotivoV2 } | null) => Promise<void>;
  /** Marca «visto hasta» con la que abrió el turno: sirve para saber si llegó un mensaje nuevo mientras redactaba. */
  visto: SeenMarker | null;
  /**
   * ¿Hay Redis para la marca «visto hasta»? (`REDIS_URL` configurada.) `writeSeen`
   * (turn-seen.ts) abre su propia conexión compartida, así que no hace falta pasar
   * el cliente: el brief original pedía `redis: (() => Redis) | null`, pero
   * duplicar acá la clave y el TTL de esa marca habría dejado dos fuentes. Sin
   * Redis `marcarVisto` no hace nada.
   */
  redisDisponible: boolean;
}

const MS_POR_HORA = 60 * 60 * 1000;
/** Ventana de la bienvenida: una por ventana de 24 h. */
const BIENVENIDA_VENTANA_HORAS = 24;
/** Las cotizaciones que cuentan como «ya se le dijo al cliente»: las de las últimas 72 h. */
const COTIZADOS_VENTANA_HORAS = 72;

/**
 * Cuándo abre la tienda, redactado como en v1 (`seba.ts`, `tools.ts`: «el lunes a
 * partir de las 8:00 am»). Sin próxima apertura (horario cerrado los siete días),
 * `null`. Copia de la que usa `effects-sombra.ts`: dos archivos de una misma tarea
 * no se importan entre sí solo por cuatro líneas.
 */
function cuandoAbre(status: BusinessStatus): string | null {
  if (status.open || !status.nextOpening) return null;
  return `${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}`;
}

export function crearEffectsReales(deps: DepsDeEffectsReales): TurnEffects {
  const { supabase, conversationId } = deps;

  /** Tras una guarda que frenó o un envío fallido, el turno no sigue hablando. */
  let detenido = false;
  /** Ya se le pasó (o ya tenía) un asesor: lo que se mande desde aquí es una cortesía mientras espera. */
  let pasadoAAsesor = false;
  /** Ids de fila de `messages` enviados SIN `is_auto_reply`: el pase los marca cuando ya sabe que el cliente espera a una persona. */
  let sinMarcar: string[] = [];
  let ultimoPase: { area: Area; motivo: MotivoV2 } | null = null;

  /** Sello de la bienvenida que ESTE turno reclamó, y lo que había antes (para revertir si no salió). */
  let bienvenida: { sello: string; anterior: string | null } | null = null;

  async function revertirBienvenida(): Promise<void> {
    if (!bienvenida) return;
    const { sello, anterior } = bienvenida;
    bienvenida = null;
    // Solo revierte SU sello: si otro turno lo cambió en medio, no se lo pisa.
    const { error } = await supabase
      .from("conversations")
      .update({ welcome_sent_at: anterior })
      .eq("id", conversationId)
      .eq("welcome_sent_at", sello);
    if (error) log.warn("seba2_bienvenida_no_revertida", { conversationId, detail: error.message });
  }

  async function enviar(
    hacer: (isAutoReply: boolean, alGuardar: (id: string | null) => void) => Promise<DeliveryOutcome>
  ): Promise<{ ok: boolean }> {
    if (detenido) return { ok: false };

    const isAutoReply = deps.asesorAsignadoAlAbrir || pasadoAAsesor;
    let filaId: string | null = null;
    const entrega = await deps.entregar(() =>
      hacer(isAutoReply, (id) => {
        filaId = id;
      })
    );

    // Una bienvenida que no salió no cuenta como dada: se revierte con el PRIMER
    // envío del turno que no llegó (mismo patrón que v1, `bienvenida_rechazada_por_meta`).
    // Si el primero salió bien, el sello se queda.
    const primerEnvioDeLaBienvenida = bienvenida !== null;
    const fallo = entrega === null || entrega.whatsapp_status === "failed";

    if (fallo) {
      detenido = true;
      if (primerEnvioDeLaBienvenida) await revertirBienvenida();
      if (entrega !== null) await deps.alFallarEnvio(entrega, pasadoAAsesor);
      return { ok: false };
    }

    bienvenida = null;
    if (!isAutoReply && filaId) sinMarcar.push(filaId);
    return { ok: true };
  }

  /** Marca como automáticos los mensajes que salieron antes de saber que el cliente espera a un asesor. */
  async function marcarComoAutomaticos(): Promise<void> {
    if (sinMarcar.length === 0) return;
    const ids = sinMarcar;
    sinMarcar = [];
    // El trigger de la base (20260905070000) recalcula `last_reply_at` y devuelve
    // `awaiting_reply` a true: el cliente sigue esperando a una persona.
    const { error } = await supabase
      .from("messages")
      .update({ is_auto_reply: true })
      .eq("conversation_id", conversationId)
      .in("id", ids);
    if (error) {
      // El pase ya ocurrió: lanzar ahora dejaría al turno fallando DESPUÉS de haber
      // escalado. Queda dicho para quien mire por qué la conversación no figura esperando.
      log.error("seba2_pase_no_marco_auto_reply", { conversationId, mensajes: ids.length, detail: error.message });
    }
  }

  return {
    modo: "real",

    escribiendo() {
      try {
        deps.escribiendo();
      } catch {
        // El indicador es cosmético: nunca puede tumbar el turno.
      }
    },

    // El origen (modelo/fijo/herramienta) solo le sirve a la sombra para el borrador.
    async enviarTexto(texto: string) {
      return enviar((isAutoReply, alGuardar) => sendAgentText(supabase, deps.target, texto, { isAutoReply, alGuardar }));
    },

    async enviarImagen(mediaUrl: string, pie: string | null) {
      return enviar((isAutoReply, alGuardar) =>
        sendAgentImage(supabase, deps.target, mediaUrl, pie, { isAutoReply, alGuardar })
      );
    },

    async pasarAAsesor(i): Promise<ResultadoDePase> {
      let resultado: EscalateResult;
      try {
        resultado = await escalateConversation(supabase, {
          conversationId,
          contactId: deps.contactId,
          motivo: i.motivo,
          resumen: i.nota,
          area: i.area,
          businessHours: deps.businessHours,
          now: deps.ahora(),
        });
        // `escalateConversation` hoy nunca devuelve `escalated: false` (siempre
        // escala, aunque no haya a quién asignar); si algún día lo hace, el caso
        // no puede pasar por éxito: el cliente quedaría esperando sin dueño.
        if (!resultado.escalated) throw new Error("escalateConversation no escaló el caso");
      } catch (err) {
        // Invariante «ningún lead invisible»: un pase que falla deja el caso en
        // «Sin dueño» con su traspaso. `escalada_sin_asesor` es la razón vigente de
        // «se intentó escalar y no hubo a quién» (la base tiene CHECK: no se inventan).
        log.error("seba2_pase_fallo", { conversationId, motivo: i.motivo, area: i.area, detail: errorText(err) });
        await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "escalada_sin_asesor" });
        throw err;
      }

      const yaTeniaAsesor = resultado.alreadyAssigned === true;
      const status = resultado.businessStatus ?? businessStatus(deps.ahora(), deps.businessHours);

      ultimoPase = { area: i.area, motivo: i.motivo };
      pasadoAAsesor = true;
      await marcarComoAutomaticos();

      return {
        asignado: !resultado.unassigned,
        abierta: status.open,
        cuandoAbre: cuandoAbre(status),
        yaTeniaAsesor,
      };
    },

    async guardarCarrito(lineas: LineaDeCarrito[]) {
      await escribirCarritoDeSeba(supabase, conversationId, lineas);
    },

    async leerEstado(): Promise<EstadoSeba | null> {
      const { data, error } = await supabase
        .from("conversations")
        .select("seba_pedido")
        .eq("id", conversationId)
        .maybeSingle();
      if (error) {
        // Mejor empezar el pedido de cero que caerse: el turno sigue sin memoria.
        log.warn("seba2_estado_no_legible", { conversationId, detail: error.message });
        return null;
      }
      return estadoVigente(parseEstadoSeba(data?.seba_pedido ?? null), deps.ahora());
    },

    async guardarEstado(estado: EstadoSeba) {
      const { error } = await supabase
        .from("conversations")
        .update({ seba_pedido: estado as unknown as Json })
        .eq("id", conversationId);
      if (error) log.warn("seba2_estado_no_guardado", { conversationId, detail: error.message });
    },

    async reclamarBienvenida(): Promise<boolean> {
      // Se lee el sello ANTES: el UPDATE condicional es quien reclama (atómico),
      // pero para revertirlo si el saludo no sale hace falta saber qué había.
      const { data: previo, error: errorLectura } = await supabase
        .from("conversations")
        .select("welcome_sent_at")
        .eq("id", conversationId)
        .maybeSingle();
      if (errorLectura) {
        log.warn("seba2_bienvenida_no_legible", { conversationId, detail: errorLectura.message });
        return false;
      }

      const ahora = deps.ahora();
      const sello = ahora.toISOString();
      const limite = new Date(ahora.getTime() - BIENVENIDA_VENTANA_HORAS * MS_POR_HORA).toISOString();
      const { data, error } = await supabase
        .from("conversations")
        .update({ welcome_sent_at: sello })
        .eq("id", conversationId)
        .or(`welcome_sent_at.is.null,welcome_sent_at.lt.${limite}`)
        .select("id");
      if (error) {
        log.warn("seba2_bienvenida_no_reclamada", { conversationId, detail: error.message });
        return false;
      }
      if (!data || data.length === 0) return false;

      bienvenida = { sello, anterior: previo?.welcome_sent_at ?? null };
      return true;
    },

    async marcarVisto(marker: SeenMarker) {
      if (!deps.redisDisponible) return;
      try {
        // `writeSeen` ya no lanza; el try es por si una versión futura cambia eso.
        await writeSeen(conversationId, marker);
      } catch (err) {
        log.warn("seba2_visto_no_escrito", { conversationId, detail: errorText(err) });
      }
    },

    async productosYaCotizados(): Promise<Set<string>> {
      const desde = new Date(deps.ahora().getTime() - COTIZADOS_VENTANA_HORAS * MS_POR_HORA).toISOString();
      const { data, error } = await supabase
        .from("conversation_quotes")
        .select("product_id")
        .eq("conversation_id", conversationId)
        .gte("quoted_at", desde);
      if (error) {
        log.warn("seba2_cotizados_no_legibles", { conversationId, detail: error.message });
        return new Set();
      }
      const ids = new Set<string>();
      for (const fila of data ?? []) if (fila.product_id) ids.add(fila.product_id);
      return ids;
    },

    async hayMensajeNuevoDelCliente(): Promise<boolean> {
      if (!deps.visto) return false;
      // `gte` y no `gt`: Meta fecha al segundo (ver `SeenMarker`), así que lo del
      // MISMO segundo cuenta como nuevo salvo que su id ya esté entre los vistos.
      let consulta = supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .neq("message_type", "unsupported")
        .gte("created_at", deps.visto.hasta);
      if (deps.visto.ids.length > 0) consulta = consulta.not("id", "in", `(${deps.visto.ids.join(",")})`);
      const { data, error } = await consulta.limit(1);
      if (error) {
        log.warn("seba2_mensaje_nuevo_no_consultable", { conversationId, detail: error.message });
        return false;
      }
      return (data?.length ?? 0) > 0;
    },

    async cerrar(resumen: ResumenDeTurno) {
      try {
        await deps.registrarTurno(resumen, ultimoPase);
      } catch (err) {
        // La bitácora nunca puede tumbar un turno que ya habló con el cliente.
        log.error("seba2_bitacora_no_escrita", { conversationId, detail: errorText(err) });
      }
    },
  };
}
