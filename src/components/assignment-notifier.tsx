"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@heroui/react";
import { createClient } from "@/lib/supabase/client";
import { fetchCurrentAgent } from "@/lib/data";
import { nextRealtimeAction, type RealtimeStatus } from "@/lib/realtime-status";
import { shouldShowAssignmentNotice, type AssignmentHandoffRow } from "@/lib/assignment-notice";

// ---------------------------------------------------------------------------
// Aviso cuando la IA me acaba de asignar una conversación (T6, 8/9/2026).
//
// 10/9/2026: pasó de un toast casero (`.an-toast`, `position: fixed; right;
// bottom`) al `toast()` de HeroUI — el operador no lo veía: medido en el
// navegador, se dibujaba a los 200 ms del INSERT pero abajo a la derecha,
// 6 s, sin el nombre del contacto (llegaba después por una consulta aparte).
// El pedido fue calcarlo del toast de "sticker guardado": arriba a la
// derecha, con nombre desde el primer render y más tiempo en pantalla. Acá
// ya está montado `Toast.Provider placement="top end"`
// (`src/app/layout.tsx:57`), así que este componente deja de dibujar nada
// propio y solo empuja al queue global de HeroUI — de ahí que ya no exista
// `assignment-notifier.css` ni la región `aria-live` a mano: el
// `Toast.Provider` trae la suya.
//
// La regla de negocio (¿esta fila de `conversation_handoffs` es un aviso
// para MÍ?) y el dedupe entre instancias siguen viviendo en
// `assignment-notice.ts` (T5, módulo puro) y no se tocan acá. El dedupe
// sigue siendo IMPRESCINDIBLE con HeroUI igual que con el toast casero: el
// `Set` de MÓDULO (no de instancia) es lo único que evita un `toast()`
// doble cuando `AppRail` está montado dos veces a la vez durante una
// navegación (vive también en `section-skeleton.tsx`) — cambiar de toast no
// cambió ese problema, solo quién lo pinta.
// ---------------------------------------------------------------------------

const NOTICE_TIMEOUT_MS = 10000;

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
  // `router` de `useRouter()` es estable entre renders en la práctica, pero
  // el patrón del archivo (ver `myAgentIdRef`) es dejar SIEMPRE un ref al
  // día en vez de confiar en eso a ojo: el efecto del canal se abre una
  // sola vez (`[]`) y no puede depender de un valor que cambie de render.
  const routerRef = useRef(router);

  useEffect(() => {
    myAgentIdRef.current = myAgentId;
  }, [myAgentId]);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

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

          // A diferencia del toast casero (que se mostraba de inmediato con
          // texto neutro y el nombre entraba después), acá se espera el
          // nombre ANTES de llamar a `toast()`: es una consulta de
          // milisegundos y HeroUI no tiene forma de "actualizar la
          // descripción" de un toast ya en pantalla sin parpadeo — pedirle
          // el dato primero es más simple que mutar un toast vivo.
          void fetchContactName(supabase, conversationId).then((contactName) => {
            toast("Te asignaron una conversación", {
              description: contactName ? `La IA te pasó a ${contactName}` : "La IA te pasó una conversación",
              timeout: NOTICE_TIMEOUT_MS,
              variant: "accent",
              actionProps: {
                children: "Abrir",
                onPress: () => routerRef.current.push(`/inbox?conversation=${conversationId}`),
              },
            });
          });
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
      supabase.removeChannel(channel);
    };
  }, []);

  // Ya no hay nada propio que dibujar: el `Toast.Provider` de HeroUI
  // (`src/app/layout.tsx:57`) es quien pinta el toast y su propia región
  // `aria-live`. Este componente es puramente un conector de efectos —igual
  // que antes, pero sin dejar un nodo en el DOM.
  return null;
}
