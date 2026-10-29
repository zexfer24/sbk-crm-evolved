# Entrega «Facturar en SAINT» (28/10/2026)

Rama `entrega/facturar-en-saint`, partida de `main` = `a01e29d`, con la rama `entrega/carrito-opciones-cotizacion` (`e7f3332`, sin migración, su nota es `docs/entregas/2026-10-28-carrito-opciones-cotizacion.md`) unida adentro. Lleva **UNA migración** y ninguna variable de entorno nueva. Toca la base (RPC), la UI y los tests.

**Orden real (29/10/2026, decisión del operador): el código va a `main` ANTES que la migración.** Es seguro porque el código funciona con la RPC del 25/10:
- un envío con el teléfono vacío lo rechaza la RPC vieja con «Teléfono inválido.», antes de que llegue al agente, y el asesor ve ese aviso;
- el contacto se actualiza como hasta hoy (solo la cédula, si faltaba), aunque el modal ya diga que el nombre y la cédula quedan guardados;
- todo lo demás (pasos, pie, «Qué copiar», carrito de cotización) no depende de la migración.

La migración se aplica **después**, y solo cuando LiminalReplicant confirme el teléfono vacío (ver el bloqueante).

Qué hace: el botón «Enviar a SAINT» pasa a llamarse «Facturar en SAINT» en los tres sitios donde aparece (carrito del chat, presupuestos del cliente en el panel del chat y «Presupuestos guardados» de /inventario). El carrito del chat se reordena para que el camino visible sea armar → facturar en SAINT → cerrar: indicador de tres pasos, pie pegado con el total y el botón negro, y «Qué copiar» plegado con el contador «N de 7». «Cerrar venta» baja a secundario mientras no haya factura creada en SAINT, así que nunca hay dos botones negros a la vez. El teléfono deja de ser obligatorio para facturar, y cada envío actualiza el nombre y la cédula del contacto.

Decisiones:
- **Teléfono opcional.** Vacío es válido y se guarda como cadena vacía (`''`), nunca `null`. Si trae algo, se sigue exigiendo el formato (`^\+?[0-9]{7,19}$`). **Depende de LiminalReplicant** (ver el bloqueante abajo).
- **El último envío gana.** Cada envío sobrescribe `display_name`, `cedula_type` y `cedula_number` del contacto (antes: solo la cédula, y solo si faltaba, y solo desde el carrito). El contacto sale de `conversations.contact_id` (carrito) o de `presupuestos.contact_id` (presupuesto). **El teléfono del contacto nunca se toca**: es la llave de WhatsApp.
- **La caja puede facturar presupuestos.** La RPC sigue `security invoker`: la caja actualiza 0 filas de `contacts` por RLS y el envío sale sin error. Se acepta a propósito: la caja factura, no edita clientes.

## ⚠ Bloqueante de despliegue: LiminalReplicant

Antes de **aplicar la migración**, confirmar en el repo LiminalReplicant que el agente **acepta `telefono = ''` al crear el cliente en SAINT**. El agente recibe el teléfono, y nada en este repo confirma que lo tolere vacío.

- Si lo acepta: aplicar la migración (pasos abajo).
- Si lo rechaza: **no aplicar la migración**. Con ella, cada envío sin teléfono llegaría al agente y quedaría en `error`. Hay que corregir el agente primero. Mientras tanto, el código desplegado sigue funcionando con la RPC vieja: el asesor tiene que escribir el teléfono.

## ⚠ Duda abierta: qué número es `numero_saint`

La columna `liminal.saint_borradores.numero_saint` la escribe el agente al terminar un envío `creado`. **Se asume que es el número del documento EN ESPERA** (el que SAINT asigna al crear la factura en espera), no el de la factura fiscal. La UI la muestra como «En SAINT como N» y la usa en la confirmación de reenvío.

El paso 3 («Cerrar») sigue pidiendo el número de la factura a mano, así que el asesor puede tener dos números distintos en la misma venta. Antes de dar por cerrado el texto de la UI, confirmar con el operador y con LiminalReplicant cuál de los dos número es el que devuelve el agente. Si es el fiscal, el texto «En SAINT como N» y la confirmación de reenvío cambian de sentido y hay que corregirlos.

## ⚠ Antes de aplicar: prerequisito y comprobaciones (solo lectura)

