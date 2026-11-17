"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchSebaV2Config } from "@/lib/data";
import { fetchPendingSuggestion } from "@/lib/shadow-data";
import { resolveSuggestion } from "@/lib/mutations";
import { shadowDraftFromRow, suggestionExpired, suggestionVisible, type ShadowDraft } from "@/lib/shadow";
import { nombreCanalUnico } from "@/lib/realtime-channel-name";
import { nextRealtimeAction, type RealtimeStatus } from "@/lib/realtime-status";
import type { SebaV2Mode } from "@/lib/seba-v2-config";
import type { Agent } from "@/lib/types";

/**
 * La sugerencia de copiloto de la conversación abierta (entrega 3 de Seba v2,
 * 17/11/2026). En modo `copiloto` Seba v2 redacta el turno completo y NO lo
 * envía: lo guarda en `agent_shadow_drafts` para que el asesor lo envíe, lo
 * edite o lo descarte. Este hook trae el último borrador de copiloto del chat,
 * lo mantiene al día por Realtime y decide cuándo se ve.
 *
 * Con cualquier otro modo NO consulta ni se suscribe: un chat de un asesor no
 * paga una lectura ni un canal por una función apagada. El modo se lee UNA vez
 * al montar (cambiarlo desde Control IA se nota al recargar la bandeja, igual
 * que otras lecturas de configuración del chat).
 *
 * Reglas (ver `shadow.ts`): se ve solo si está pendiente, tiene menos de 10
 * minutos y ningún asesor escribió después de ella. Una sugerencia pendiente que
 * deja de cumplirlo se marca «vencida» —una sola vez, y si falla solo se anota—
 * para que otro asesor que abra el chat no la vea. Corre en el navegador: los
 * fallos van a `console.error`, nunca a `lib/log.ts`.
 */

/** Cada cuánto se recalcula si la sugerencia sigue vigente (el plazo es de 10 min). */
const TICK_MS = 30_000;

interface LoadedDraft {
  conversationId: string;
  draft: ShadowDraft | null;
}

export interface SebaSuggestionApi {
  /** La sugerencia a mostrar, o `null` si no hay (o ya no vale). */
  draft: ShadowDraft | null;
  /** El asesor pulsó «Editar» y todavía no envió. */
  editing: boolean;
  /** La sugerencia ya se resolvió por otra vía (enviada, descartada): sácala de la vista. */
  hide: () => void;
  /** «Editar»: la tarjeta queda en estado editando. */
  beginEdit: () => void;
  /** El asesor envió desde el composer: si estaba editando, la sugerencia queda «editada». */
  notifyAdvisorSent: () => void;
}

