# Contrato de datos de los paneles (Dashboard, Analíticas, Asesores)

Plan del 13/11/2026 (propuesta A · Mostrador). Este archivo fija la forma exacta del jsonb que devuelven
las RPC de lectura (`[migración] M4`) y que consumen `src/lib/paneles/*` y las pantallas. Cambiar una clave
exige tocar las dos puntas y este archivo en el mismo commit.

## Reglas comunes
- Todas las RPC son `security definer`, `stable`, `set search_path = public`. Verifican
  `is_supervisor_or_admin()` UNA vez y, si no, `raise exception 'no autorizado' using errcode = '42501'`.
  Llevan los dos revokes (`from public`; `from anon, authenticated`) y `grant execute` a
  `authenticated, service_role`.
- Fechas: parámetros `timestamptz`; claves `t`, `desde`, `ultimo` en ISO 8601 con zona. Los tramos de la
  serie se cortan en hora de Caracas (`America/Caracas`).
- Dinero en USD con 2 decimales (`numeric` → número JSON). `null` = "no se puede calcular": la pantalla
  pinta "—", nunca 0.
- **Venta** = fila de `public.ventas_saint` cuyo borrador está en `estado = 'creado'` y que NO es
  duplicado. Lo `pendiente`/`procesando` es "en tránsito"; `error` va aparte.
- **Duplicado** (se decide AL LEER, contra el estado ACTUAL; vista `public.ventas_saint_estado`, columna
  `duplicado`; corrección del 15/11/2026): un envío `creado` es duplicado si existe OTRO envío `creado`
  anterior —por `created_at`; a igual instante, el de `borrador_id` menor— del mismo `origen_id` o de la
  misma `conversation_id` (no nula), con la misma firma de ítems (`ventas_saint.firma_items`,
  `codprod:cantidad` por código) y a menos de 24 h. Un envío en `error` o en tránsito NUNCA vuelve duplicado
  a otro (error → reenvío idéntico `creado` es UNA venta). Con tres `creado` iguales cuenta el primero; si el
  anterior estaba en tránsito cuenta el posterior, y si luego el anterior pasa a `creado` cuenta el anterior:
  siempre uno. El anterior se busca en toda la tabla, no solo en el rango consultado. `ventas_saint` ya no
  tiene `posible_duplicado`. `estado.duplicados` cuenta los duplicados del rango según esta regla.
- **Canal**: el que guardó la foto (`ventas_saint.canal`), nunca recalculado en la lectura.
- Tope de rango: las RPC que leen `messages` (`panel_conversaciones`, `panel_asesores`) rechazan rangos de más
  de 92 días con `errcode = '22023'`. `panel_ventas` no tiene tope.

## `panel_ventas(p_desde timestamptz, p_hasta timestamptz) → jsonb`
```json
{
  "granularidad": "hora" | "dia" | "mes",
  "canales": {
    "online": { "ingresos": 0, "envios": 0, "unidades": 0, "ticket": null, "estimados": 0, "sin_monto": 0 },
    "tienda": { "...": "misma forma" }
  },
  "serie": [ { "t": "2026-11-13T08:00:00-04:00", "online": 0, "tienda": 0, "envios_online": 0, "envios_tienda": 0 } ],
  "perfil_horario": [ { "dia": "2026-11-12", "online": [0], "tienda": [0] } ],
  "personas": [ { "agent_id": "uuid", "nombre": "Asesor 4", "rol": "agent", "canal": "tienda", "ingresos": 0, "envios": 0, "unidades": 0 } ],
  "top_repuestos": [ { "codprod": "LF09", "nombre": "…", "unidades": 0, "ingresos": 0, "unidades_online": 0, "unidades_tienda": 0 } ],
  "tipo_precio": { "online": { "promocion": 0, "estandar": 0 }, "tienda": { "promocion": 0, "estandar": 0 } },
  "estado": { "transito": { "envios": 0, "monto": null }, "error": { "envios": 0 }, "sin_foto": 0, "duplicados": 0 },
  "recurrentes": { "online": { "compradores": 0, "regresan": 0 }, "tienda": { "compradores": 0, "regresan": 0 }, "genericos_excluidos": 0 }
}
```
- `granularidad`: `hora` si el rango es ≤ 1 día; `mes` si es > 92 días; si no, `dia`. La serie trae TODOS
  los tramos del rango (con 0), en orden.
