"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { fetchCurrentAgent } from "@/lib/data";
import { nextRealtimeAction, type RealtimeStatus } from "@/lib/realtime-status";
import { shouldShowAssignmentNotice, type AssignmentHandoffRow } from "@/lib/assignment-notice";
import "@/components/assignment-notifier.css";

// ---------------------------------------------------------------------------
// Aviso de 6 s cuando la IA me acaba de asignar una conversación (T6).
//
// La regla de negocio (¿esta fila de `conversation_handoffs` es un aviso
// para MÍ?) y el dedupe entre instancias ya viven en `assignment-notice.ts`
// (T5, módulo puro); este componente solo conecta esa regla al canal de
// realtime, resuelve quién soy y quién es el cliente, y dibuja el toast.
//
// Se monta en `AppRail`, que vive en las seis secciones — y también dentro
// de `section-skeleton.tsx`, así que durante una navegación puede haber DOS
// instancias vivas a la vez. El dedupe por id de handoff que sostiene eso es
// el `Set` de módulo de `assignment-notice.ts`: acá no se agrega ningún
// estado propio que lo pueda romper (nada de resetear el Set al montar, y
// `shouldShowAssignmentNotice` se llama UNA sola vez por fila recibida).
// ---------------------------------------------------------------------------

const NOTICE_DURATION_MS = 6000;

interface VisibleNotice {
  conversationId: string;
  /** `null` cuando la consulta del nombre del contacto falló o no volvió fila: el aviso se ve igual, con un texto neutro. */
  contactName: string | null;
}

/**
 * Quién soy, resuelto una vez por instancia.
 *
 * Se reusa `fetchCurrentAgent` (`src/lib/data.ts`) en vez de escribir la
 * consulta a mano: ya encierra la decisión no obvia de leer
 * `auth.getSession()` (la cookie, ~0 ms) en vez de `auth.getUser()`
 * (~841 ms de media contra GoTrue) — duplicar esa lógica acá la volvería a
 * arriesgar la próxima vez que alguien la toque en un solo lado. El costo es
 * una consulta más a `agents` por instancia montada (dos, durante el cruce
 * de `section-skeleton`), que es barata y no se repite: no hay caché
 * compartida entre AppRail y este aviso porque plumbear el agente actual
 * como prop rompería la premisa de "AppRail no sabe quién sos" (ver el
 * comentario de la tarea).
 */
