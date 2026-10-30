# Entrega «Precio divisa desde SAINT» (30/10/2026)

Rama `entrega/precio-divisa`, partida de `main` = `a1db46c`. Lleva **UNA migración** (`20261030010000_precio_divisa_saint.sql`) y ninguna variable de entorno nueva. Toca la base (una función), la UI y los tests.

Qué hace: muestra el **Precio divisa** (`SAPROD.Precio1` de SAINT, en dólares) en `/inventario`, con las columnas en el orden Precio promoción · Precio divisa · Precio estándar, y en el buscador de inventario del panel del chat (bloque «Divisa» entre Promoción y Estándar). Si no hay dato (sin `saint_code`, sin fila en `saprod`, `precio1` nulo o en 0) se muestra «Sin precio en SAINT», nunca `$ 0.00`. La caja también lo ve.

Es solo informativo. No pasa por la tasa BCV, no se agrega al carrito y no lo usan Seba, la factura ni «Facturar en SAINT».

## ⚠ Orden: la migración ANTES que el código

`PRODUCT_SELECT` pide el campo `precio_divisa_usd`. Si el código llega a `main` sin la migración, PostgREST responde 400 y **dejan de cargar `/inventario`, el buscador del chat, el carrito y los presupuestos**. Por eso se entrega en rama: aplicar la migración primero y recién después hacer fast-forward de `main` (push a `main` despliega solo).

**No aplicar `20261028010000`** («Facturar en SAINT», teléfono opcional) junto con esta. Sigue esperando la confirmación de LiminalReplicant. Esta migración no depende de ella: aplicar SOLO `20261030010000`.

## ⚠ Paso 0, antes de aplicar (solo lectura)

```sql
-- 1. ¿Qué saprod existe? La función lee saint.saprod si existe y, si no, public.saprod (igual que saint.sync_products).
select to_regclass('saint.saprod') as saint_saprod, to_regclass('public.saprod') as public_saprod;

-- 2. Moneda de precio1 (sobre la tabla que exista).
select codprod, descrip, precio1, precio3, round(precio3 / nullif(precio1, 0), 2) as relacion_p3_p1
from public.saprod where precio1 is not null and precio1 > 0 order by codprod limit 20;
select count(*) total, count(*) filter (where precio1 is null) nulos, count(*) filter (where precio1 = 0) ceros from public.saprod;

-- 3. Permisos de saprod y rol del agente.
select table_schema, grantee, string_agg(privilege_type, ', ' order by privilege_type)
from information_schema.role_table_grants where table_name = 'saprod' group by 1, 2;
select usename, application_name, client_addr from pg_stat_activity where usename is not null and backend_type = 'client backend';
```

Cómo leerlo:
- **`relacion_p3_p1` ronda la tasa del día (cientos o miles):** `precio1` está en USD. Seguir.
- **`precio1` y `precio3` del mismo orden de magnitud:** `precio1` está en bolívares. **NO aplicar** y avisar al operador: haría falta `SACONF.Factor`, que hoy no se replica.
- **`precio1` no existe, o es nulo en todos:** **NO aplicar** y avisar. Hay que reaprovisionar la columna del lado de LiminalReplicant. Técnicamente la migración funcionaría igual (todo saldría «Sin precio en SAINT»), pero no tiene sentido desplegarla así.
- **El agente escribe con el rol `anon` o `authenticated`:** **NO aplicar** sin avisar. La sección 2 de la migración revoca todo sobre `saprod` a esos dos roles y cortaría la réplica. Con `postgres`, `service_role` u otro rol propio, aplicar tranquilo.

## Pasos en el VPS

