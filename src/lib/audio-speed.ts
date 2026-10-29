// Velocidad de reproducción de las notas de voz del chat (29/10/2026). Los
// asesores escuchan decenas de audios al día y pidieron acelerarlos como en
// WhatsApp: una píldora que cicla entre cinco velocidades y se recuerda por
// navegador (o sea, por asesor). Módulo PURO, sin React: el componente solo
// pinta y aplica; el ciclo, las etiquetas y la persistencia viven acá para
// poder probarlos sin montar nada.

export const AUDIO_SPEEDS = [1, 1.5, 2, 2.5, 3] as const;
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number];

/** Preferencia por visor, mismo estilo que `sbk.panel.inventario.abierto`. */
export const AUDIO_SPEED_KEY = "sbk.audio.velocidad";

/** Siguiente velocidad del ciclo; la última vuelve a 1× y un valor fuera de la lista también. */
export function nextAudioSpeed(rate: number): AudioSpeed {
  const index = AUDIO_SPEEDS.findIndex((speed) => speed === rate);
  if (index === -1) return 1;
  return AUDIO_SPEEDS[(index + 1) % AUDIO_SPEEDS.length];
}

/** Etiqueta de la píldora: punto decimal (como WhatsApp) y el signo × (U+00D7). */
export function formatAudioSpeed(rate: AudioSpeed): string {
  return `${rate}×`;
}

/** Lee la preferencia; sin valor, valor ajeno a la lista o `localStorage` roto (privado, SSR) arranca en 1×. */
export function readAudioSpeed(): AudioSpeed {
  try {
    const stored = Number(localStorage.getItem(AUDIO_SPEED_KEY));
    return AUDIO_SPEEDS.find((speed) => speed === stored) ?? 1;
  } catch {
    return 1;
  }
}

/** Guarda la preferencia; si `localStorage` falla, la velocidad solo dura lo que dure el componente. */
export function saveAudioSpeed(rate: AudioSpeed): void {
  try {
    localStorage.setItem(AUDIO_SPEED_KEY, String(rate));
  } catch {
    // Sin almacenamiento no hay recuerdo, pero tampoco error: es una comodidad.
  }
}
