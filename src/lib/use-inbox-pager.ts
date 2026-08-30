"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cursorAfterPage, type ConversationCursor } from "@/lib/inbox-paging";
import type { ConversationSummary } from "@/lib/types";

export type InboxPageMode = "first" | "next";

export interface UseInboxPagerOptions {
  /** false = esta lista no pagina ahora: no pide nada y todo queda en no-op. */
  enabled?: boolean;
  /** Identidad del conjunto paginado. Cambiarla abre SESIÓN nueva. */
  sessionKey: string;
  /** Trae una página; cursor === null es la primera. */
  fetchPage: (cursor: ConversationCursor | null) => Promise<ConversationSummary[]>;
  /** Una página más corta que esto es la última. */
  pageSize: number;
  /** Entrega de la página vigente. "first" reemplaza; "next" se pega al final. */
  onPage: (rows: ConversationSummary[], mode: InboxPageMode) => void;
  /** Las listas que abren con su primera página resuelta en el servidor la declaran acá y el hook NO la vuelve a pedir. */
  seed?: { cursor: ConversationCursor | null; reachedEnd: boolean };
}

/**
 * `status` y `retry` vivían solo en `InboxPager` (la vista completa del
 * hook) y no en `InboxPagerView` (lo que consume `inbox-sidebar.tsx`): el
 * sidebar pintaba el fallo de primera página como si nunca hubiera pasado
 * (A.T5, revisión de código del 29/8/2026) porque ni siquiera tenía cómo
 * leerlo. Ahora la vista pública lleva los dos campos y `InboxPager` queda
 * como alias — todo pager, sembrado o no, local o de servidor, expone la
 * forma completa.
 */
export interface InboxPagerView {
  status: "loading" | "ready" | "error";
  hasMore: boolean;
  loadingMore: boolean;
  lastPageFailed: boolean;
  loadMore: () => void;
  retry: () => void;
}

export type InboxPager = InboxPagerView;

/**
 * Todo lo que decide el paginador, en un solo lugar. Ver el comentario largo
 * de `useInboxPager` más abajo para el porqué de cada campo.
 */
interface PagerState {
  status: "loading" | "ready" | "error";
  reachedEnd: boolean;
  loadingMore: boolean;
  lastPageFailed: boolean;
}

/**
 * El paginador por cursor de la bandeja, escrito una sola vez.
 *
 * Antes de esto la misma máquina vivía duplicada: `cursorRef` + flags de
 * estado sueltas en `crm-shell.tsx` (la píldora "Todos") y `serverRows` +
 * `serverSessionRef` + `serverBusyRef` en `inbox-sidebar.tsx` ("No leídas" /
 * "Mías"), cada copia endurecida a medias contra las mismas carreras. Una
 * revisión de código las encontró divergiendo el 29/8/2026 y esto es lo que
 * queda: un hook, tres consumidores.
 *
 * INVARIANTE CENTRAL — un solo ref manda. `stateRef` (más `cursorRef` y
 * `sessionRef`) es la única fuente de verdad; el `state` de React es una
 * copia para pintar. Todo cambio de estado pasa por `commit`, que escribe
 * PRIMERO `stateRef.current` y DESPUÉS llama a `setState`. Las guardas de
 * `loadMore` leen siempre del ref, nunca del `state` del render: dos eventos
 * de scroll que llegan en el mismo frame ven el mismo `state` obsoleto —React
 * no repinta entre ellos— y sin un ref síncrono los dos pasarían la guarda y
 * dispararían dos consultas con el mismo cursor (hallazgo H3 de la revisión
 * original en `inbox-sidebar.tsx`). Por eso tampoco hace falta un
 * `busyRef` aparte: `loadingMore` dentro de `stateRef` YA es el candado.
 *
 * SESIÓN (H1/H2). Cada corrida del efecto de primera página —montar, cambiar
 * `sessionKey`, `retry()` sobre un error, activar `enabled`— abre una sesión
 * nueva incrementando `sessionRef` ANTES de salir a la red. Toda respuesta
 * (de la primera página o de "cargar más") compara la sesión que capturó al
 * salir contra `sessionRef.current` vigente; si difiere, retorna sin tocar
 * ni el candado ni el estado — la sesión nueva ya es dueña de las dos cosas.
 * Sin esto, una página vieja que resuelve tarde se pega sobre datos de una
 * píldora distinta a la que la pidió (H1), o —peor— libera el candado de la
 * sesión vigente y dos peticiones en vuelo se pisan (H2, cubierto por el
 * test de "sesión abandonada").
 *
 * CLAUSURA CAPTURADA (por qué `fetchPage`/`onPage` no viven solo en
 * `optionsRef`). Las opciones se leen de un `optionsRef` actualizado en cada
 * render — así `loadMore` puede tener identidad estable sin depender de
 * closures viejas — PERO `fetchPage` y `onPage` se copian a una constante
 * local justo antes de salir a la red. La sesión decide SI la respuesta
 * entra; la clausura capturada decide DÓNDE. Sin la captura, una respuesta
 * que resuelve en el microtask que separa el render de una píldora nueva de
 * su efecto usaría el `onPage` de la píldora que ya no es, y la fila
 * terminaría pintada en el lugar equivocado aunque la sesión coincidiera.
 *
 * CURSOR LEÍDO AL LLAMAR. `loadMore` lee `cursorRef.current` de forma
 * síncrona en el momento en que se invoca (no dentro del `.then`), y la
 * respuesta escribe el cursor siguiente ANTES del `commit` que libera el
 * candado. Dos "cargar más" seguidos —el segundo disparado apenas resuelve
 * el primero, antes de que React repinte— tienen que ver cada uno el cursor
 * correcto: el ref no espera al render para estar al día, el `state` sí.
 *
 * `reachedEnd` JAMÁS se enciende en un camino de error (ni el de la primera
 * página ni el de "cargar más"): fue el origen del bug "Todo leído" en
 * producción el 29/8/2026 — una consulta que fallaba dejaba la píldora
 * "No leídas" pintando el cartel de cola vacía en vez de avisar que no pudo
 * cargar. Por eso existe `status: "error"` (para la primera página) y
 * `lastPageFailed` (para "cargar más"), cada uno con su reintento — y por
 * eso reintentar una página siguiente que falló pide la MISMA página: el
 * cursor no se movió porque la respuesta nunca llegó a actualizarlo.
 */
