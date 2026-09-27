# Entrega "El mostrador busca sin salir del chat" — 27/9/2026

Para el Claude del VPS. **Ya está en `main` (`08e0fa5`) y Dokploy lo
despliega solo con el push.** No hay migraciones, variables nuevas ni
cambios de compose: no hay nada que aplicar en la base. Esta nota es solo
para verificar en producción.

Rango: `d38a7e1..08e0fa5` (8 commits). Plan:
`docs/planes/2026-09-27-el-mostrador-busca-sin-salir-del-chat.md`.

## Qué cambia, commit por commit

| Commit | Efecto |
|---|---|
| `22e1b93` | El dólar convertido desde bolívares se redondea SIEMPRE hacia arriba a los 10 centavos (2,54 → 2,60; 2,01 → 2,10; 2,00 se queda). Una sola función (`src/lib/usd-price.ts`) para Inventario, el carrito del cierre de venta (`orders`) y la herramienta de catálogo de Seba. El system prompt NO cambió. |
| `2788283` | La búsqueda de inventario va por palabras y mira el código Saint: "tubo cg" encuentra "TUBO ESCAPE CG…". Inventario, cierre de venta y panel del chat. |
| `3bec53f` | El cuadro de búsqueda (Inventario y Clientes) ya no devuelve letras borradas. |
| `5f876f2` | Cada fila del inventario muestra su código Saint. |
| `7c04087` | Enter envía la imagen pegada en el chat. |
| `eb45350` | El plan. |
| `927dda4` | Panel derecho del chat: etiquetas recogidas (se aplican desde "Gestionar") y búsqueda de inventario de solo lectura. |
| `08e0fa5` | Correcciones del code review: pegar con un modal abierto ya no adjunta al chat; quitar una etiqueta se ve al instante; la búsqueda usa una sola expresión `or=` (verificar abajo). |

## Verificación en producción (solo lectura salvo el punto 5)

1. **Despliegue:** el contenedor corre `08e0fa5` y el dominio responde 200.
2. **Búsqueda contra el PostgREST real (detrás de Envoy):** con la
   service key, desde el VPS:
   `curl -s "<SUPABASE_URL>/rest/v1/products?select=name,saint_code&limit=5&or=(and(or(search_text.ilike.*tubo*,saint_code.ilike.*tubo*,description.ilike.*tubo*),or(search_text.ilike.*cg*,saint_code.ilike.*cg*,description.ilike.*cg*)))" -H "apikey: $K" -H "Authorization: Bearer $K"`
   → debe traer productos que contengan AMBAS palabras (no solo una). Y
   con un `saint_code` real cualquiera, `or=(search_text.ilike.*<codigo>*,saint_code.ilike.*<codigo>*,description.ilike.*<codigo>*)`
   → trae ese producto.
3. **Tiempo de la búsqueda como `authenticated`** (trampa del 21/9: medir
   con el rol de la app, no como superusuario): `EXPLAIN ANALYZE` de la
   consulta del punto 2 dentro de una transacción con `set local role
   authenticated` + `request.jwt.claims` de un agente. Reportar ms. No usa
   índice en `saint_code`/`description` a propósito (≈6.000 filas);
   si pasa de ~300 ms, avisar.
4. **Redondeo:** tomar un producto VES activo, calcular `price / tasa` y
   confirmar en la pantalla de Inventario que el `$` es ese valor
   redondeado hacia arriba a los 10 centavos.
5. **Con el operador, en el navegador** (no lo puede hacer el VPS solo):
   pegar una imagen en un chat con ventana abierta y enviar con Enter;
   buscar "tubo cg" en Inventario y en el panel del chat; aplicar y quitar
   una etiqueta desde "Gestionar".

## Riesgo conocido

`buscar_repuesto` sigue como esté en producción; esta entrega no la
enciende. Si está encendida, Seba empieza a cotizar el dólar redondeado
desde este deploy.
