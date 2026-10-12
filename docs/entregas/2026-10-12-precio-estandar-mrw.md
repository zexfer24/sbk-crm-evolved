# Entrega "Precio promoción y precio estándar (envío MRW)", 12/10/2026

Para el Claude del VPS. **No se pushea a `main` directo**: un push a `main`
despliega solo (Dokploy), pero no aplica la migración, y si el código llega
antes que la base, Inventario y el carrito del chat se rompen
(`tarifa_envio_usd` no existiría → 400 de PostgREST).

La rama es **`entrega/precio-estandar-mrw`**, partida de **`5799edd`**, el
commit de producción medido el 12/10/2026. **Antes de nada, confirmar que
producción sigue en `5799edd`.** Si hay otras ramas de entrega fusionadas
entretanto (`hotfix/360dialog-fila` sale de `5799edd` en paralelo), esta
rama se rebasa o fusiona encima. No toca ningún archivo de 360dialog.

## Qué hay en la rama

```
480140a [migración] La tarifa de envío MRW vive en la base y cada producto la calcula por su peso
ad37f28 El Inventario muestra el precio promoción y el precio estándar con el envío MRW
6477ca8 La entrega del precio estándar MRW queda escrita paso a paso para el VPS
b5f9a70 [migración] La tarifa MRW de todo el catálogo se calcula en 0,35 s en vez de 2 s
697c025 Un peso guardado en 0 cuenta como sin peso en el badge, el filtro y el contador
+ esta nota actualizada (punta de la rama)
```

**Es UNA sola migración**, `20261012010000_precio_estandar_mrw.sql`. `b5f9a70`
la edita in situ porque todavía no se aplicó en ningún lado salvo la base
local. Se aplica el archivo de la punta de la rama, una sola vez.

## Commit por commit

### 480140a + b5f9a70 — migración `20261012010000_precio_estandar_mrw.sql`

- Crea la extensión `btree_gist` si no existe y la tabla `public.shipping_rates`:
  `id`, `carrier` (default `'mrw'`), `desde_kg` (incluido), `hasta_kg`
  (excluido), `tarifa_usd > 0`, `updated_at` y `updated_by` (`auth.uid()`).
  - Checks: `hasta_kg > desde_kg` y `desde_kg >= 0`.
  - Exclusión gist: dos tramos del mismo `carrier` no se solapan.
- RLS: `select` con `is_agent()`; `insert`/`update`/`delete` con
  `is_supervisor_or_admin()`. `anon` queda sin acceso.
- Siembra los 34 tramos de MRW tal cual, incluida la baja de 14,70 → 13,91 en
  43 kg (P1).
- `tarifa_mrw_usd(numeric)` es **`security definer`**: null sin peso, con
  peso ≤ 0 o ≥ 80, o si quien la llama tiene sesión (`authenticated`) y no
  es agente. `service_role` y `postgres` reciben la tarifa.
- El campo calculado `tarifa_envio_usd(products)` es la misma tarifa sobre
  `weight_kg`. Es `invoker` y **sin `set search_path` a propósito**, para que
  Postgres la pueda inlinear; usa nombres calificados.
- Las dos funciones llevan los dos revokes (`public`, `anon`) y el grant a
  `authenticated` y `service_role`. `tarifa_mrw_usd` entra a los dos
  guardianes de funciones `security definer`, que pasan de 28 a 29.
- **Por qué (medido):** con 6.155 productos, la mitad con peso, como
  `authenticated`, calcular la tarifa de todo el catálogo tardaba 1,8–2,1 s
  con la primera versión (dos `invoker` con `search_path`), porque cada
  producto pagaba la RLS `is_agent()` de cada uno de los 34 tramos. Con esta
  versión tarda 0,35–0,48 s. Una página de Inventario (40 filas) queda en
  57–77 ms, contra 51–64 ms sin el campo.
- Termina con `notify pgrst, 'reload schema'`.
- No toca `products`, `enforce_products_read_only()` ni el cron de Saint.
- Trae la guarda de `lock_timeout`: sin `-1` aborta.

### ad37f28 — código (sin migración)

- `Product.shippingFeeUsd`; `PRODUCT_SELECT` pide `tarifa_envio_usd`.
  `PRODUCT_SELECT` lo usa también `fetchCart` (`data.ts`) dentro de un embed
  `product:products(...)`: verificado en local que PostgREST lo acepta.
- `standardPriceDisplay` (`inventory.ts`) suma la tarifa; la tabla no se
  duplica en TypeScript.
- La fila de Inventario muestra "Precio promoción" y "Precio estándar".
- El texto del contador y del badge "Sin peso" dice también que sin peso no
  hay precio estándar.

### 697c025 — código (sin migración)