export function useSebaSuggestion({
  conversationId,
  agent,
  lastAgentMessageAt,
}: {
  conversationId: string;
  agent: Agent;
  /** Fecha del último mensaje REAL de un asesor en este chat (no notas internas). */
  lastAgentMessageAt: string | null;
}): SebaSuggestionApi {
  // `undefined` = leyendo; `null` = no se pudo leer (falla cerrado: sin sugerencia).
  const [modo, setModo] = useState<SebaV2Mode | null | undefined>(undefined);
  const [loaded, setLoaded] = useState<LoadedDraft | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** Borradores sobre los que ya se intentó resolver algo: nunca dos veces el mismo. */
  const attempted = useRef(new Set<string>());

  const enabled = modo === "copiloto";

  // El modo, una sola vez. Efecto inline con `.then()` y bandera `cancelado`
  // (react-hooks/set-state-in-effect, CLAUDE.md 22/9/2026).
  useEffect(() => {
    let cancelado = false;
    fetchSebaV2Config(createClient())
      .then((config) => {
        if (!cancelado) setModo(config?.modo ?? null);
      })
      .catch((error: unknown) => {
        console.error("No se pudo leer el modo de Seba v2 para la sugerencia:", error);
        if (!cancelado) setModo(null);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  // Lectura: al activarse, al cambiar de chat y al reconectar el canal.
  useEffect(() => {
    if (!enabled) return;
    let cancelado = false;
    fetchPendingSuggestion(createClient(), conversationId)
      .then((draft) => {
        if (cancelado) return;
        setLoaded({ conversationId, draft });
        setNow(new Date());
      })
      .catch((error: unknown) => {
        console.error("No se pudo leer la sugerencia de Seba:", error);
      });
    return () => {
      cancelado = true;
    };
  }, [enabled, conversationId, reload]);

  // Realtime: un borrador nuevo, o el UPDATE de uno (otro asesor lo resolvió).
  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const nombre = nombreCanalUnico(`seba-suggestion-${conversationId}`);
    let cancelado = false;
    let anterior: RealtimeStatus | null = null;

    const channel = supabase
      .channel(nombre)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_shadow_drafts", filter: `conversation_id=eq.${conversationId}` },
        (payload: { new: unknown }) => {
          if (cancelado) return;
          const row = payload.new as Record<string, unknown> | null;
          if (!row || typeof row.id !== "string") return;
          const incoming = shadowDraftFromRow(row);
          if (incoming.modo !== "copiloto") return;
          setLoaded((prev) => {
            const current = prev?.conversationId === conversationId ? prev.draft : null;
            // Un evento de un borrador MÁS VIEJO que el actual (llegó tarde) no lo pisa.
            if (
              current &&
              current.id !== incoming.id &&
              new Date(current.createdAt).getTime() > new Date(incoming.createdAt).getTime()
            ) {
              return prev;
            }
            return { conversationId, draft: incoming };
          });
          setNow(new Date());
        }
      )
      .subscribe((status: string) => {
        const accion = nextRealtimeAction(anterior, status as RealtimeStatus);
        anterior = status as RealtimeStatus;
        if (accion === "log_down") {
          console.warn("realtime_canal_caido", { channelName: nombre, status });
        } else if (accion === "resync") {
          // Lo que cambió mientras el canal no escuchaba: se vuelve a leer.
          setReload((n) => n + 1);
        }
      });

    return () => {
      cancelado = true;
      supabase.removeChannel(channel);
    };
  }, [enabled, conversationId]);

  // El reloj: el plazo de 10 minutos se recalcula cada 30 s.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  const current = loaded?.conversationId === conversationId ? loaded.draft : null;

  // Una pendiente que ya no vale (plazo cumplido o un asesor se le adelantó) se
  // marca «vencida» para que no la vea otro asesor. Una sola vez por borrador.
  useEffect(() => {
    if (!enabled || !current) return;
    if (attempted.current.has(current.id)) return;
    if (!suggestionExpired(current, { now, lastAgentMessageAt })) return;
    attempted.current.add(current.id);
    resolveSuggestion(createClient(), agent, current.id, "vencida").catch((error: unknown) => {
      console.error("No se pudo marcar la sugerencia como vencida:", error);
    });
  }, [enabled, current, now, lastAgentMessageAt, agent]);

  const draft = useMemo(() => {
    if (!enabled || !current) return null;
    if (hiddenIds.has(current.id)) return null;
    return suggestionVisible(current, { now, lastAgentMessageAt }) ? current : null;
  }, [enabled, current, hiddenIds, now, lastAgentMessageAt]);

  const hide = useCallback(() => {
    if (!current) return;
    attempted.current.add(current.id);
    setHiddenIds((prev) => new Set(prev).add(current.id));
    setEditingId((id) => (id === current.id ? null : id));
  }, [current]);

  const beginEdit = useCallback(() => {
    if (current) setEditingId(current.id);
  }, [current]);

  const notifyAdvisorSent = useCallback(() => {
    if (!editingId) return;
    const id = editingId;
    attempted.current.add(id);
    setHiddenIds((prev) => new Set(prev).add(id));
    setEditingId(null);
    resolveSuggestion(createClient(), agent, id, "editada").catch((error: unknown) => {
      console.error("No se pudo marcar la sugerencia como editada:", error);
    });
  }, [editingId, agent]);

  return { draft, editing: draft !== null && editingId === draft.id, hide, beginEdit, notifyAdvisorSent };
}
