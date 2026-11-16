# Hotfix «El build no le pide nada a Google Fonts» (16/11/2026)

Rama `entrega/fuentes-locales`, partida de `entrega/paneles` = `8308b37`. **No lleva migración** ni
variable de entorno nueva. Toca solo `src/app/layout.tsx` y agrega `src/app/fuentes/` (tres `woff2` y sus
licencias OFL). Es lo que destraba el despliegue: el build de producción está roto desde el 8/11/2026.

## Antes de desplegar

1. **Confirmar con el operador en qué commit está producción** (`<produccion>`) y si el deploy sigue
   siendo manual. Esta rama va encima de `entrega/paneles`: desplegarla es desplegar también los
   paneles, y sus migraciones M1–M4 y el relleno van antes, según `docs/entregas/2026-11-15-paneles.md`
   y `docs/PRODUCCION.md` §20. Lista del rango:
   `git diff --name-only <produccion>..entrega/fuentes-locales -- supabase/migrations`.
2. **Si hay que reconstruir producción ANTES de que entren los paneles** (por ejemplo, otro hotfix sobre
   `main`), el arreglo sirve igual: `main` (`2fff563`) tiene el mismo `layout.tsx` y el mismo fallo.
   Llevarlo a `main` es tomar de este commit solo `src/app/layout.tsx`, `src/app/fuentes/` y
   `src/app/fuentes.test.ts` (los tres se aplican limpios sobre `2fff563`); `CLAUDE.md`, el glosario y
   este reporte viajan con los paneles.
3. **El build tiene que correr sin caché** la primera vez (`--no-cache` o equivalente en Dokploy): con la
   caché de un build viejo, un build verde no prueba nada (ver «Causa raíz»).

## Commits

| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | el commit que trae este reporte: «El build deja de pedirle las fuentes a Google y vuelve a compilar en frío» | No | No | Build (las fuentes que ve el usuario no cambian) |

Costo de despliegue: **rebuild completo (~5 min)**. El corte de ~22 s al recrear el contenedor es el de
siempre.

## Causa raíz (demostrada)

- `next/font/google` descarga las fuentes **en el build**. El Turbopack de Next 16.3.1 mete la URL de
  cada `woff2` dentro de la query de un módulo interno y después la parte por `&`.
- Google sirve las fuentes de dos formas: `https://fonts.gstatic.com/s/familjengrotesk/v11/….woff2` (sin
  `&`) o `https://fonts.gstatic.com/l/font?kit=…&skey=…&v=v11` (con `&`). Con la segunda, la query sale
  con varias entradas y el build cae con `next/font/google queries have exactly one entry` /
  `Can't resolve '@vercel/turbopack-next/internal/font/google/font'`, en `familjen_grotesk_*.module.css`.
- Qué forma sirve Google depende del servidor que conteste y del momento. En local, el mismo commit
  falló a las 10:25 y pasó a las 10:58 del 16/11; el VPS lo ve en cada build desde el 8/11. Los builds
  verdes con `.next/cache` llena no volvían a pedir las fuentes y por eso lo escondían.
- Reproducido a voluntad con el mecanismo de pruebas del propio Next (`NEXT_FONT_GOOGLE_MOCKED_RESPONSES`):
  el mismo CSS de Google con URLs `/s/` compila; con URLs `/l/font` da exactamente el error de producción.

## Salidas descartadas

- `next build --webpack`: el loader de Webpack tiene el mismo punto ciego (`TypeError … reading '1'` en
  `loader.js:122` con una URL `/l/font`), y además Webpack choca con el `Toast` de HeroUI en `layout.tsx`.
- Subir Next: 16.3.8 sigue fallando; 16.4.6 sí compila con `/l/font`, pero es un salto de versión menor y
  el build seguiría dependiendo de Google en cada deploy. Queda como mejora aparte, opcional.

## Qué cambia

1. `src/app/fuentes/`: `geist-latin.woff2`, `geist-mono-latin.woff2` y `familjen-grotesk-italic-latin.woff2`.
   Son **los mismos bytes** que el build precargaba desde Google (sha256 fijados en el test), con sus
   `OFL-*.txt`.
2. `layout.tsx` usa `next/font/local` con las **mismas tres variables CSS** (`--font-geist-sans`,
   `--font-geist-mono`, `--font-familjen-grotesk`). Geist y Geist Mono declaran `100 900`; Familjen,
   itálica `500 700`, que reproduce las caras 500/600/700 de antes.
3. El build ya no sale a internet por las fuentes: ni `fonts.googleapis.com` ni `fonts.gstatic.com`.
4. `src/app/fuentes.test.ts` rechaza cualquier import de `next/font/google` en `src/` y fija los sha256.

## Lo que el operador ya sabe

- Solo viaja el subconjunto **latino**, el que ya se precargaba. La interfaz no escribe ninguna letra fuera
  de él. Una letra de latín extendido, vietnamita o cirílico en un nombre o mensaje de cliente (Ł, Ş, Đ…)
  se ve en la fuente de respaldo (Arial ajustada) en vez de Geist. Decisión aprobada el 16/11/2026.
- Los nombres internos de las familias cambian (`geistSans` en vez de `Geist`); ninguna hoja los usa,
  solo las variables.

## Verificación hecha

- **Build en frío** (`.next` borrada entera): `rtk proxy npm run build` exit 0, `.next/BUILD_ID` del
  16/11 11:54:35, los tres `woff2` emitidos como precargados.
- **Build en frío con Google respondiendo `/l/font`** (respuesta simulada): antes del arreglo, el error
  exacto de producción; después, exit 0 (`BUILD_ID` 11:56:36).
- `fuentes.test.ts`: rojo 4/4 antes del cambio, verde después. Mutaciones: una variable renombrada y el
  import de Google de vuelta ponen rojo el test que corresponde.
- Suite completa: 309 archivos, 6644 tests en verde (los 4 nuevos incluidos). `tsc` sin errores. Lint
  0 errores (8 avisos `no-unused-vars` viejos, ninguno en archivos de esta entrega).
- **Capturas antes/después** (build de producción, Playwright, 1440×900): login en claro y en oscuro con
  **0 píxeles distintos**; una página de muestra con Geist, Geist Mono y Familjen itálica en todos los
  pesos que usa la app, idéntica en todas las líneas latinas. Solo difieren las letras fuera del latín
  (el respaldo de arriba).

## Verificación posterior al deploy

1. **El build del VPS pasa sin caché**, sin `queries have exactly one entry` en el log.
2. **Cierre del diagnóstico** (opcional, solo lectura): desde el VPS, ver qué forma de URL le sirve Google:
   ```bash
   curl -s -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36' 'https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@1,500;1,600;1,700&display=swap' | grep -o 'gstatic.com/[sl]/' | sort | uniq -c
   ```
   Si sale `l/`, es la causa. Con este arreglo da igual lo que responda.
3. **En el navegador** (DevTools → Network → Font): las tres fuentes llegan de `/_next/static/media/`
   (`geist_latin…`, `geist_mono_latin…`, `familjen_grotesk_italic_latin…`) y ninguna de `fonts.gstatic.com`.
   El título del login («SBK Motors CRM») y el de los paneles salen en la itálica de siempre.
4. Consola del navegador y logs del contenedor sin errores nuevos.

## Reversa

No hay migración que revertir. Volver a la imagen anterior si Dokploy la conserva: reconstruir el
commit anterior vuelve a depender de lo que responda Google.