1. El Paso 0.
2. Aplicar con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261030010000_precio_divisa_saint.sql`.
   - Es re-ejecutable: `create or replace` y revokes.
   - Trae guarda propia: sin `-1` (o sin `lock_timeout`) aborta con un mensaje explícito.
   - Al final se autoverifica (función `security definer`; `anon` no la ejecuta; `saprod` sin SELECT/INSERT/UPDATE/DELETE para `anon` ni `authenticated`) y avisa a PostgREST con `notify pgrst`.
   - Debe imprimir `NOTICE: 20261030010000: cerrada <tabla> a anon y authenticated.` y la autoverificación correcta.
3. Comprobar (solo lectura):
   ```sql
   select p.saint_code, p.name, public.precio_divisa_usd(p) as divisa, s.precio1
   from products p join public.saprod s on s.codprod = p.saint_code
   where p.is_active and s.precio1 > 0 order by p.saint_code limit 3;   -- divisa = round(precio1, 2)
   select has_table_privilege('anon', 'public.saprod', 'select'),          -- false
          has_table_privilege('authenticated', 'public.saprod', 'select'); -- false
   ```
   Y confirmar que **la réplica sigue escribiendo**: cambiar un precio en SAINT y ver que llega a `saprod` en segundos.
4. Recién entonces: fast-forward de `main` a `entrega/precio-divisa` (despliega solo). **Toca la UI: rebuild completo.**

## Verificación en producción (después del deploy)

- `/inventario` abre sin error. En 3 productos con código, el Precio divisa coincide con `Precio1` de la ficha de SAINT (lo compara el operador).
- Un producto sin código, o con `precio1` nulo o en 0, dice «Sin precio en SAINT».
- En un chat, el buscador de inventario muestra el bloque «Divisa».
- Sin sesión: `curl -s "$URL/rest/v1/saprod?select=codprod&limit=1" -H "apikey: $ANON"` responde 42501 (permiso denegado).
- Frescura: el valor se lee en vivo de `saprod` en cada carga y en cada búsqueda. Si cambia `Precio1` en SAINT, se ve al recargar. No hay Realtime, a propósito: exigiría darle a `authenticated` permiso de lectura directo sobre `saprod`.
- Costo: es una función plpgsql por fila de la página. Si `/inventario` se nota más lento, medir como `authenticated` (no como superusuario, ver la trampa del 21/9 en CLAUDE.md):
  `explain analyze select id, public.precio_divisa_usd(p) from products p order by name limit 50;`

## Reversa

- **El código:** revertir `ef25ce8` y desplegar ANTES de tocar la función; sin la función, el código nuevo da 400.
- **La función:** `drop function public.precio_divisa_usd(public.products);` (solo después de revertir el código).
- **Los permisos de `saprod`:** si la réplica dejó de escribir por el revoke, volver a dar al rol del agente lo que tenía según el Paso 0 (`grant ... on public.saprod to <rol>`).

## Commits

### `51d86ce` [migración] La base expone el precio divisa de SAINT y cierra saprod a quien no tiene sesión
1. Migración: **sí**, `supabase/migrations/20261030010000_precio_divisa_saint.sql`. Va ANTES del código.
2. Variables de entorno: no.
3. UI: no. Es solo base, y PostgREST recarga con el `notify pgrst` del final.
4. Verificado en local, con `supabase/tests/precio_divisa_usd.sql` (12 casos):
   - sin tabla; tabla sin `precio1`;
   - redondeo a 2 decimales (12,3456 → 12,35); nulo; 0 y negativo devueltos tal cual (la UI los oculta);
   - sin fila; sin código;
   - como agente, caja y `service_role` da el valor; un autenticado sin fila en `agents` recibe nulo; `anon` sin EXECUTE;
   - `saint.saprod` gana a `public.saprod`;
   - re-ejecución idempotente que revoca lo que se había concedido.

   El test se escribió primero y falló sin la migración. También se probó por PostgREST con una `saprod` de prueba:
   - `anon` recibe 42501 sobre `saprod` y sobre la función;
   - un agente con sesión ve 18,46 / nulo / 0,00;
   - el agente tampoco lee `saprod` directa.

   Mutaciones:
   - cambiar `can_read_inventory()` por `true` → rojo;
   - quitar el revoke a `anon` → rojo en el guardián `permisos-funciones.test.ts`. En la base local la función no hereda un grant explícito a `anon`, así que ahí ese revoke es redundante. El guardián es lo que lo exige.

### `ef25ce8` El inventario y el buscador del chat muestran el precio divisa de SAINT
1. Migración: no, pero **exige la de arriba aplicada**.
2. Variables de entorno: no.
3. UI: **sí**, rebuild completo.
4. Verificado:
   - Suite completa: 257 archivos, 5692 tests en verde. `tsc` sin errores. Lint con 0 errores (las 7 advertencias ya estaban).
   - Mutaciones: tratar el 0 como precio → rojo; mover la columna después del estándar → rojo.
   - Playwright sobre el build de producción, con datos de prueba en local, a 1366, 1000 y 390 px, como agente y como caja:
     - las columnas quedan alineadas en todas las filas y la página no desborda;
     - sin errores de consola en `/inventario`;
     - la caja ve Promoción y Divisa, pero no Estándar;
     - en el panel del chat sale «Divisa $ 18.46» o «Sin precio en SAINT», sin botón de agregar.
   - La columna nueva mide **110px y no 150px**: con 150px el nombre del producto quedaba en 118 px a 1366 y en 84 px a 1000. Con 110px queda en 158 y 124 px.

## Hallazgo aparte (no lo introduce esta entrega)

Un usuario de **caja** que abre `/inbox?conversation=<id>` dispara el error **React #441**. Se reprodujo idéntico en `a1db46c` (antes de esta entrega), sobre el build de producción. `/inventario` como caja queda limpio. Queda pendiente de diagnosticar aparte.
