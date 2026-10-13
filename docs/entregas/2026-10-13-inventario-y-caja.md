# Entrega "El Inventario se navega, se entiende y lo abre la caja" (13/10/2026)

Rama `entrega/inventario-caja` sobre `main` = `33ba032` (producción). **Una
migración**, que va ANTES del código. No hace falta ningún cambio de variables
ni del compose.

## Commits

| Commit | Qué | Migración |
|---|---|---|
| `60d48fe` | [migración] La caja ve el inventario y nada más | `20261013010000_rol_caja.sql` |
| `150cf3a` | La caja entra directo al Inventario y nunca recibe un chat | — |
| `c570daf` | Una pestaña abierta antes de un despliegue recarga la versión nueva (`deploymentId`) | — |
| `fbea0b1` | Paginador, botones de acción, carrito flotante, "Falta el peso", orden de "Sin peso", fila de solo lectura | — |
| (último) | Ajuste visual de "Falta el peso", §19 de PRODUCCION y esta nota | — |

## Pasos en el VPS

1. Respaldo de la base (como siempre).
2. Simulacro: `BEGIN; \i 20261013010000_rol_caja.sql; ROLLBACK;` (o
   `psql` con `-1` y un `rollback` al final). Debe imprimir
   `autoverificación del rol caja correcta`.
3. Aplicar, fuera de hora pico:
   ```bash
   PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261013010000_rol_caja.sql
   ```
4. Verificar con las consultas de `docs/PRODUCCION.md` §19 ("Verificar").
   Para los 8 usuarios actuales nada cambia: `select role, count(*) from agents
   group by 1;` sigue sin ninguna fila `caja`.
5. Fast-forward de `main` a `entrega/inventario-caja` y push (Dokploy despliega).
6. Crear las cuentas de caja con el script (§19, "Crear usuarios de caja").
   Nunca desde el panel de Auth.

## Verificación tras el despliegue

- `curl -sI https://<dominio>/inventario | grep -i x-nextjs-deployment-id`:
  aparece un id (`build-<timestamp>` o el commit si Dokploy pasa
  `SOURCE_COMMIT`). Una pestaña abierta antes del despliegue hace recarga
  completa al navegar, sin `Server Reference ID did not match` en el log.
- Asesor: Inventario con "Página [n] de N" + Ir; botones "Agregar al carrito"
  y "Cashea" a la derecha de cada fila; carrito redondo abajo a la derecha;
  filtro "Sin peso" empieza por lo que tiene más existencia y "Falta el peso:
  cargalo →" lleva al campo de peso. `?page=999` abre la última página.
- Caja: al entrar va a `/inventario`; rail y barra solo con Inventario;
  cualquier otra URL vuelve a `/inventario`; peso como texto; tasa BCV con
  número (no "—"); Cashea y carrito funcionan. No recibe escaladas
  (`is_active = false` y excluida del reparto por rol).

## Qué se probó en local

- `npm run test`: 4956 en verde (1 skip, 1 todo). `tsc` sin errores, `lint`
  0 errores (7 avisos que ya estaban).
- `supabase db reset` desde cero + los 36 `supabase/tests/*.sql` en verde,
  incluido `rol_caja.sql` (la caja lee inventario, tasa, tarifa y su fila;
  0 filas en conversaciones, mensajes, contactos, órdenes y toda otra tabla
  con RLS; no actualiza `products` ni su fila de `agents`; no sube al bucket).
- Mutaciones en rojo: `is_agent` sin `role <> 'caja'`, `agents_update_self`,
  `products_select_inventario`, `tarifa_mrw_usd` con `is_agent()`, INSERT del
  bucket, el filtro de rol del reparto y de `fetchAgents`, el 403 de `/api`,
  `disabled` del botón inactivo y `position: fixed` del carrito.
- `rtk proxy npm run build` (BUILD_ID nuevo; `deploymentId` serializado en
  `.next/standalone/server.js`) y recorrido con Playwright sobre el build:
  caja en `/inbox` y `/ventas` → `/inventario`, `/api/*` → 403, rail con 1
  sección, 0 inputs de peso, tasa con número, carrito y Cashea abren; asesor
  con el paginador (Enter, Ir, 99→última, vacío no navega, `?page=999`
  redirige), "Sin peso" por existencia y el foco al campo de peso; sin
  desborde horizontal a 390 px.
- Alta real de una cuenta de caja con el script contra la base local:
  `role=caja, is_active=false`; con su token, PostgREST devuelve productos,
  tasa y su fila, y `[]` en conversaciones, contactos, mensajes y órdenes.

## Avisos

- **El rol de navegación sale del token.** Una cuenta pasada a caja solo con
  `update agents` no ve datos (RLS) pero sí pantallas vacías hasta que también
  se escribe `auth.users.raw_app_meta_data` (§19).
- **Subir al bucket `whatsapp-media` ahora exige `is_agent()`** (antes
  bastaba cualquier sesión). Para los asesores no cambia nada.
- Mientras carga la sección (`loading.tsx`), una caja ve unos milisegundos
  el esqueleto con el rail completo: el esqueleto no conoce el rol. No expone
  datos.