Esta entrega va encima de `20261025010000` («Enviar a SAINT»). Antes de nada, confirmar que esa migración ya está aplicada:

```sql
-- 1. ¿Existe la cola y la RPC de la versión de 25/10 (7 parámetros)?
select to_regclass('liminal.saint_borradores') is not null as cola,
       exists (select 1 from pg_proc where proname = 'enviar_borrador_saint' and pronargs = 7) as rpc;
-- Esperado: cola = true, rpc = true. Si cualquiera es false, aplicar primero la entrega del 25/10.
```

## Pasos en el VPS

El código ya llegó a `main`, y con eso a producción (ver «Entrega por rama»). Lo que queda en el VPS es la migración, cuando se cumpla el bloqueante:

1. La comprobación de arriba.
2. Aplicar con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261028010000_saint_telefono_opcional_y_contacto.sql`.
   - Es re-ejecutable (`create or replace`).
   - La migración tiene una guarda propia: sin `-1` (o sin `lock_timeout`) aborta con un mensaje explícito, a propósito.
   - Verificación posterior:
     ```sql
     -- La función sigue con 7 parámetros, y solo authenticated y service_role la ejecutan.
     select has_function_privilege('anon', 'public.enviar_borrador_saint(text, uuid, text, text, text, text, text)', 'EXECUTE'),          -- false
            has_function_privilege('authenticated', 'public.enviar_borrador_saint(text, uuid, text, text, text, text, text)', 'EXECUTE'), -- true
            pg_get_functiondef('public.enviar_borrador_saint(text, uuid, text, text, text, text, text)'::regprocedure) like '%display_name%'; -- true
     ```
3. No hace falta redesplegar: la migración solo cambia la RPC, y PostgREST recarga el esquema con el `notify pgrst` del final.

## Verificación en producción (después del deploy)

- **Envío sin teléfono, con el agente encendido y en el SAINT de pruebas** (`docs/saint/aceptacion-saint-pruebas.md`):
  - desde el carrito de un chat, facturar con el teléfono vacío;
  - en la base, la fila nueva tiene `telefono = ''` y llega a `creado` (o, si el agente lo rechaza, a `error` con su motivo):
    ```sql
    select id, telefono, estado, nombre, apellido, cedula_tipo, cedula_numero, numero_saint, error
      from liminal.saint_borradores order by created_at desc limit 5;
    ```
- **El contacto se actualiza y el teléfono no:**
  ```sql
  select display_name, cedula_type, cedula_number, phone_number from contacts where id = '<contact_id>';
  ```
  El `display_name` y la cédula coinciden con lo que tipeó el asesor, y `phone_number` no cambió.
- **Caja:** facturar un presupuesto con un usuario `caja`. El envío sale sin error y el contacto no cambia (la RLS descarta el UPDATE).
- **Carrito del chat a 268 px:** el pie con el total y «Facturar en SAINT» queda visible y el texto no se corta.
- **Antes de la migración** (lo que hay justo después del deploy): un envío con el teléfono vacío muestra «Teléfono inválido.» y no deja fila. Con el teléfono escrito, el envío sale como el 25/10.

Si el agente de producción sigue con `Borradores:Enabled=false`, los envíos quedan en `pendiente` y a los 2 minutos la UI muestra «SAINT no responde». Revisar y cancelar los pendientes viejos antes de encenderlo, como en la entrega del 25/10.

## Commits (`a01e29d..` HEAD de la rama)

| # | Commit | Migración | Variables de entorno | UI / servidor |
|---|---|---|---|---|
| 1 | `6def482` [migración] Facturar en SAINT acepta el teléfono vacío y deja el nombre y la cédula en el cliente | **Sí**, `20261028010000_saint_telefono_opcional_y_contacto.sql` (+ `supabase/tests/saint_telefono_opcional_y_contacto.sql`, `supabase/tests/saint_borradores.sql` ajustado y los dos pasos de CI en `.github/workflows/ci.yml`) | No | Solo base |
| 2 | `b618caf` El carrito del chat lleva a «Facturar en SAINT» con el total siempre a la vista | No (usa la 1) | No | UI + cliente; glosario y `CLAUDE.md` van en este commit |
| 3 | `799cd34` Este reporte (primera versión) | No | No | Solo docs |
| 4 | `e7f3332` Carrito de cotización del Inventario (otra rama, ver su nota) | No | No | UI |
| 5 | `44038a8` Unión de las dos ramas | No | No | UI + tests |
| 6 | Este reporte (orden real y verificación) | No | No | Solo docs |

Rebuild completo: cambia el bundle del cliente.

## Qué cambia

- **Base:**
  - `enviar_borrador_saint(...)` (misma firma de 7 parámetros, `security invoker`):
    - acepta teléfono vacío y lo guarda como `''`;
    - sobrescribe `display_name` (nombre y apellido ya recortados), `cedula_type` y `cedula_number` del contacto en cada envío;
    - nunca toca el teléfono del contacto.
  - La tabla `liminal.saint_borradores` NO cambia: sigue `telefono not null`, porque es un contrato con el agente.
- **UI:**
  - Botón «Facturar en SAINT» en los tres sitios, con la prop `variante` (`primary` en el carrito, `secondary` en las tarjetas de presupuestos).
  - Modal: el teléfono es opcional; la validación sigue el formato solo si trae algo.
  - Carrito del chat:
    - indicador de tres pasos (Armar / En espera en SAINT / Cerrar), calculado por `pasosDeVenta` (`src/lib/panel-venta.ts`);
    - pie sticky con el total y «Facturar en SAINT»;
    - atajos Copiar, Al chat y Guardar;
    - «Qué copiar» plegado, con el contador «N de 7» (`contarCamposCopia`).
  - Tarjeta de cada renglón en dos columnas: cantidad y precio c/u a la izquierda, subtotal y Bs a la derecha; el toggle Promoción/Estándar a todo el ancho.
  - `context-panel` llama UNA sola vez a `useBorradoresSaint` y pasa el último envío al bloque del carrito y a «Cerrar venta» (`varianteCerrarVenta`: secundario mientras haya carrito sin envío `creado`).
- **Puro (nuevo):** `src/lib/panel-venta.ts` con `pasosDeVenta`, `varianteCerrarVenta` y `contarCamposCopia`.

## Verificado

En local, el 29/10/2026, sobre la rama ya unida (`44038a8`):
- `rtk npm run test`: 5655 tests en verde (254 archivos).
- `rtk npx tsc --noEmit`: sin errores.
- `rtk npm run lint`: 0 errores (7 warnings viejos de otros tests).
- `rtk proxy npm run build`: compila, con `BUILD_ID` nuevo.
- Mutaciones, cada una con su test en rojo: teléfono obligatorio otra vez, pie sin `sticky`, paso 2 hecho con `pendiente` y «Cerrar venta» siempre `primary`.
- Vista en el navegador del carrito del chat a 300 px, en claro y oscuro:
  - pasos en cada estado;
  - pie pegado al hacer scroll por 6 renglones; ahí se vio y se corrigió una franja de 20 px por debajo, que ahora fija un test de hoja;
  - «Qué copiar» abierto con su vista previa;
  - el modal con «Teléfono (opcional)».

**Lo que NO se pudo verificar en local:** Docker Desktop no arrancaba en la máquina. Los tests SQL (`saint_telefono_opcional_y_contacto.sql` y `saint_borradores.sql`) se corrieron en un Postgres de ensayo, sin el Supabase local, y ahí pasaron, incluidas dos mutaciones. El CI del push a `main` los repite contra la base reconstruida desde cero: **mirar que esos dos pasos queden verdes.**

## Entrega por rama

El operador pidió el push a `main` el 29/10/2026. Como el código es compatible con la RPC vieja (ver arriba), el orden quedó así:
1. `git push origin entrega/facturar-en-saint:main`. **Esto despliega** (Dokploy), sin la migración.
2. Mirar el CI de ese push: los pasos `saint_borradores` y `saint_telefono_opcional_y_contacto` tienen que quedar verdes.
3. Confirmar el bloqueante de LiminalReplicant.
4. El VPS corre las comprobaciones y aplica la migración (pasos arriba).

## Lo que NO se probó

- **El agente real.** El envío sin teléfono no se probó contra LiminalReplicant: hasta confirmarlo, el bloqueante de arriba manda.
- **El número de la espera contra el número fiscal.** Está asumido, no medido (ver la duda abierta).
- **Realtime sobre la línea de estado en producción.** Confirmar tras el deploy que la línea de estado cambia sola con un `UPDATE` de prueba, como en la entrega del 25/10.