function useMyAgentId(): string | null {
  const [agentId, setAgentId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    fetchCurrentAgent(supabase)
      .then((agent) => {
        if (!cancelled) setAgentId(agent?.id ?? null);
      })
      .catch(() => {
        // Sin agente resuelto el aviso no puede dispararse para nadie —es
        // preferible a reventar el montaje de AppRail, que vive en las seis
        // secciones— y una próxima fila simplemente sigue sin encontrar
        // dueño hasta que esto se resuelva o la instancia se vuelva a montar.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return agentId;
}

/**
 * El nombre del contacto de una conversación, para el texto del aviso.
 *
 * Mismo orden de preferencia que `data.ts:2007`
 * (`display_name ?? profile_name ?? phone_number`). Que esta consulta falle
 * —RLS, red, lo que sea— NO puede tragarse el aviso: es un requisito duro
 * (ver el test "la consulta del nombre falla"), así que cualquier error cae
 * a `null` y quien llama muestra el texto neutro en su lugar.
 */
async function fetchContactName(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("contact:contacts(display_name, profile_name, phone_number)")
      .eq("id", conversationId)
      .maybeSingle();

    if (error || !data) return null;

    const contact = (data as { contact: { display_name: string | null; profile_name: string | null; phone_number: string | null } | null }).contact;
    if (!contact) return null;

    return contact.display_name ?? contact.profile_name ?? contact.phone_number ?? null;
  } catch {
    return null;
  }
}

export function AssignmentNotifier() {
  const router = useRouter();
  const myAgentIdRef = useRef<string | null>(null);
  const myAgentId = useMyAgentId();
  const [notice, setNotice] = useState<VisibleNotice | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // El handler del canal se registra una sola vez (no depende de re-render);
  // un ref evita cerrar sobre un `myAgentId` viejo sin tener que reabrir el
  // canal cada vez que se resuelve.
  useEffect(() => {
    myAgentIdRef.current = myAgentId;
  }, [myAgentId]);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("assignment-notice")
      .on(
        "postgres_changes",
        // El filtro por `to_kind` es estático y recorta ruido (los INSERT de
        // `unassigned`/`ai`/`closed`, que son la mayoría); cuál de los
        // `to_kind: "human"` es realmente PARA MÍ lo decide
        // `shouldShowAssignmentNotice` del lado de acá, porque `to_id` es
        // dinámico (depende de quién soy) y no se puede fijar en el filtro
        // de la suscripción.
        { event: "INSERT", schema: "public", table: "conversation_handoffs", filter: "to_kind=eq.human" },
        (payload) => {
          const myId = myAgentIdRef.current;
          if (!myId) return;

          const raw = payload.new as Record<string, unknown>;
          const handoff: AssignmentHandoffRow = {
            id: String(raw.id ?? ""),
            to_kind: String(raw.to_kind ?? ""),
            to_id: raw.to_id === null || raw.to_id === undefined ? null : String(raw.to_id),
            reason: String(raw.reason ?? ""),
          };
          if (!handoff.id) return;
          if (!shouldShowAssignmentNotice(handoff, myId)) return;

          const conversationId = raw.conversation_id ? String(raw.conversation_id) : null;
          if (!conversationId) return;

          if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);

          // Se muestra de inmediato con el texto neutro, y el nombre entra
          // después si llega a tiempo: el cliente no espera a una consulta
          // extra para enterarse de que le asignaron algo.
          setNotice({ conversationId, contactName: null });
          fetchContactName(supabase, conversationId).then((contactName) => {
            if (contactName) setNotice((current) => (current?.conversationId === conversationId ? { ...current, contactName } : current));
          });

          hideTimeoutRef.current = setTimeout(() => {
            hideTimeoutRef.current = null;
            setNotice(null);
          }, NOTICE_DURATION_MS);
        }
      );

    // Mismo patrón que `crm-shell.tsx`/`use-live-conversations.ts`: no hay un
    // `realtimeStatusHandler` exportado (vive como closure local en cada
    // archivo que lo usa), así que acá se repite la misma envoltura mínima
    // sobre `nextRealtimeAction` en vez de importar algo de `crm-shell.tsx`.
    // No hay nada que resincronizar en un `resync`: este aviso no guarda una
    // lista, así que un handoff perdido durante una caída de conexión se
    // pierde igual que si el navegador hubiera estado cerrado —el mismo
    // "no persiste" que ya decidió el operador para el resto del aviso—.
    let previousStatus: RealtimeStatus | null = null;
    channel.subscribe((status) => {
      const action = nextRealtimeAction(previousStatus, status);
      previousStatus = status;
      if (action === "log_down") {
        console.warn("realtime_canal_caido", { channelName: "assignment-notice", status });
      }
    });

    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      supabase.removeChannel(channel);
    };
  }, []);

  const goToConversation = useCallback(() => {
    if (!notice) return;
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    const conversationId = notice.conversationId;
    setNotice(null);
    router.push(`/inbox?conversation=${conversationId}`);
  }, [notice, router]);

  // La región `aria-live` tiene que estar SIEMPRE montada, aunque no haya
  // aviso: un lector de pantalla anuncia MUTACIONES dentro de una región
  // viva que ya existía en el DOM, no un nodo que aparece de cero con
  // `aria-live` puesto y el texto ya adentro (NVDA/JAWS/VoiceOver
  // típicamente se quedan callados en ese caso). Por eso NO hay un
  // `if (!notice) return null` acá arriba: el contenedor vive siempre y lo
  // único que cambia es su contenido.
  return (
    <div className="an-live" aria-live="polite" aria-atomic="true">
      {notice && (
        <button type="button" className="an-toast" onClick={goToConversation}>
          <span className="an-toast-icon">
            <UserCheck size={16} />
          </span>
          <span className="an-toast-text">
            <span className="an-toast-title">Te asignaron una conversación</span>
            <span className="an-toast-detail">
              {notice.contactName ? `La IA te la pasó: ${notice.contactName}` : "La IA te la pasó."}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
