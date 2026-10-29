"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchUltimosBorradores } from "@/lib/saint-borradores-data";
import { borradorDesdeFila, type BorradorSaint, type FilaBorradorSaint, type OrigenSaint } from "@/lib/saint-borradores";
import { nombreCanalUnico } from "@/lib/realtime-channel-name";
import { nextRealtimeAction, type RealtimeStatus } from "@/lib/realtime-status";

/**
 * El ÚLTIMO envío a SAINT de cada origen, en vivo (25/10/2026, plan "Enviar a
 * SAINT", T3). Un agente externo pasa el borrador de `pendiente` a
 * `procesando` y luego a `creado` o `error`; el asesor lo ve cambiar aquí sin
 * recargar porque `liminal.saint_borradores` está en la publicación
 * `supabase_realtime` (esquema `liminal`, no `public`).
 *
 * Con UN id el canal filtra por `origen_id`; con varios (la lista de
 * presupuestos) filtra por `origen` y el hook descarta en memoria los ids que
 * no pidió: un filtro `in.(…)` con 50 uuids no vale la pena. Un evento solo
 * reemplaza al actual si es del mismo envío o de uno posterior
 * (`createdAt >=`): el UPDATE de un envío viejo que llega tarde no puede
 * pisar un reenvío más nuevo.
 *
 * `ahora` se refresca cada 15 s SOLO mientras algún borrador siga
 * `pendiente`, para que "SAINT no responde" aparezca sin que nadie haga nada
 * (`estaSinRespuesta`). Con nada pendiente no hay intervalo.
 *
 * Corre en el navegador: los fallos van a `console.error`, nunca a
 * `lib/log.ts`.
 */

const REFRESCO_AHORA_MS = 15_000;
const VACIO: Map<string, BorradorSaint> = new Map();

interface Estado {
  /** A qué conjunto de ids pertenece `mapa`: una carga de otro conjunto no se expone. */
  clave: string;
  mapa: Map<string, BorradorSaint>;
}

/** Fusiona dos envíos del mismo origen: gana el más nuevo; a igual `createdAt`, el recién llegado. */
function fusionar(actual: Map<string, BorradorSaint>, nuevos: Iterable<BorradorSaint>): Map<string, BorradorSaint> {
  const siguiente = new Map(actual);
  for (const b of nuevos) {
    const previo = siguiente.get(b.origenId);
    if (!previo || new Date(b.createdAt).getTime() >= new Date(previo.createdAt).getTime()) {
      siguiente.set(b.origenId, b);
    }
  }
  return siguiente;
}

export function useBorradoresSaint(
  origen: OrigenSaint,
  origenIds: string[],
): { porOrigen: Map<string, BorradorSaint>; ahora: Date; recargar: () => void } {
  // Ids estables: ordenados, sin repetidos ni vacíos, como UNA cadena. Un arreglo
  // nuevo con el mismo contenido (cada render lo es) no reabre el canal.
  const clave = [...new Set(origenIds.filter((id) => id !== ""))].sort().join(",");

  const [estado, setEstado] = useState<Estado>({ clave: "", mapa: VACIO });
  const [ahora, setAhora] = useState(() => new Date());
  const [recarga, setRecarga] = useState(0);

  const recargar = useCallback(() => setRecarga((n) => n + 1), []);

  function aplicar(clave: string, nuevos: BorradorSaint[]) {
    setEstado((prev) => ({
      clave,
      mapa: fusionar(prev.clave === clave ? prev.mapa : VACIO, nuevos),
    }));
    setAhora(new Date());
  }

  // Lectura: al montar, al cambiar de conjunto, con `recargar()` y al
  // reconectar el canal. Efecto inline con `.then()/.catch()` y bandera
  // `cancelado` (trampa de `react-hooks/set-state-in-effect`, CLAUDE.md
  // 22/9/2026).
  useEffect(() => {
    if (clave === "") return;
    let cancelado = false;
    fetchUltimosBorradores(createClient(), clave.split(","))
      .then((cargados) => {
        if (!cancelado) aplicar(clave, [...cargados.values()]);
      })
      .catch((error) => {
        console.error("saint_borradores_no_cargados", error);
      });
    return () => {
      cancelado = true;
    };
    // `aplicar` solo toca setters estables de React.
  }, [clave, recarga]);

  // Canal: solo depende del conjunto de ids, para que `recargar()` no lo cierre
  // y reabra (los eventos de ese hueco se perderían).
  useEffect(() => {
    if (clave === "") return;
    const ids = clave.split(",");
    const conjunto = new Set(ids);
    let cancelado = false;
    const supabase = createClient();

    // Un solo id: filtro exacto. Varios: por tipo de origen y se filtra aquí.
    const filter = ids.length === 1 ? `origen_id=eq.${ids[0]}` : `origen=eq.${origen}`;
    // Nombre ÚNICO por suscripción (29/10/2026): /inventario monta este hook dos
    // veces con el mismo origen e id y realtime-js devuelve el canal que ya
    // existe con ese topic, donde `.on()` lanza. Ver `realtime-channel-name.ts`.
    const nombre = nombreCanalUnico(
      `saint-borradores-${origen}-${ids.length === 1 ? ids[0] : `${ids.length}-${ids[0].slice(0, 8)}`}`,
    );
    let anterior: RealtimeStatus | null = null;
    const channel = supabase
      .channel(nombre)
      .on(
        "postgres_changes",
        { event: "*", schema: "liminal", table: "saint_borradores", filter },
        (payload: { new: unknown }) => {
          if (cancelado) return;
          const fila = payload.new as FilaBorradorSaint | null;
          if (!fila || typeof fila.origen_id !== "string") return;
          const borrador = borradorDesdeFila(fila);
          if (borrador.origen !== origen || !conjunto.has(borrador.origenId)) return;
          aplicar(clave, [borrador]);
        },
      )
      .subscribe((status: string) => {
        const accion = nextRealtimeAction(anterior, status as RealtimeStatus);
        anterior = status as RealtimeStatus;
        if (accion === "log_down") {
          console.warn("realtime_canal_caido", { channelName: nombre, status });
        } else if (accion === "resync") {
          // Lo que cambió mientras el canal no escuchaba: se vuelve a leer.
          setRecarga((n) => n + 1);
        }
      });

    return () => {
      cancelado = true;
      supabase.removeChannel(channel);
    };
    // `aplicar` solo toca setters estables de React.
  }, [clave, origen]);

  const porOrigen = estado.clave === clave ? estado.mapa : VACIO;
  const hayPendiente = [...porOrigen.values()].some((b) => b.estado === "pendiente");

  useEffect(() => {
    if (!hayPendiente) return;
    const intervalo = setInterval(() => setAhora(new Date()), REFRESCO_AHORA_MS);
    return () => clearInterval(intervalo);
  }, [hayPendiente]);

  return { porOrigen, ahora, recargar };
}
