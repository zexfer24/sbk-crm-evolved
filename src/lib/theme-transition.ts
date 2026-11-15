/**
 * El cambio de tema como la M22 del «Laboratorio de movimiento» de Liminal CRM
 * V3 (15/11/2026, pedido del operador; referencia: `Base/src/motion.js`,
 * `applyTheme`). `document.startViewTransition` congela la pantalla vieja y, en
 * `ready`, un `clip-path` circular revela la nueva creciendo desde el botón
 * hasta la esquina más lejana de la ventana. La regla global de `theme.css`
 * (`::view-transition-old/new(root) { animation: none }`) apaga el fundido
 * cruzado por defecto: este círculo es el único movimiento. Antes (hasta el
 * 15/11/2026) `use-theme.ts` llamaba a `startViewTransition` solo para ese
 * fundido.
 *
 * Sin la API, o con `prefers-reduced-motion: reduce`, el cambio es directo. El
 * Next 16.3 de este repo no activa `experimental.viewTransition`, así que nada
 * más usa `startViewTransition` y la regla global no choca con otra transición.
 */

/** Los tres números de M22: no se tocan sin tocar también la referencia. */
export const DURACION_CLIP_TEMA_MS = 620;
export const EASING_CLIP_TEMA = "cubic-bezier(.65,0,.35,1)";
export const PSEUDOELEMENTO_TEMA = "::view-transition-new(root)";

type ConViewTransitions = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<unknown>; finished: Promise<unknown> };
};

export function prefiereMenosMovimiento(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Corre `aplicar` (que debe dejar el tema escrito en el DOM de forma SÍNCRONA:
 * el navegador toma la foto nueva en cuanto el callback termina) dentro de una
 * View Transition circular con centro en `origen` (por defecto, la ventana).
 * Nunca lanza: si la transición se salta, `aplicar` igual ya corrió.
 */
export function cambiarConTransicionCircular(
  aplicar: () => void,
  origen?: { x: number; y: number }
): Promise<void> {
  const doc = document as ConViewTransitions;
  if (typeof doc.startViewTransition !== "function" || prefiereMenosMovimiento()) {
    aplicar();
    return Promise.resolve();
  }

  const x = origen?.x ?? innerWidth / 2;
  const y = origen?.y ?? innerHeight / 2;
  // Distancia a la esquina más lejana: el círculo termina de cubrir la ventana.
  const radio = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  const transicion = doc.startViewTransition(aplicar);
  return transicion.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radio}px at ${x}px ${y}px)`] },
        { duration: DURACION_CLIP_TEMA_MS, easing: EASING_CLIP_TEMA, pseudoElement: PSEUDOELEMENTO_TEMA }
      );
      return transicion.finished;
    })
    .then(() => undefined)
    .catch(() => undefined);
}
