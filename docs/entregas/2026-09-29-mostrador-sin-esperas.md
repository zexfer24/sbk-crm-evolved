# Entrega B "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 29/9/2026

Para el Claude del VPS. Plan aprobado:
`docs/planes/2026-09-28-seba-encuentra-y-el-mostrador-no-deja-esperando.md`
(sección ENTREGA B). El orden completo, las verificaciones SQL, el paso del
compose y la medición de 48 h están en `docs/PRODUCCION.md` §16. Esta nota da
la rama, los commits, lo verificado y lo que queda para el operador.

**Punto de partida.** La Entrega A ya está en producción: `main` = `6c8ce24`,
con sus cinco migraciones aplicadas por el operador el 29/9/2026 antes del
fast-forward. Esta rama, **`entrega/mostrador-sin-esperas`**, nace de
`6c8ce24`. **No se pushea a `main` directo**, porque push a `main` despliega
solo. El fast-forward va DESPUÉS de aplicar y verificar las dos migraciones
(§16).

## Qué hay en la rama

`git log --oneline 6c8ce24..origin/entrega/mostrador-sin-esperas`:

```
a26c918 [migración 20260929010000] Cada conversación tiene su carrito, que sobrevive a cerrar el modal
64c83f5 Lo que lleva el cliente queda en el panel del chat y la venta se cierra desde ahí
c69d8dc El reparto de asesores puede saltarse a quien ya tuvo el caso, y el aviso de asignación también llega en una reasignación por demora
40615b6 Una función decide, minuto a minuto, si Seba responde, se reasigna el caso o se avisa al supervisor
36ea67c [migración 20260929020000] La base sabe cuándo un asesor tardó en contestar y a quién ya se le pasó el caso
b6c23a2 Los tipos y los tests de la base conocen la demora del asesor
f302421 Un supervisor enciende la reasignación por demora desde Control IA y se entera cuando nadie atendió
17d0431 Si un asesor tarda diez minutos, Seba contesta sin escalar ni prometer nada
7e40472 Un cron de cada minuto reasigna el caso a los quince minutos de horario y avisa al supervisor al segundo intento fallido
2bf27e3 La búsqueda del chat muestra veinte, carga más sin salir de la columna y marca la existencia con una pastilla
+ corrección de minutos en la nota de reasignación
+ documentación (CLAUDE.md, PRODUCCION.md §16, GLOSARIO) y este archivo (punta de la rama)
```

Esta nota vive en el último commit y no puede traer su propio SHA; el
operador lo pasa con el aviso. Antes de tocar nada:

```bash
git fetch origin
git ls-remote --heads origin entrega/mostrador-sin-esperas   # debe dar el SHA que pasó el operador
```

**Dos migraciones**, en orden: `20260929010000_carrito_por_conversacion` →
`20260929020000_demora_del_asesor`. Comandos: §16.

**Cambia el compose.** Hay un `curl` nuevo cada minuto a
`/api/cron/asesor-sin-responder`, en `docker-compose.yml` y en
`docker-compose.dokploy.yml`. §16 dice cómo verificar que el servicio `cron`
del VPS lo tomó; si no se recreó, hay que hacer un redeploy del stack.

## Verificación hecha en local (29/9/2026)

- Suite completa: 3.874 tests en verde. `tsc` limpio, lint sin errores.
- Los 29 archivos de `supabase/tests/` pasan sobre una base **reconstruida
  desde cero** (88 migraciones + seeds), corridos sin `-1`, como el CI.
- `npm run build` correcto.
- **CI real en verde** sobre `2bf27e3`: run 36605449748, por la rama
  desechable `ci/mostrador-sin-esperas` (`2bf27e3` + el commit del
  disparador `ci/**`; NO se fusiona y se puede borrar).
- **Pantalla (Playwright sobre el build de producción)**, a 1366 y 1100 px,
  en tema claro y oscuro:
  - la búsqueda del chat muestra 20 resultados, scrollea por dentro y
    «Ver más» llega a 30;
  - Notas sigue alcanzable;
  - las pastillas de existencia cumplen contraste AA (medido);
  - el bloque "Lo que lleva el cliente" se ve bien, con
    "cotizado $X · hoy $Y" y el renglón agotado marcado;
  - el modal de cierre arranca con el carrito.
- **Demora a mano**, con el cron llamado por `curl` y las fechas movidas
  hacia atrás. Seis escenarios, todos OK:
  - apagada → no hace nada;
  - escalada sin respuesta durante 16 min → pasa a otro asesor y queda en
    una sola fila de episodio;
  - segunda reasignación a un tercer asesor → avisa al supervisor una vez y
    no rota más;
  - cliente sin respuesta durante 11 min con la IA pausada → Seba responde
    sin escalar, `ai_enabled` sigue apagada y no responde dos veces;
  - backlog anterior al encendido → nada;
  - secreto incorrecto → 401.

## Cambios que el operador tiene que avisar a los asesores

1. **Carrito por conversación.** Lo que el asesor agrega queda guardado en
   el chat, en "Lo que lleva el cliente", aunque cierre el modal o cambie de
   conversación. Todos los asesores lo ven en vivo.
2. **Precio de hoy (D6).** Una cotización de Seba se factura al precio
   vigente, no al cotizado. Si difieren, el renglón muestra
   "cotizado $X · hoy $Y".
3. **Búsqueda del chat.** Muestra 20 resultados con «Ver más», y la
   existencia se lee en una pastilla verde o roja.
4. **Reasignación por demora (cuando se encienda).** A los 10 min sin
   respuesta, Seba contesta sin escalar y sin prometer precios, descuentos,
   apartados ni envíos. A los 15 min de horario, el caso pasa a otro asesor,
   nunca al mismo. Tras dos reasignaciones, se avisa a supervisores y
   admins.

## Orden de encendido de la demora

Nace **apagada**. El cron ya corre cada minuto, pero sin efecto mientras
esté apagada.

1. Desplegar B: migraciones, fast-forward y compose (§16).
2. Avisar a los asesores (punto 4 de arriba).
3. Encender **"Reasignar si el asesor tarda"** en Control IA, como
   supervisor o admin. Al encender se sella `demora_activa_desde = now()`,
   así que nada del backlog anterior dispara.

## Decisiones y límites que conviene conocer

- **Los 15 minutos para reasignar son de horario laboral.** Los 10 minutos
  de Seba son de reloj de pared. Una escalada a las 17:50 no se reasigna a
  las 8:00 sin que el asesor haya tenido tienda abierta.
- **Si el cliente vuelve a escribir, arranca un episodio nuevo** con el
  contador de reasignaciones en 0, aunque el anterior hubiera llegado al
  tope.
- **Solo se reasigna un chat con dueño o con escalada abierta.** Un chat sin
  asesor y con la IA pausada recibe la respuesta de Seba a los 10 min, pero
  no se "reasigna", porque no tiene de quién. El texto de Seba dice que un
  asesor le responde: el chat sigue en Pendientes para todo el equipo.
- **Deuda.** En modo demora, la búsqueda de catálogo todavía devuelve
  instrucciones que mencionan escalar. El modelo no tiene esa herramienta en
  ese modo, y si intentara usarla sale el texto fijo de espera.
- La decisión abierta de la Entrega A (una queja mientras el cliente espera
  a un asesor que todavía no fue asignado) no cambia con esta entrega.
