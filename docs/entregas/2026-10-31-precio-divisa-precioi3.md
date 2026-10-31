# Hotfix «El precio divisa sale de PrecioI3» (31/10/2026)

Rama `entrega/precio-divisa-precioi3`, partida de `main` = `ac4dc1d`. Lleva **UNA migración** (`20261031020000_precio_divisa_precioi3.sql`) y ninguna variable de entorno nueva. No cambia la lógica de la app: en `src/` solo se corrigen comentarios.

Qué corrige: el precio divisa de SAINT (USD) es **`SAPROD.PrecioI3`**, no `Precio1`, que en SAINT vale 0 en los productos. La migración `20261030010000` leía `precio1`, así que todo producto con código salía «Sin precio en SAINT». `PrecioI3 = Precio3 / tasa` lo calcula y lo guarda SAINT; el CRM lo muestra tal cual, redondeado a 2 decimales (`1.500` → `$ 1.50`). Fuente: el traspaso de LiminalReplicant del 31/10/2026.

La firma de `public.precio_divisa_usd(products)` no cambia, y `PRODUCT_SELECT` ya la pide desde `20261030010000`. Por eso **esta migración no tiene orden respecto del código**: se puede aplicar antes o después del deploy. Lo único que exige es que `20261030010000` ya esté aplicada.

## Migraciones del rango

Producción estaba en `a1db46c` (dicho por el operador el 30/10). Confirmar el commit de producción (`<produccion>`) y calcular:

```bash
git diff --name-only <produccion>..entrega/precio-divisa-precioi3 -- supabase/migrations
```

Con `a1db46c` salen tres, que se aplican **en este orden**:

1. `20261030010000_precio_divisa_saint.sql`: puede estar ya aplicada. Si no, seguir `docs/entregas/2026-10-30-precio-divisa.md`.
2. `20261031010000_fotos_de_productos.sql`: va ANTES del código de fotos. Seguir `docs/entregas/2026-10-31-fotos-de-repuestos.md`.
3. `20261031020000_precio_divisa_precioi3.sql`: esta.

`20261028010000` («Facturar en SAINT») sigue fuera: espera a LiminalReplicant.

## ⚠ Paso 0, antes de aplicar (solo lectura)

El operador está agregando `PrecioI3` a la réplica.

```sql
-- 1. ¿Qué saprod existe? La función usa saint.saprod si existe y, si no, public.saprod.
select to_regclass('saint.saprod') as saint_saprod, to_regclass('public.saprod') as public_saprod;

-- 2. ¿Llegó PrecioI3? (sobre la tabla que exista; abajo, public.saprod)
select count(*) as total,
       count(precioi3) as con_precioi3,
       count(*) filter (where precioi3 > 0) as mayor_a_0
from public.saprod;

select codprod, precio3, precioi3 from public.saprod where codprod = 'D8TC-CHAMPION';

-- 3. ¿Ya está la función de la entrega anterior? Debe salir true.
select to_regprocedure('public.precio_divisa_usd(public.products)') is not null as precio_divisa_aplicada;
```

Cómo leerlo:
- **Esperado:** `mayor_a_0` cerca de `total`, y la bujía con `precio3 = 1650` y `precioi3 = 1.5` (o el valor de la tasa del día).
- **No existe la columna `precioi3`, o `mayor_a_0` sale en 0 o muy bajo:** **NO aplicar** y avisar al operador. La réplica todavía no está lista. Aplicada así, la migración no rompería nada (todo saldría «Sin precio en SAINT», igual que hoy), pero no tiene sentido. **No compensarlo calculando `precio3 / tasa`.**
- **`precio_divisa_aplicada` = false:** aplicar primero `20261030010000` según su reporte.
- **Copiar el resultado del Paso 0 en la respuesta al operador.** Es un criterio de aceptación del traspaso.

## Pasos en el VPS

