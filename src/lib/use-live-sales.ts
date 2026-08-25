"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Sale } from "@/lib/types";
import { fetchSales } from "@/lib/data";
import { useLiveRefresh } from "@/lib/use-live-refresh";

/**
 * La lista de ventas mantenida al día por realtime.
 *
 * No reutiliza `useLiveConversations` a propósito: aquel trabaja sobre filas
 * de bandeja y aplica en memoria los campos de bandeja (contador, vista
 * previa), que una venta no tiene. Acá el criterio es más simple: de todos
 * los eventos de `conversations`, solo interesan los que tocan una venta —
 * una fila que ya está en la lista, o una que acaba de pasar a
 * ganada/devuelta. Todo lo demás (cada mensaje del equipo, cada contador de
 * no leídos) se descarta sin pedir nada.
 */
export function useLiveSales(supabase: SupabaseClient, initialSales: Sale[]) {
  const [sales, setSales] = useState<Sale[]>(initialSales);

  const refreshSales = useCallback(async () => {
    try {
      setSales(await fetchSales(supabase));
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  const requestRefresh = useLiveRefresh(refreshSales);

  // Qué ids están en pantalla, legible desde el handler de realtime sin
  // reatar la suscripción a cada cambio de la lista.
  const saleIdsRef = useRef<Set<string>>(new Set(initialSales.map((sale) => sale.id)));
  useEffect(() => {
    saleIdsRef.current = new Set(sales.map((sale) => sale.id));
  }, [sales]);

  useEffect(() => {
    const channel = supabase
      .channel("sales-conversations")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (payload) => {
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as Record<
          string,
          unknown
        >;
        const id = typeof row.id === "string" ? row.id : null;

        // ¿El evento toca una venta? Sí, si la fila ya está en la lista (se
        // devolvió, se verificó o se eliminó) o si su estado dice que debería
        // estar (una venta nueva). El resto es tráfico de bandeja: cada
        // mensaje del equipo actualiza `conversations` y no interesa acá.
        const esVentaConocida = id !== null && saleIdsRef.current.has(id);
        const esVentaNueva = row.deal_status === "won" || row.deal_status === "returned";
        if (esVentaConocida || esVentaNueva) requestRefresh();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, requestRefresh]);

  return { sales, refreshSales };
}
