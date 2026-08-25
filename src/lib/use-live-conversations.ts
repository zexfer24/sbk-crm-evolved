"use client";

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/lib/types";
import { fetchConversations } from "@/lib/data";
import { useLiveRefresh } from "@/lib/use-live-refresh";

export interface UseLiveConversationsOptions {
  /** Tope de filas; sin él se trae el histórico completo (métricas, ventas). */
  limit?: number;
  /**
   * Escuchar también contact_tags. Solo para las vistas que pintan etiquetas
   * (la bandeja, los reclamos del tablero): no viajan en la fila de la
   * conversación, así que su único camino es el refetch.
   */
  watchContactTags?: boolean;
  /** Nombre del canal realtime, único por vista para poder depurarlo. */
  channelName?: string;
}

export interface LiveConversations {
  conversations: Conversation[];
  /** Para los ajustes optimistas de la propia vista (marcar leído, etc.). */
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  /** Refetch inmediato, sin agrupar: tras una mutación que no puede esperar. */
  refreshConversations: () => Promise<void>;
}

/**
 * La lista de conversaciones mantenida al día por realtime, al costo mínimo.
 *
 * Cada evento de realtime pedía la lista entera: 200+ conversaciones con
 * siete relaciones cada una, unos 230 KB medidos, multiplicado por cada
 * pestaña abierta en cada vista (bandeja, tablero, ventas, control de IA).
 * Pero el evento ya trae la fila nueva: cuando lo que cambió son datos
 * propios de la conversación —el contador de no leídos, la vista previa, el
 * estado de entrega, el interruptor de la IA— no hay nada que volver a
 * pedir: se aplica y listo. En la práctica eso es casi todo el tráfico.
 *
 * El refetch queda para lo que el evento no puede resolver:
 *   - Una conversación que no estaba en la lista (no trae contacto ni canal).
 *   - Un cambio de agente asignado: la fila trae el id, no el agente.
 *   - Una venta cerrada o verificada: el monto vive en `orders`.
 *   - Cualquier cosa de `contact_tags`: las etiquetas no viajan en la fila.
 */
export function useLiveConversations(
  supabase: SupabaseClient,
  initialConversations: Conversation[],
  { limit, watchContactTags = false, channelName = "conversations-live" }: UseLiveConversationsOptions = {}
): LiveConversations {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);

  const refreshConversations = useCallback(async () => {
    try {
      const data = await fetchConversations(supabase, limit ? { limit } : {});
      setConversations(data);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase, limit]);

  const requestRefresh = useLiveRefresh(refreshConversations);

  /**
   * Aplica en memoria un cambio que ya viene entero en el evento. Devuelve
   * false cuando no puede resolverlo solo, y ahí sí se refresca.
   */
  const applyConversationRow = useCallback((row: Record<string, unknown>): boolean => {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return false;

    let resuelto = false;
    setConversations((current) => {
      const actual = current.find((c) => c.id === id);
      if (!actual) return current;

      // Lo que no viaja en la fila: si cambió, hay que ir a buscarlo.
      const cambioElAsignado = (row.assigned_agent_id ?? null) !== (actual.assignedAgent?.id ?? null);
      const cambioLaVenta =
        row.deal_status !== actual.dealStatus || row.deal_verified !== actual.dealVerified;
      if (cambioElAsignado || cambioLaVenta) return current;

      resuelto = true;
      return current.map((c) =>
        c.id === id
          ? {
              ...c,
              unreadCount: row.unread_count as number,
              manuallyUnread: row.manually_unread as boolean,
              aiEnabled: row.ai_enabled as boolean,
              status: row.status as Conversation["status"],
              lastMessageAt: row.last_message_at as string | null,
              lastMessagePreview: row.last_message_preview as string | null,
              lastMessageDirection: row.last_message_direction as Conversation["lastMessageDirection"],
              lastMessageStatus: row.last_message_status as Conversation["lastMessageStatus"],
              lastCustomerMessageAt: row.last_customer_message_at as string | null,
              journeyStage: row.journey_stage as Conversation["journeyStage"],
              intent: row.intent as string | null,
              activeTool: row.active_tool as string | null,
              welcomeSentAt: row.welcome_sent_at as string | null,
            }
          : c
      );
    });

    return resuelto;
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (payload) => {
        // Un UPDATE que se resuelve con lo que ya trae el evento no necesita
        // pedir nada. Todo lo demás —altas, bajas, o lo que arrastre
        // relaciones— sigue yendo por el refresco completo.
        if (payload.eventType === "UPDATE" && applyConversationRow(payload.new as Record<string, unknown>)) {
          return;
        }
        requestRefresh();
      });

    if (watchContactTags) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: "contact_tags" }, () => {
        requestRefresh();
      });
    }

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, channelName, watchContactTags, requestRefresh, applyConversationRow]);

  return { conversations, setConversations, refreshConversations };
}
