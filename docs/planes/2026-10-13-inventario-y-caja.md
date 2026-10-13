# Plan "El Inventario se navega, se entiende y lo abre la caja" (13/10/2026)

Rama `entrega/inventario-caja` sobre `main` = `33ba032`. Sin push a `main`: el VPS
aplica la migración y después lleva `main`.

## Decisiones del orquestador

- **D1 — `is_agent()` excluye a `caja`** (`role <> 'caja'`). Toda política, RPC
  `security definer`, Storage y Realtime que hoy la usa le cierra la puerta a la
  caja sin tocar una sola política más. Para los tres roles actuales el resultado
  no cambia (sus filas no son `caja`).
- **D2 — `can_read_inventory()`** (`security definer`, `exists(agents where id =
  auth.uid())`) y políticas `for select to authenticated` en las tablas que lee el
  Inventario: `products`, `product_compatibility`, `exchange_rates` y las seis del
  catálogo de motos que cuenta `fetchMotoCatalogSummary`. `shipping_rates` NO se
  abre: `tarifa_mrw_usd` es `security definer` y su guarda pasa de `not
  is_agent()` a `not can_read_inventory()`. Política nueva `agents_select_self`
  (`id = auth.uid()`) para que la caja lea su fila; `agents_update_self` deja
  fuera a `caja` (no puede activarse ni cambiarse el nombre).
- **D3 — `handle_new_agent()`** toma el rol de `raw_app_meta_data ->> 'role'` si es
  uno de los cuatro válidos (si no, `agent`) y nace con `is_active = (rol <> 'caja')`.
- **D4 — La puerta de navegación lee el rol del JWT** (`session.user.app_metadata.role`),
  sin consultar la base: el middleware ya evita llamadas por petición. La seguridad
  real sigue siendo RLS (D1/D2). En `/api/*` solo se lee la sesión si viene una
  cookie `sb-*` (el webhook y el cron no traen ninguna); con `caja` → 403.
- **D5 — La pantalla de Inventario recibe `soloLectura`** (`currentAgent.role ===
  'caja'`): rail y barra superior solo con Inventario y Cerrar sesión, sin
  `AssignmentNotifier`; peso como texto.
- **D6 — Getbcv con `caja`:** el `upsert` de `getBcvRate` no mira el error, así que
  con RLS rechazando la escritura devuelve igual la tasa leída en vivo, o la
  guardada si el BCV falla. Basta con que la caja pueda LEER `exchange_rates` (D2);
  el cron (service role) sigue siendo quien guarda. Se fija con un test.
- **D7 — "Sin peso" sin orden elegido = existencia de mayor a menor.** Elegir
  "Nombre" bajo ese filtro escribe `orden=nombre` explícito en la URL.

## Tareas

| # | Qué | Archivos principales | Va con |
|---|---|---|---|
| A | Migración `caja` + test SQL + guardián de permisos + script de alta + PRODUCCION.md | `supabase/migrations/20261013010000_rol_caja.sql`, `supabase/tests/rol_caja.sql`, `scripts/crear-usuario-caja.ts` | paralelo |
| B | T0 `deploymentId` | `next.config.ts`, `Dockerfile` | paralelo |
| C | T1 paginador + página fuera de rango | `inventario-paginador.tsx`, pager de `inventario-view.tsx`, `inventory-data.ts`, `app/inventario/page.tsx` | paralelo |
| E | T5 app global: tipos, reparto, proxy, rail | `types.ts`, `claim-agent.ts`, `data.ts`, `middleware.ts`, `app-rail.tsx` | paralelo |
| D | T2 + T3 + T4 + T5 en la fila | `producto-fila.tsx`, `carrito-boton.tsx`, `inventario-view.tsx`, `inventario.css`, `inventory.ts`, `inventory-data.ts` | después de C y E |

## Verificación

- Cada tarea: test rojo antes del código, tests propios en verde.
- Cierre: `npm run test`, `tsc`, `lint`, `rtk proxy npm run build` (BUILD_ID nuevo),
  `npx supabase db reset` + todos los `supabase/tests/*.sql` (incluido `rol_caja.sql`
  y `permisos_funciones.sql`), y una pasada a mano en el build de producción con
  un usuario `caja` y un asesor.
