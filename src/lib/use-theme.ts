"use client";

import { useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { cambiarConTransicionCircular } from "@/lib/theme-transition";

/**
 * Tema claro u oscuro, con la preferencia del sistema como punto de partida.
 *
 * Tres estados y no dos: "system" no es lo mismo que haber elegido claro. Si
 * alguien no tocó nunca el interruptor, el CRM debe seguir al sistema operativo
 * —y seguirlo también cuando este cambie al atardecer—; en cuanto elige, manda
 * su elección hasta que la borre.
 *
 * El valor efectivo se escribe como `data-theme` en <html>: es el selector que
 * usan tanto la paleta de theme.css como los componentes de HeroUI.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "liminal-theme";

/**
 * El mismo script que corre en el <head> antes del primer pintado. Vive acá
 * como texto para que la lógica de "qué tema toca" tenga una sola fuente: si
 * el script y el hook discrepan, la pantalla parpadea en la primera carga.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.dataset.theme=d?"dark":"light";e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light";}catch(_){}})();`;

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Modo incógnito o almacenamiento bloqueado: se sigue al sistema.
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/** Escribe el tema en <html>. Es lo único que ve el CSS. */
function applyTheme(theme: ResolvedTheme) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.classList.toggle("dark", theme === "dark");
  // Le dice al navegador de qué color pintar las barras de scroll, los
  // controles nativos y el fondo antes de que cargue la hoja de estilos.
  el.style.colorScheme = theme;
}

// Suscripción compartida: varios botones de tema en pantalla (la barra lateral
// vive en cada sección) tienen que moverse juntos, y un `useState` por
// componente no se entera de lo que hizo el otro.
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Los avisos externos (sistema y otra pestaña) se registran UNA sola vez por
 * página, mientras haya algún suscriptor (15/11/2026). `useTheme` tiene ahora
 * dos `useSyncExternalStore` (preferencia y tema resuelto) y suele haber varios
 * consumidores (el botón del rail, el selector de emojis): con un registro por
 * suscripción, un cambio del sistema disparaba la transición circular varias
 * veces.
 */
function suscribirAvisosExternos() {

  // Dos cosas más pueden cambiar el tema por fuera de este botón: que el
  // sistema pase a modo oscuro, y que el usuario lo cambie en otra pestaña.
  // `matchMedia` puede faltar (entornos de prueba sin polyfill); ahí se pierde
  // el primer aviso, no el interruptor.
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const onSystemChange = () => {
    if (readPreference() === "system") {
      // 15/11/2026: el cambio del sistema operativo con la página abierta
      // (atardecer) también entra por el círculo M22, desde el centro de la
      // ventana —como el laboratorio sin origen— y respetando
      // prefers-reduced-motion. El `storage` de otra pestaña de abajo NO: la
      // persona no hizo clic aquí y esa pestaña suele estar oculta.
      void cambiarConTransicionCircular(() => {
        applyTheme(systemTheme());
        flushSync(notify);
      });
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyTheme(resolveTheme(readPreference()));
    notify();
  };

  media?.addEventListener("change", onSystemChange);
  addEventListener("storage", onStorage);

  return () => {
    media?.removeEventListener("change", onSystemChange);
    removeEventListener("storage", onStorage);
  };
}

let quitarAvisosExternos: (() => void) | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) quitarAvisosExternos = suscribirAvisosExternos();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      quitarAvisosExternos?.();
      quitarAvisosExternos = null;
    }
  };
}

function getSnapshot(): ThemePreference {
  return readPreference();
}

/**
 * En el servidor no hay ni localStorage ni preferencia de sistema, así que la
 * única respuesta honesta es "la del sistema". El script del <head> ya dejó el
 * atributo correcto en <html> antes de que React hidrate, de modo que el
 * desajuste no llega a pintarse.
 */
function getServerSnapshot(): ThemePreference {
  return "system";
}

/**
 * El tema RESUELTO (claro/oscuro), con su propio snapshot de servidor.
 *
 * 15/11/2026: antes `resolved` salía de `resolveTheme(preference)`, y durante la
 * hidratación `preference` vale "system" (`getServerSnapshot`) pero `resolveTheme`
 * corre en el CLIENTE, donde `matchMedia` sí existe: con el sistema en oscuro daba
 * "dark" mientras el servidor, sin `matchMedia`, había pintado "light". El botón
 * quedaba con la etiqueta del servidor («modo oscuro») para siempre, porque el
 * render posterior calculaba lo mismo que el de la hidratación y React no volvía
 * a tocar el DOM. El render de hidratación tiene que calcular EXACTAMENTE lo que
 * el servidor ("light", el único tema que puede suponer) para que el siguiente,
 * con el snapshot de cliente, sí parchee los atributos.
 */
function getResolvedSnapshot(): ResolvedTheme {
  return resolveTheme(readPreference());
}

function getResolvedServerSnapshot(): ResolvedTheme {
  return "light";
}

export function useTheme() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const resolved = useSyncExternalStore(subscribe, getResolvedSnapshot, getResolvedServerSnapshot);

  const setPreference = useCallback((next: ThemePreference, origen?: { x: number; y: number }) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Sin almacenamiento el cambio vale para esta pestaña y nada más.
    }
    // `data-theme` queda escrito de forma SÍNCRONA dentro del callback de la
    // transición (el navegador toma la foto nueva al terminar); `flushSync`
    // deja también al estado de React (etiqueta del botón) al día en ese mismo
    // instante.
    const apply = () => {
      applyTheme(resolveTheme(next));
      flushSync(notify);
    };

    // Solo en el interruptor —los cambios que llegan del sistema o de otra
    // pestaña no ocurren delante del usuario y no hay nada que animar—. Desde
    // el 15/11/2026 es la transición circular M22 desde el botón (ver
    // `theme-transition.ts`); antes era un fundido cruzado del documento.
    void cambiarConTransicionCircular(apply, origen);
  }, []);

  return { preference, resolved, setPreference };
}