- `perfil_horario`: solo cuando `granularidad = 'dia'` (si no, `[]`): un elemento por día del rango, en orden, con
  24 montos por hora de Caracas por canal (0 si no hubo ventas). Alimenta la curva horaria de la proyección.
- `ingresos` = suma de `monto_usd` (null si todas las ventas del canal tienen `monto_usd` null; si solo
  algunas, suma las que tienen y cuenta las otras en `sin_monto`). `ticket` = ingresos / envíos con monto, o null.
- `personas`: por `enviado_por`, una fila por (persona, canal). Orden: ingresos desc.
- `top_repuestos`: 15, por ingresos desc, desde `ventas_saint.lineas`.
- `recurrentes`: comprador = cédula distinta (`cedula_tipo || cedula_numero` del borrador) entre las ventas del
  rango, sin los genéricos. Regresa = tuvo una venta antes de `p_desde`, o algún borrador suyo en el rango con
  `cliente_creado = false` (ya existía en SAINT). Genérico = `codclie` con ≥ 20 ventas en los 30 días que
  terminan en `p_hasta`; `genericos_excluidos` cuenta cuántos códigos se excluyeron (nunca se devuelven).

## `panel_conversaciones(p_desde timestamptz, p_hasta timestamptz) → jsonb`
Solo chat (online). Base: conversaciones con al menos un mensaje del cliente (`sender_type = 'customer'`) en el rango.
```json
{
  "embudo": { "escribieron": 0, "respondidas": 0, "con_carrito": 0, "compraron": 0 },
  "resultados": { "compraron": 0, "reclamo": 0, "carrito_sin_compra": 0, "solo_preguntaron": 0, "sin_respuesta": 0 },
  "conversion": {
    "equipo": { "atendidas": 0, "compraron": 0 },
    "personas": [ { "agent_id": "uuid|null", "nombre": "Asesor 1", "rol": "agent|supervisor|admin|ia", "atendidas": 0, "compraron": 0 } ]
  },
  "calor": { "valores": [[0]] }
}
```
- `respondidas`: hubo un saliente `sender_type in ('agent','ai')`, no nota interna, después del primer mensaje
  del cliente en el rango. `con_carrito`: algún `conversation_cart_items` creado o cambiado en el rango.
  `compraron`: alguna venta con ese `conversation_id` en el rango.
- `resultados` son excluyentes y suman `escribieron`, con esta precedencia: compraron → reclamo (el contacto
  tiene una etiqueta cuyo `translate(lower(btrim(label)),'áéíóúü','aeiouu')` empieza por `reclamo`) →
  carrito_sin_compra → solo_preguntaron (respondida, sin carrito) → sin_respuesta.
- `conversion`: por persona que respondió (Seba = `sender_type = 'ai'`, `agent_id` null, rol `ia`).
  `atendidas` = conversaciones donde respondió en el rango; `compraron` = de esas, las que tienen una venta en los
  7 días siguientes a su primera respuesta. Una venta cuenta para cada persona que respondió en esa conversación
  (por eso `personas` no suma `equipo`). `equipo` = conversaciones respondidas por alguien y cuántas compraron.
  Orden: atendidas desc.
- `calor.valores`: matriz 7 × 24 (`[dow 0=domingo..6][hora 0..23]`, hora de Caracas) de mensajes del cliente.

