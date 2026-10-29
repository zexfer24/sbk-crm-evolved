# Entrega: las notas de voz se escuchan a 1.5×, 2×, 2.5× o 3× (29/10/2026)

Rama `entrega/velocidad-audio`, dos commits sobre `entrega/hotfix-canal-unico`
(`c30e5b2`). La rama trae también los dos commits del hotfix del canal
Realtime: un solo fast-forward de `main` a esta rama despliega las dos cosas.
Si el hotfix ya se desplegó, el fast-forward suma solo estos dos.

## Qué cambia

- Cada nota de voz del chat tiene, junto al reproductor, una píldora con la
  velocidad. Como en WhatsApp, cada toque pasa a la siguiente:
  1× → 1.5× → 2× → 2.5× → 3× → 1×. La voz no cambia de tono, porque el
  navegador conserva el tono de fábrica.
- La velocidad se recuerda por asesor en su navegador (`localStorage`, clave
  `sbk.audio.velocidad`) y se aplica a los audios que abra después. Sin
  almacenamiento (navegación privada) arranca en 1× y no falla.
- «Reintentar» conserva la velocidad. Se fijan `defaultPlaybackRate` y
  `playbackRate` y se vuelven a aplicar en `loadedmetadata`, porque el
  navegador los devuelve a 1 con cada `src` nuevo.
- Con el audio caído, la píldora no aparece; la pantalla de error no cambia.
- En escritorio la píldora va al lado del reproductor. En pantallas angostas
  (celular, ventana a media pantalla) baja a la derecha, dentro de la burbuja.

Archivos:
- `src/lib/audio-speed.ts` (nuevo, puro)
- `AudioContent` en `src/components/chat/message-bubble.tsx`
- `.crm-audio` y `.crm-audio-speed` en `src/components/crm.css`

## Los cinco puntos

1. **Commits:** dos, ninguno con `[migración]`. Uno es la funcionalidad con
   sus tests; el otro, este reporte.
2. **Migraciones:** ninguna.
3. **Variables de entorno:** ninguna.
4. **UI:** solo código de cliente. Rebuild completo.
5. **Verificado:**
   - **Suite completa:** 5679 tests en verde.
   - **`tsc`:** sin errores.
   - **Lint:** 0 errores; los 7 avisos ya existían y ninguno sale de los
     archivos tocados.
   - **Build:** `npm run build` con BUILD_ID nuevo.
   - **Tests escritos primero, en rojo:**
     - ciclo de velocidades, etiquetas y lectura y guardado de la preferencia
       (valores raros y `localStorage` que lanza);
     - la burbuja: arranque, ciclo, preferencia guardada, velocidad tras
       Reintentar, sin píldora con error y reaplicación en `loadedmetadata`;
     - la hoja de estilos de la fila.
   - **Mutaciones:** quitar el efecto que aplica la velocidad pone 3 tests en
     rojo; quitar `onLoadedMetadata`, 1.
   - **Chromium real (Playwright) sobre el CRM local** con una nota de voz de
     prueba, a 1440, 900 y 390 px:
     - la píldora cicla las cinco velocidades;
     - el `<audio>` toma cada una (`playbackRate` y `defaultPlaybackRate`);
     - la elección sobrevive a una recarga;
     - reproducir 1 s a 2× avanzó ~1,7 s del audio;
     - la píldora queda siempre dentro de la burbuja;
     - no hubo errores en consola.

## Lo que ya estaba y sigue igual

En pantallas angostas el reproductor (mínimo de 300 px, para que los controles
nativos no se deformen) ya sobresalía unos píxeles de la burbuja antes de este
cambio. No se tocó: la píldora no lo empeora.
