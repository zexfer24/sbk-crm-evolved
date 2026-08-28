"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BoardConversation, ConversationSummary } from "@/lib/types";
import { useLiveRefresh } from "@/lib/use-live-refresh";

export interface UseLiveConversationsOptions<T extends BoardConversation> {
  /**
   * Qué lista mantiene viva esta vista. Recibe lo que hay en pantalla ahora y
   * devuelve lo que debe quedar: así la bandeja puede refrescar solo la
   * cabecera y conservar las páginas que el asesor bajó, en vez de volver a
   * pedir toda la ventana en cada evento.
   */
  fetcher: (current: T[]) => Promise<T[]>;
  /**
   * Trae una conversación suelta por id. Sin esto, un cambio que la fila no
   * resuelve sola (el asesor asignado, la venta) obliga a rearmar la lista
   * entera para actualizar una línea.
   */
  fetchRow?: (id: string) => Promise<T | null>;
  /**
   * Escuchar también contact_tags. Solo para las vistas que pintan etiquetas
   * (la bandeja, los reclamos del tablero): no viajan en la fila de la
   * conversación, así que su único camino es el refetch.
   */
  watchContactTags?: boolean;
  /** Nombre del canal realtime, único por vista para poder depurarlo. */
  channelName?: string;
}

export interface LiveConversations<T extends BoardConversation> {
  conversations: T[];
  /** Para los ajustes optimistas de la propia vista (marcar leído, etc.). */
  setConversations: Dispatch<SetStateAction<T[]>>;
  /** Refetch inmediato, sin agrupar: tras una mutación que no puede esperar. */
  refreshConversations: () => Promise<void>;
}

/**
 * Qué hace falta para poner al día una fila que acaba de cambiar.
 *
 * - `applied`: el evento traía todo; ya se aplicó en memoria.
 * - `row`: la fila está en la lista pero el cambio arrastra relaciones que el
 *   evento no trae (quién es el asesor, cuánto fue la venta). Alcanza con
 *   volver a pedir esa fila.
 * - `list`: la conversación no está en la lista —es nueva, o estaba fuera de
 *   la ventana cargada— y hay que preguntarle a la vista qué debe mostrar.
 */
type RowOutcome = "applied" | "row" | "list";

/**
 * La lista de conversaciones mantenida al día por realtime, al costo mínimo.
 *
 * Cada evento de realtime pedía la lista entera. Pero el evento ya trae la
 * fila nueva: cuando lo que cambió son datos propios de la conversación —el
 * contador de no leídos, la vista previa, el estado de entrega, el
 * interruptor de la IA— no hay nada que volver a pedir: se aplica y listo.
 * En la práctica eso es casi todo el tráfico.
 *
 * De lo que queda, casi todo es una fila concreta que ya está en pantalla y
 * cambió de asesor o de venta: eso se resuelve pidiendo esa fila (~1 KB).
 * Solo lo que la lista no puede ni conocer —una conversación que no estaba—
 * llega hasta el `fetcher` de la vista.
 */