## `panel_asesores(p_desde timestamptz, p_hasta timestamptz) → jsonb`
```json
{
  "personas": [ {
    "agent_id": "uuid", "nombre": "Asesor 4", "rol": "agent", "en_reparto": true,
    "conversaciones": 0, "mensajes": 0, "contactos": 0,
    "episodios": 0, "primera_resp_mediana_min": null, "primera_resp_p90_min": null, "en_5min": null,
    "envios": 0, "monto": null, "unidades": 0, "envios_online": 0, "envios_tienda": 0,
    "reasignadas_desde": 0, "ultimo_mensaje": null, "actividad_hora": [0]
  } ],
  "seba": { "mensajes": 0, "conversaciones": 0, "ultimo": null },
  "equipo": { "episodios": 0, "primera_resp_mediana_min": null, "en_5min": null }
}
```
- Incluye a toda persona de `agents` (rol ≠ caja) con al menos un mensaje o un envío en el rango, más las
  cuentas `caja` con envíos. `en_reparto` = `agents.is_active`.
- Episodio = mensaje del cliente que sigue a un saliente (o el primero de la conversación), iniciado en el
  rango. Lo responde el primer saliente `agent`/`ai` no nota interna posterior; se atribuye a quien respondió.
  `en_5min` = fracción (0–1) de sus episodios respondidos en ≤ 5 minutos. Minutos de reloj.
- `envios`/`monto`/`unidades` por `enviado_por` (solo ventas). `reasignadas_desde`: traspasos
  `reasignada_por_demora` cuyo `from_id` es la persona. `actividad_hora`: 24 enteros (mensajes enviados por hora
  de Caracas).

## `panel_cola() → jsonb`
```json
{
  "corte_dias": 7,
  "pendientes": 0, "sin_dueno": 0, "con_dueno": 0, "abandonadas": 0,
  "por_antiguedad": { "menos_1h": 0, "de_1_a_4h": 0, "de_4_a_24h": 0, "de_1_a_7d": 0 },
  "mas_viejo": { "conversation_id": "uuid", "desde": "iso", "contacto": "…", "asesor": "…|null" } ,
  "lista": [ { "conversation_id": "uuid", "desde": "iso", "contacto": "…", "asesor_id": "uuid|null", "asesor": "…|null" } ]
}
```
- Pendiente = conversación no cerrada con `awaiting_reply = true` cuyo mensaje del cliente más viejo sin
  responder (primero posterior a `last_reply_at`) tiene ≤ 7 días. Las de más de 7 días van a `abandonadas`.
- `mas_viejo` es null si no hay pendientes. `lista`: las 20 más viejas.

## `panel_ventas_activas() → jsonb`
```json
{
  "total": null,
  "presupuestos": { "monto": null, "cantidad": 0, "sin_precio": 0 },
  "carritos": { "monto": null, "cantidad": 0, "sin_precio": 0 },
  "por_canal": { "online": { "monto": null, "cantidad": 0 }, "tienda": { "monto": null, "cantidad": 0 } },
  "antiguedad": [ { "tramo": "24h", "monto": null, "cantidad": 0 } ],
  "items": [ { "tipo": "presupuesto", "id": "uuid", "canal": "tienda", "responsable": "…", "cliente": "…", "monto": null, "unidades": 0, "desde": "iso" } ]
}
```
- Presupuestos: creados hace ≤ 30 días y sin un borrador `creado` (o en tránsito) con su `origen_id`.
  Canal por `presupuestos.origen` (`inventario` → tienda, `chat` → online).
- Carritos del chat (online): conversaciones con ítems cuyo último cambio (`max(updated_at)`) tiene ≤ 7 días y
  no tienen un borrador `creado`/en tránsito de origen `carrito` posterior a ese cambio. Si la conversación tiene
  además un presupuesto `chat` activo, cuenta solo el presupuesto.
- Valuación al precio de hoy con `public.precio_venta_usd`; un renglón sin precio suma a `sin_precio` y deja el
  monto del ítem en null (nunca un parcial). `tramo` ∈ `24h`, `3d`, `7d`, `30d`. `items`: los 30 más viejos.

## Metas (`public.metas_venta`, lectura directa con RLS de supervisor/admin)
Filas `(canal 'online'|'tienda', vigente_desde date, monto_usd)`. La meta de un día es la fila de ese canal
con el `vigente_desde` más alto ≤ ese día. Los días cerrados según `agent_settings.business_hours` no tienen meta.