export function useInboxPager(options: UseInboxPagerOptions): InboxPager {
  const { sessionKey, enabled = true, seed } = options;

  // Actualizado en cada render, leído dentro de callbacks/efectos que no
  // pueden depender de `options` completo sin perder identidad estable
  // (mismo patrón que `callbackRef` en use-debounced-callback.ts).
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Se lee una sola vez, al arrancar: un pager sembrado usa `sessionKey`
  // constante (el shell no reabre sesión para su lista sembrada), así que no
  // hace falta — ni conviene — que un `seed` con nueva identidad de objeto en
  // cada render reactive nada. El valor del argumento en el primer render es
  // el único que importa.
  const hasSeedRef = useRef(seed !== undefined);

  const [state, setState] = useState<PagerState>(() =>
    seed
      ? { status: "ready", reachedEnd: seed.reachedEnd, loadingMore: false, lastPageFailed: false }
      : { status: "loading", reachedEnd: false, loadingMore: false, lastPageFailed: false }
  );

  // La fuente de verdad síncrona. Ver el comentario grande de arriba.
  const stateRef = useRef(state);
  const cursorRef = useRef<ConversationCursor | null>(seed ? seed.cursor : null);
  const sessionRef = useRef(0);

  /** Escribe el ref PRIMERO y el estado DESPUÉS. Nunca al revés. */
  const commit = useCallback((next: PagerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Reintentar un error de primera página no tiene cursor que reusar —nunca
  // hubo página—, así que no puede resolverse llamando a `loadMore()`: hace
  // falta volver a correr el efecto de primera página. Este contador es la
  // manija para eso.
  const [retryTick, setRetryTick] = useState(0);

  // PRIMERA PÁGINA + SESIÓN.
  useEffect(() => {
    // La sesión se abre ANTES de salir a la red (o de decidir que no hay red
    // que pedir): cualquier petición en vuelo de la sesión anterior queda
    // reconocida como vieja desde este instante, así resuelva mucho después.
    const session = ++sessionRef.current;

    if (!enabled) {
      // Esta lista no pagina ahora: nada que pedir, y "no hay más" para que
      // ningún `loadMore()` intente salir a la red mientras tanto. No es
      // estado derivable en el render (el `if` de arriba ya bombeó
      // `sessionRef` para invalidar cualquier pedido en vuelo de antes de
      // desactivarse): el disable es a propósito, no un atajo.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      commit({ status: "ready", reachedEnd: true, loadingMore: false, lastPageFailed: false });
      return;
    }

    if (hasSeedRef.current) {
      // La semilla ya trajo la primera página (resuelta en el servidor); el
      // estado inicial ya sale de ella. Nada que pedir acá.
      return;
    }

    commit({ status: "loading", reachedEnd: false, loadingMore: false, lastPageFailed: false });

    // Capturadas AL ARRANCAR el pedido — ver "CLAUSURA CAPTURADA" arriba.
    const { fetchPage, onPage, pageSize } = optionsRef.current;

    fetchPage(null)
      .then((rows) => {
        if (session !== sessionRef.current) return; // sesión nueva ya es dueña
        cursorRef.current = cursorAfterPage(rows);
        commit({ status: "ready", reachedEnd: rows.length < pageSize, loadingMore: false, lastPageFailed: false });
        // Primera página vacía SÍ se entrega: es la única forma de que el
        // consumidor sepa que la píldora está realmente vacía y no solo
        // "todavía sin cargar".
        onPage(rows, "first");
      })
      .catch(() => {
        if (session !== sessionRef.current) return;
        // `reachedEnd: false` a propósito — ver el comentario grande de
        // arriba sobre el bug "Todo leído". No se llama a `onPage`: las
        // filas previas o sembradas se quedan como están.
        commit({ status: "error", reachedEnd: false, loadingMore: false, lastPageFailed: false });
      });
  }, [sessionKey, enabled, retryTick, commit]);

  // Identidad estable a propósito (sin dependencias, todo sobre refs): un
  // handler de scroll del DOM que capturó `loadMore` hace rato nunca queda
  // viejo, y volver a atar el listener en cada render no hace falta.
  const loadMore = useCallback(() => {
    const current = stateRef.current;
    // status !== "ready": la primera página sigue en vuelo (H1) o falló —en
    // los dos casos no hay cursor confiable que pedir todavía.
    if (current.status !== "ready" || current.loadingMore || current.reachedEnd) return;

    // El cursor se lee AQUÍ, de forma síncrona, antes de que nada más pueda
    // cambiarlo.
    const cursor = cursorRef.current;
    const session = sessionRef.current;

    // Candado síncrono: escribir `stateRef.current` acá, antes de cualquier
    // `await`, es lo que vuelve un disparo doble del mismo frame en uno solo.
    commit({ ...current, loadingMore: true, lastPageFailed: false });

    const { fetchPage, onPage, pageSize } = optionsRef.current;

    fetchPage(cursor)
      .then((rows) => {
        if (session !== sessionRef.current) return; // sesión abandonada: no libera el candado vigente
        // El cursor avanza ANTES del commit que libera el candado: un
        // `loadMore()` disparado apenas resuelve esta promesa (antes de que
        // React repinte) tiene que ver el cursor nuevo, no el que se acaba
        // de usar.
        if (rows.length > 0) cursorRef.current = cursorAfterPage(rows);
        commit({ status: "ready", reachedEnd: rows.length < pageSize, loadingMore: false, lastPageFailed: false });
        // Página siguiente vacía NO se entrega: no hay nada nuevo que pintar
        // y evita un render de balde. La primera página es la única que se
        // entrega vacía (ver el efecto de arriba).
        if (rows.length > 0) onPage(rows, "next");
      })
      .catch(() => {
        if (session !== sessionRef.current) return;
        // El cursor NO se toca: la respuesta nunca llegó a decir cuál es la
        // siguiente, así que reintentar debe pedir la MISMA página.
        commit({ ...stateRef.current, loadingMore: false, lastPageFailed: true });
      });
  }, [commit]);

  const retry = useCallback(() => {
    if (stateRef.current.status === "error") {
      // No hay cursor que reusar: nunca hubo página. Recorre el efecto de
      // primera página completo.
      setRetryTick((t) => t + 1);
      return;
    }
    // Un error de "cargar más" sí tiene cursor: reintentar es simplemente
    // volver a pedir la misma página siguiente.
    loadMore();
  }, [loadMore]);

  return {
    status: state.status,
    hasMore: state.status === "ready" && !state.reachedEnd,
    loadingMore: state.loadingMore,
    lastPageFailed: state.lastPageFailed,
    loadMore,
    retry,
  };
}