- Un peso guardado en 0 cuenta como "sin peso" en el badge, el filtro y el
  contador. Antes solo contaba null, mientras el precio estándar ya decía
  "Cargá el peso".
  - Regla única: `sinPeso` (`inventory.ts`) y `SIN_PESO_FILTRO`
    (`inventory-data.ts`).
  - **Cambio visible:** el contador "Sin peso" de producción puede subir si
    hay productos con peso 0 guardado.

## Cómo aplicar (en este orden)

1. Respaldo de la base, como siempre.
2. **Permiso de la extensión.** Confirmar que el rol con el que se aplica
   puede crear `btree_gist`:
   `select * from pg_available_extensions where name = 'btree_gist';`
   - Si ya está instalada, `create extension if not exists` no hace nada.
   - Si el rol no puede crearla, crearla antes como `supabase_admin` y
     avisarme.
3. Simulacro:
   ```
   psql ... -v ON_ERROR_STOP=1 <<'SQL'
   begin;
   \i supabase/migrations/20261012010000_precio_estandar_mrw.sql
   select count(*) from public.shipping_rates;                  -- 34
   select public.tarifa_mrw_usd(1.000), public.tarifa_mrw_usd(43); -- 1.40 | 13.91
   rollback;
   SQL
   ```
   El archivo usa `set local`: dentro de `begin` la guarda pasa. Si el `\i`
   no resuelve la ruta en el contenedor, ver la trampa de `docker cp` en
   CLAUDE.md.
4. Aplicación:
   `psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261012010000_precio_estandar_mrw.sql`.
5. Verificación contra la base real:
   ```sql
   select count(*), min(desde_kg), max(hasta_kg) from shipping_rates;      -- 34 | 0.001 | 80.000
   select count(*) filter (where public.tarifa_envio_usd(p) is not null) as con_tarifa,
          count(*) filter (where weight_kg > 0) as con_peso
   from products p where is_active;                                         -- iguales (todos < 80 kg)
   select has_function_privilege('anon', 'public.tarifa_mrw_usd(numeric)', 'execute');           -- false
   select has_function_privilege('authenticated', 'public.tarifa_envio_usd(public.products)', 'execute'); -- true
   select proname, prosecdef, proconfig from pg_proc
   where proname in ('tarifa_mrw_usd', 'tarifa_envio_usd');
   -- tarifa_mrw_usd: t | {search_path=public};  tarifa_envio_usd: f | (null)
   ```
   Para medir el costo real con el volumen de producción (opcional,
   solo lectura), dentro de una transacción:
   ```sql
   begin;
   set local role authenticated;
   set local "request.jwt.claim.sub" = '<id de un asesor>';
   set local "request.jwt.claims" = '{"sub":"<id de un asesor>","role":"authenticated"}';
   explain analyze select count(public.tarifa_envio_usd(p)) from products p;
   rollback;
   ```
   En local, con 6.155 productos (la mitad con peso), da 0,35–0,48 s.
   Y por PostgREST, con la llave de servicio:
   `GET /rest/v1/products?select=name,weight_kg,tarifa_envio_usd&weight_kg=gt.0&limit=3`
   tiene que traer la tarifa, no un 400. Si da 400, la caché del esquema no
   se recargó: `notify pgrst, 'reload schema';`.
6. Recién después, fast-forward de `main` a la rama (eso despliega).
7. En Inventario, un producto con peso muestra los dos precios. Uno sin peso
   dice "Cargá el peso".

**Reversa** (si hiciera falta, después de volver `main` al commit anterior):
`drop function public.tarifa_envio_usd(public.products); drop function
public.tarifa_mrw_usd(numeric); drop table public.shipping_rates;`. La
extensión puede quedar.

## Resultados

- **Test SQL `supabase/tests/precio_estandar_mrw.sql`** (sumado al CI): pasa
  sobre la base local con la migración.
  - Rojo antes de la migración; rojo con la mutación `p_peso < hasta_kg` →
    `<=`.
  - Cubre los 14 bordes del documento, null/0/80, cobertura `[0.001, 80)`
    sin huecos y 34 tramos, rechazo de un solape, RLS y el ejemplo
    1 kg → 1.40.
    - RLS: el asesor lee 34 filas; su UPDATE/DELETE afectan 0 filas y su
      INSERT da 42501. El supervisor actualiza.
    - El campo calculado se lee como `authenticated`.
    - Un usuario con sesión que no es agente recibe null; `service_role`
      recibe la tarifa.
    - `tarifa_envio_usd` no lleva `set search_path` y `tarifa_mrw_usd` es
      `definer`. Si alguien los revierte, el test se pone rojo.
    - Mutación: sin el chequeo de acceso, el test se pone rojo.
  - `permisos_funciones.sql` (29 funciones) también pasa.
  - Este repo no usa pgTAP: el test sigue el estilo de `supabase/tests/`
    (transacción con rollback y un `raise exception` final).