1. El Paso 0.
2. Aplicar `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261031020000_precio_divisa_precioi3.sql`.
   - Es re-ejecutable: `create or replace` más revokes.
   - Sin `-1`, la guarda aborta con un mensaje explícito.
   - Vuelve a revocar todo sobre `saprod` a `anon` y `authenticated`, porque si el agente recreó la tabla en `public`, los default privileges de Supabase se lo devuelven. No toca el rol del agente (`liminal_replicator`).
   - Se autoverifica: `security definer`; `anon` sin EXECUTE; `saprod` cerrada; y el cuerpo de la función dice `precioi3` y no `precio1`. Termina con `notify pgrst`.
3. Comprobar (solo lectura):
   ```sql
   select p.saint_code, p.name, public.precio_divisa_usd(p) as divisa, s.precio3, s.precioi3
   from products p join public.saprod s on s.codprod = p.saint_code
   where p.saint_code = 'D8TC-CHAMPION'
      or p.saint_code in (select codprod from public.saprod where precioi3 > 0 order by codprod limit 2);
   -- divisa = round(precioi3, 2); D8TC-CHAMPION -> 1.50
   select has_table_privilege('anon', 'public.saprod', 'select'),          -- false
          has_table_privilege('authenticated', 'public.saprod', 'select'); -- false
   ```
4. Deploy: fast-forward de `main` a `entrega/precio-divisa-precioi3` y deploy manual. Si producción sigue en `a1db46c`, este deploy lleva también el precio divisa y las fotos: aplicar sus migraciones antes (sección «Migraciones del rango»). **Toca la UI** (las fotos y el precio divisa): rebuild completo.

## Verificación en producción

- `D8TC-CHAMPION` muestra «Divisa $ 1.50» en `/inventario` y en el buscador del chat.
- En otros 2 productos con código, el Precio divisa coincide con la tercera casilla de «Precio 3» de la ficha de SAINT (lo compara el operador).
- Un producto sin código, y uno con `precioi3` nulo o en 0, dicen «Sin precio en SAINT», sin errores de consola.
- Cambiar un precio en SAINT: se ve al recargar. No hay Realtime, a propósito: exigiría dar a `authenticated` lectura directa sobre `saprod`.
- Sin sesión: `curl -s "$URL/rest/v1/saprod?select=codprod&limit=1" -H "apikey: $ANON"` responde 42501.

Formato: la app pinta «$ 1.50» (con espacio), el mismo formato del resto de precios en dólares del inventario. El traspaso pedía «$1.50»: es la misma cifra, y se mantuvo el formato de la casa.

## Reversa

`psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261030010000_precio_divisa_saint.sql` vuelve a dejar la función leyendo `precio1`. Es re-ejecutable y el código no cambia.

## Commits

### `626e07b` [migración] El precio divisa sale de PrecioI3 de SAINT, no de Precio1
1. Migración: **sí**, `supabase/migrations/20261031020000_precio_divisa_precioi3.sql`. Sin orden respecto del código; exige `20261030010000` aplicada.
2. Variables de entorno: no.
3. UI: no (base sola; `notify pgrst` al final).
4. Verificado en local con `supabase/tests/precio_divisa_usd.sql`:
   - Con la función vieja, 12 aserciones en rojo. Con la nueva, todas en verde (lo corrió también el orquestador).
   - Casos nuevos: una tabla con `precio1 = 99` y sin `precioi3` da null. La bujía con `precio1 = 0` y `precioi3 = 1.500` da `1.50`. Un `precio1 = 99` que queda en la tabla se ignora.
   - El test reaplica las dos migraciones en orden, dos veces, para medir la idempotencia.
   - Mutación: volver a `precio1` en el `execute` hace abortar la autoverificación de la propia migración, y el test da rojo.
   - El guardián `permisos-funciones.test.ts` sigue en verde: es la misma función.

### `dad8028` Los comentarios, CLAUDE.md y el glosario dicen que el precio divisa es PrecioI3
1. Migración: no.
2. Variables de entorno: no.
3. UI: no hay cambio visible; el diff de `src/` son solo comentarios.
4. Verificado: `tsc` sin errores; lint con 0 errores (las 7 advertencias ya estaban); `inventory`, `producto-fila`, `inventory-lookup` y `permisos-funciones`: 4 archivos, 237 tests en verde.

### Este reporte
Solo documentación.