export function useLiveConversations<T extends BoardConversation>(
  supabase: SupabaseClient,
  initialConversations: T[],
  {
    fetcher,
    fetchRow,
    watchContactTags = false,
    channelName = "conversations-live",
  }: UseLiveConversationsOptions<T>
): LiveConversations<T> {
  const [conversations, setConversations] = useState<T[]>(initialConversations);

  // Lo que hay en pantalla, legible desde los handlers de realtime y desde el
  // refresco sin volver a atar la suscripción en cada cambio de la lista.
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await fetcher(conversationsRef.current));
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [fetcher]);

  /** Filas concretas anotadas para volver a pedir en la próxima pasada. */
  const pendingRowIds = useRef(new Set<string>());
  /** Quedó algo que la lista no puede resolver fila por fila. */
  const pendingList = useRef(false);

  /**
   * Una pasada de puesta al día. Atiende lo anotado desde el último paso: las
   * filas sueltas si solo hubo eso, y la lista completa cuando hizo falta —o
   * cuando llega la pasada de fondo periódica, que no trae nada anotado.
   */
  const runRefresh = useCallback(async () => {
    const rowIds = [...pendingRowIds.current];
    pendingRowIds.current.clear();
    const wantsList = pendingList.current || rowIds.length === 0;
    pendingList.current = false;

    if (wantsList) await refreshConversations();

    if (rowIds.length > 0 && fetchRow) {
      try {
        const rows = await Promise.all(rowIds.map((id) => fetchRow(id)));
        const byId = new Map(rows.filter((row) => row !== null).map((row) => [row.id, row]));
        if (byId.size > 0) {
          setConversations((current) => current.map((c) => byId.get(c.id) ?? c));
        }
      } catch {
        // Lo repara la pasada de fondo.
      }
    }
  }, [refreshConversations, fetchRow]);

  const requestRefresh = useLiveRefresh(runRefresh);

  const requestListRefresh = useCallback(() => {
    pendingList.current = true;
    requestRefresh();
  }, [requestRefresh]);

  /**
   * Aplica en memoria un cambio que ya viene entero en el evento, y dice qué
   * queda por hacer cuando no alcanza.
   */
  const applyConversationRow = useCallback((row: Record<string, unknown>): RowOutcome => {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return "list";

    let outcome: RowOutcome = "list";
    setConversations((current) => {
      const actual = current.find((c) => c.id === id);
      // No está en la lista: puede ser nueva, o vieja y recién movida hacia
      // arriba. Solo la vista sabe qué le corresponde mostrar.
      if (!actual) return current;

      // Lo que no viaja en la fila: si cambió, hay que ir a buscarlo — pero
      // solo esa fila, no la lista.
      const cambioElAsignado = (row.assigned_agent_id ?? null) !== (actual.assignedAgent?.id ?? null);
      const cambioLaVenta =
        row.deal_status !== actual.dealStatus || row.deal_verified !== actual.dealVerified;
      if (cambioElAsignado || cambioLaVenta) {
        outcome = "row";
        return current;
      }

      outcome = "applied";
      // El evento trae la fila entera de `conversations`, así que se aplican
      // también los tres campos que solo pinta la bandeja: para el tablero
      // son datos de más que nunca lee, y para la bandeja son la diferencia
      // entre una vista previa al día y una vieja. De ahí el `as T`: lo que
      // sale es la fila de esta vista con algún campo extra, nunca con uno
      // de menos.
      const patch: Partial<ConversationSummary> = {
        unreadCount: row.unread_count as number,
        manuallyUnread: row.manually_unread as boolean,
        aiEnabled: row.ai_enabled as boolean,
        status: row.status as ConversationSummary["status"],
        lastMessageAt: row.last_message_at as string | null,
        lastMessagePreview: row.last_message_preview as string | null,
        lastMessageDirection: row.last_message_direction as ConversationSummary["lastMessageDirection"],
        lastMessageStatus: row.last_message_status as ConversationSummary["lastMessageStatus"],
        lastCustomerMessageAt: row.last_customer_message_at as string | null,
        hasReply: row.has_reply as boolean,
        journeyStage: row.journey_stage as ConversationSummary["journeyStage"],
        intent: row.intent as string | null,
        activeTool: row.active_tool as string | null,
        welcomeSentAt: row.welcome_sent_at as string | null,
      };

      return current.map((c) => (c.id === id ? ({ ...c, ...patch } as T) : c));
    });

    return outcome;
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (payload) => {
        if (payload.eventType === "UPDATE") {
          const outcome = applyConversationRow(payload.new as Record<string, unknown>);
          if (outcome === "applied") return;
          // Sin `fetchRow` la vista no sabe pedir de a una: se cae al refresco
          // de lista, que es como funcionaba antes de tenerlo.
          if (outcome === "row" && fetchRow) {
            const id = (payload.new as { id?: unknown }).id;
            if (typeof id === "string") {
              pendingRowIds.current.add(id);
              requestRefresh();
              return;
            }
          }
        }
        requestListRefresh();
      });

    if (watchContactTags) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: "contact_tags" }, () => {
        requestListRefresh();
      });
    }

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [
    supabase,
    channelName,
    watchContactTags,
    requestRefresh,
    requestListRefresh,
    applyConversationRow,
    fetchRow,
  ]);

  return { conversations, setConversations, refreshConversations };
}