- **PostgREST local:** `tarifa_envio_usd` sale directo (1 kg → 1.40); `anon`
  recibe 42501.
  - Dentro del carrito con un renglón real, el campo sale con la llave de
    servicio (2,5 kg → 2.10) y con la sesión de un asesor en el navegador
    (HTTP 200, 2.1).
- **En el navegador** (build de producción + Playwright, sesión de asesor):
  - Guardar 3,5 kg en un producto sin peso muestra al instante "Bs. 6400.62 /
    $ 7.30 / incluye envío MRW $ 2.80" (USD 4,50 + 2,80).
  - No hubo navegación completa ni ninguna respuesta REST con error.
- **Rendimiento:** ver la migración; medido como `authenticated` sobre 6.155
  productos.
- **vitest:** suite completa 218 archivos, 4659 tests en verde.
  - Mutaciones en rojo: sin `+ fee`, con `price / rate` en lugar de
    `usdFromBs`, y la tarifa vieja tras una relectura fallida.
- **`tsc`** limpio; **lint** con 0 errores (7 warnings viejos);
  **`npm run build`** OK.
- **CI real en verde** sobre el contenido de `3ae41a7` (run 38324133879, en una
  rama desechable `ci/**` que habilita el disparo; ya borrada). Incluye el job
  de migraciones: base reconstruida desde cero con las 96 migraciones y los
  tests SQL, con `precio_estandar_mrw.sql` y `permisos_funciones.sql`. El run
  anterior, sobre la primera versión, cayó por `rate limit exceeded` al
  instalar la CLI de Supabase, no por el código.
- **Pantalla:** build de producción + Playwright a 1366, 1024 y 390 px, sin
  desborde horizontal y con las columnas alineadas entre filas.
  - Datos de prueba: Bujía USD con 1 kg, Carburador con 95 kg, Filtro VES
    con 0,25 kg, Kit con 0 kg y Pastillas sin peso.
  - Capturas en `docs/entregas/2026-10-12-precio-estandar-mrw/`
    (`inventario-escritorio.png`, `inventario-1024.png`,
    `inventario-telefono.png`).

## Desvíos respecto al documento del operador

1. **El "$" del precio estándar de un producto en Bs.** es
   `usdFromBs(price, rate) + tarifa`, no `round(price / rate, 2) + tarifa`.
   Es la regla del CLAUDE.md: el dólar desde bolívares pasa solo por
   `usdFromBs`. Así el $ estándar es siempre el $ promoción más la tarifa
   exacta. El ejemplo del documento (promo $1,00 + 1 kg → $2,40) da igual.
2. **Tests SQL en el estilo del repo**, no pgTAP.
3. **Tercer motivo, `sin_tarifa`** ("Sin tarifa MRW para este peso"): peso
   válido sin tramo en la tabla, por ejemplo si se borra una fila de
   `shipping_rates`.
4. **Formato de cifras** como el resto de la fila (`$ 1.40`, `Bs. 12.50`),
   no "$1,40".
5. **Breakpoint nuevo de 761 a 1180 px:** los badges de estado bajan a su
   propia línea. Con la columna nueva, a 1024 px el nombre del producto
   quedaba en ~20 px y se montaba sobre "Stock".
6. **Si falla la relectura tras guardar un peso,** el precio estándar se
   oculta hasta el próximo refresco en vez de mostrar la tarifa del peso
   anterior.
7. **`tarifa_mrw_usd` es `security definer`, no `invoker`** como pedía el
   documento. Es por rendimiento, medido arriba. El acceso sigue siendo el
   mismo que da la RLS: un usuario con sesión que no es agente recibe null.
8. **Un peso guardado en 0 cuenta como "sin peso"** también en el badge, el
   filtro y el contador, no solo en el precio estándar.

## Pendientes del operador (siguen abiertos)

- **P1:** la baja de $14,70 a $13,91 en 43 kg se cargó tal cual. Si es un
  error de tipeo, se corrige con un `update shipping_rates set tarifa_usd =
  … where carrier = 'mrw' and desde_kg = 43;`.
- **P2:** Seba, el carrito, el cierre de venta y las facturas siguen con
  `price`. El campo `shippingFeeUsd` queda listo para una entrega aparte.
- **P3:** las tarifas se cambian por SQL. La RLS ya deja escribir a
  supervisor/admin para una pantalla futura.
- **Rol "solo inventario":** si entra después de esta entrega y sus usuarios
  no cumplen `is_agent()`, `tarifa_mrw_usd` les devuelve null, así que no
  verían el precio estándar. Hay que sumarlos a ese chequeo y a la política
  de `select` de `shipping_rates`.
