# Entrega «Ventas activas: ventana de 48 h, desglose por origen y equipo, y ventana de 24 h de WhatsApp» (22/11/2026)

Rama `entrega/ventas-activas-desglose` sobre `806fcb0` (producción según el último reporte). Trae **una
migración** (`20261122010000`), sin variables de entorno nuevas, y cambios de interfaz solo para supervisor y
admin (los paneles).

## Qué pasó

La tarjeta «Ventas activas» mostraba $74.680,10 en 698 «presupuestos y carritos sin enviar» (medido el
22/11/2026) y el operador lo leía como 698 presupuestos. Además sumaba 7 días de carritos y 30 de
presupuestos: cotizaciones abiertas, no pedidos (el 96,2 % de los carritos que llegan a SAINT se envían dentro
de las 24 h). Pidió tres cosas:

- que cuente solo lo movido en las últimas 48 h, sin borrar ni vaciar nada;
- que diga de dónde sale (carritos del chat, presupuestos de Inventario) y quién lo armó (asesores online o
  caja);
- cuántas ventas son de chats donde todavía se le puede escribir al cliente sin plantilla.

## Antes de nada

1. **Confirmar con el operador en qué commit está producción** (`806fcb0` según el último reporte) y listar
   las migraciones del rango:
   `git diff --name-only <produccion>..entrega/ventas-activas-desglose -- supabase/migrations`. Esta entrega
   agrega una sola: `20261122010000_ventas_activas_desglose.sql`.
2. **La migración va ANTES del código** (el push a `main` despliega). Solo AGREGA claves al jsonb y no cambia
   ninguna existente, así que el código que está en producción sigue funcionando con la migración aplicada:
   lo único que verá distinto es la cifra (ahora de 48 h) y la lista (300 ítems en vez de 30). Si por error
   el código llegara antes que la migración, la tarjeta cae al formato de antes sin romperse.

## CI

Sin correr todavía: la rama no se pusheó. El paso nuevo `paneles_ventas_activas` del job `migraciones` corre
`supabase/tests/paneles_ventas_activas.sql` sobre la base reconstruida. **El VPS no aplica la migración hasta
ver ese verde.**

## Commits

| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? | ¿Cambió la firma de las RPC? |
|---|---|---|---|---|---|
| 1 | `21fdde3` [migración] Las ventas activas cuentan lo movido en 48 h y se reparten por origen, equipo y ventana de WhatsApp | **Sí**, `20261122010000_ventas_activas_desglose.sql` | No | Base | No: `panel_ventas_activas()` → `jsonb`, sin parámetros |
| 2 | `c946535` La tarjeta de ventas activas dice de dónde sale, quién lo armó y si todavía se le puede escribir al cliente | No | No | UI (solo supervisor/admin) | No |
| 3 | El commit de este reporte (glosario, CLAUDE.md y este archivo) | No | No | Nada en ejecución | No |

Qué cambia en el cuerpo de `panel_ventas_activas()`:

- Entra lo que tuvo su último cambio hace ≤ 48 h: presupuestos por `updated_at` (antes `created_at` con 30
  días) y carritos por `max(conversation_cart_items.updated_at)` (antes 7 días). Lo de más de 48 h se cuenta
  en `fuera_de_ventana`, sin valuar.
- Claves nuevas: `tramos_48h`, `fuera_de_ventana`, `por_origen`, `por_equipo`, `por_origen_equipo`,
  `por_ventana`, `por_canal_ventana`; y por ítem `origen`, `equipo`, `ventana`, `ventana_hasta`,
  `conversation_id`. `antiguedad` conserva sus cuatro tramos (`7d` y `30d` quedan en 0). Contrato completo en
  `docs/paneles-contrato.md`.
- `equipo` sale del ROL (`caja` → tienda, el resto online) y es un eje aparte de `canal`, que no cambia.
- `items` pasa de los 30 más viejos a los 300 más viejos.
- Medido en local como `authenticated`: 165–227 ms con 6.000 presupuestos y 4.000 carritos (8 llamadas
  seguidas); el umbral del script de rendimiento es 1.500 ms.

## Orden de aplicación

1. **Respaldo** de la base.
2. **Simulacro** en una transacción que se deshace, como supervisor o admin real:

   ```bash
   PGOPTIONS="-c lock_timeout=5s" psql -v ON_ERROR_STOP=1 <<'SQL'
   BEGIN;
   \i supabase/migrations/20261122010000_ventas_activas_desglose.sql
   set local role authenticated;
   set local "request.jwt.claim.sub" = '<id de un admin>';
   select j -> 'total' as total,
          j -> 'presupuestos' -> 'cantidad' as presupuestos,
          j -> 'carritos' -> 'cantidad' as carritos,
          j -> 'por_origen' as por_origen,
          j -> 'por_equipo' as por_equipo,
          j -> 'por_ventana' as por_ventana,
          j -> 'fuera_de_ventana' as fuera,
          jsonb_array_length(j -> 'items') as items
     from (select public.panel_ventas_activas() j) x;
   ROLLBACK;
   SQL
   ```

   Esperable con los datos del 22/11: unos 180–250 carritos, `por_equipo.tienda` en 0 (ninguna `caja` armó
   nada), `presupuesto_inventario` en 0 salvo que alguien haya guardado uno sin enviar en las últimas 48 h, y
   `fuera_de_ventana.carritos` en el orden de los cientos.
3. **Aplicar** dentro de una sola transacción (sin `-1` la guarda de `lock_timeout` aborta):

   ```bash
   PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261122010000_ventas_activas_desglose.sql
   ```

   Tiene que terminar con `NOTICE: 20261122010000: autoverificación … correcta`. Es re-ejecutable.
4. **Después**, fast-forward de `main` a la rama (eso despliega) y deploy manual en Dokploy.

## Verificación en producción

- `/panel`: la tarjeta dice «N sin enviar» y los bloques «De dónde», «Quién lo armó» y «Se puede escribir»;
  el pie dice «movidos en las últimas 48 h · N más viejos fuera del conteo (no se borraron)». Sin fila
  «Tienda (caja)» mientras la caja no arme nada (la tienda sigue oculta, D1 del 21/11).
- Abrir el detalle: matriz origen × equipo, reparto por ventana y lista con «quedan N h» y «Abrir chat»
  (abre `/inbox?conversation=<id>`).
- `/panel/analiticas#ventas-activas`: filtros Equipo y Ventana, antigüedad +12 h / +24 h.
- Que la cuenta de «Ventana abierta» coincida, a grandes rasgos, con lo que el chat permite escribir: usan la
  misma regla (`last_customer_message_at + 24 h`).

## Reversa

No hace falta para el código viejo, que ya convive con la migración. Si hubiera que volver a 7/30 días,
reaplicar la sección 5 de `20261113040000_paneles_lectura.sql` (`create or replace`) con `psql -1`.
