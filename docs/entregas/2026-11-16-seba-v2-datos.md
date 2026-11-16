# Entrega 2 del rework de Seba: «Los datos del negocio» (16/11/2026)

Rama `entrega/seba-v2-datos`, partida de `origin/entrega/seba-v2-lectura` = `10c576e` (la entrega 1),
por decisión del operador: la entrega 1 todavía no está en `main` (`371a8ca`) y esta toca los mismos
archivos. **Lleva dos migraciones** y **ninguna variable de entorno nueva**. `main` no se tocó: el VPS
aplica las migraciones y después avanza `main`.

Son los briefs N1, N4 y N5 del VPS. **No cambia el comportamiento de Seba:** no se tocó nada de
`src/lib/ai/`, y nadie lee todavía `seba_v2_modo`.

## Antes de desplegar

1. **Confirmar con el operador en qué commit está producción.** El 16/11 dijo `371a8ca`, sin la
   migración `20261116010000` aplicada. Listar el rango real:
   `git diff --name-only <produccion>..entrega/seba-v2-datos -- supabase/migrations`.
2. **Orden de las migraciones** (cada una con `psql -1 -v ON_ERROR_STOP=1`; sin `-1` abortan solas):
   1. `20261116010000_lecturas_de_media.sql` (entrega 1, si todavía no se aplicó)
   2. `20261116020000_formas_de_pago.sql`
   3. `20261116030000_seba_v2_configuracion.sql`
3. **Las tres van ANTES que el código, sin excepción.** Desde esta entrega la lista de la bandeja pide
   `conversations.escalation_area`: con el código nuevo y sin `20261116030000`, PostgREST responde 400
   y **la bandeja entera no carga**. (La entrega 1 ya exigía lo mismo para el chat con `message_readings`.)
   Control IA sí tolera la falta: la pestaña «Seba v2» dice «No disponible».
4. `20261116030000` toma un candado breve sobre `agent_settings`, `agents` y `conversations` (agrega
   columnas con default constante, valida CHECK y crea un índice parcial que nace vacío). Lleva
   `lock_timeout = 5s`: si corta, se reintenta; no deja nada a medias.
5. **Cargar las formas de pago reales** después de migrar (el repositorio es público: la migración no
   inserta filas). Desde Control IA → «Seba v2» → «Formas de pago» con un supervisor, o por SQL. Claves
   sugeridas: `pago_movil`, `transferencia` y `binance` (esta con `seba_entrega = false`). La clave
   `cashea` está prohibida y una clave no se puede cambiar después.
6. Se puede avanzar `main` de una vez hasta esta rama (trae la entrega 1 adentro) o en dos pasos.

## Commits

| # | SHA | Título | ¿Migración? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `aca81d4` | `[migración]` Las formas de pago de contado tienen su tabla, y solo un supervisor las cambia | **Sí:** `20261116020000_formas_de_pago.sql` | Base |
| 2 | `e4035bc` | `[migración]` La base guarda el modo de Seba v2, la bienvenida, los montos de Cashea, las áreas y el pedido | **Sí:** `20261116030000_seba_v2_configuracion.sql` | Base |
| 3 | `8b4a684` | Las formas de pago, la bienvenida y el modo de Seba v2 se leen y se guardan con puerta de supervisor | No | Cliente (lecturas y mutaciones) |
| 4 | `e80eb22` | Control IA gana la pestaña «Seba v2» y cada asesor tiene sus áreas en «Agentes» | No | UI |
| 5 | `38fad71` | La bandeja filtra por área con una píldora nueva | No | UI |
| 6 | `6434533` | Las correcciones de la revisión de código | No | UI |
| 7 | (la punta) | El glosario, CLAUDE.md, la guía de producción y este reporte | No | Documentos |

Variables de entorno nuevas: **ninguna**. Costo de despliegue: **rebuild completo (~5 min)**, porque
toca la UI.

## Qué cambia

- **Base.** Tabla `payment_methods` (lee cualquier asesor, escribe solo supervisor o admin, en RLS; sin
  Realtime; sin funciones). En `agent_settings`: `seba_v2_modo` (nace `apagado`), `shadow_daily_cap_usd`
  (5), `shadow_sample_pct` (100), `welcome_text` y `welcome_followups` (el texto y las cuatro frases
  aprobados el 16/11), `cashea_datos_text`, `cashea_minimo_usd` (25) y `cashea_seis_cuotas_desde_usd`
  (100). `agents.areas` (las cuatro para todos). `conversations.escalation_area` y
  `conversations.seba_pedido` (nadie las escribe todavía).
- **Control IA → pestaña «Seba v2»** (la segunda; la ven todos, el asesor en solo lectura): el modo, con
  confirmación antes de «Fuera de horario» y «Siempre» y un aviso de que todavía no rige; la bienvenida,
  con vista previa de WhatsApp y las frases del mensaje 2; y las formas de pago con el bloque de Cashea.
- **Control IA → «Agentes»:** cuatro casillas de área por asesor. Las cambia supervisor o admin.
- **Bandeja:** séptima píldora «Área», con chips Todas · Pagos · Ventas · Envíos · Reclamos. **Nace
  vacía:** nadie escribe `escalation_area` hasta la entrega 3.

## Decisiones del operador (16/11)

| # | Decisión |
|---|---|
| E1 | Las casillas de área van en «Agentes» (`agent-roster-panel.tsx`), no en «Equipo»: esa pestaña solo la ve un admin |
| E2 | Séptima píldora «Área» con fila de chips; el tope del test de píldoras sube de seis a siete |
| E3 | El texto y los dos montos de Cashea se editan en esta entrega, dentro del panel de formas de pago |
| E4 | Los tres paneles van en una pestaña nueva «Seba v2», no dentro de «IA» |

## Desvíos respecto de los briefs

**N1**
1. `20261107010000_fotos_para_asesores.sql` no tiene test propio; el modelo fue `config_solo_supervisor.sql`.
2. El UPDATE o DELETE de un asesor no da error: afecta 0 filas (solo el INSERT lanza 42501). El test
   afirma «0 filas y estado intacto».
3. `seed.sql` también corre en el CI: el test usa claves propias y no supone la tabla vacía.
4. El seed no trae mensajes rápidos con datos de pago; `quick_replies` no se tocó.
5. Se siguió la convención vigente que el brief omitía: guarda de `lock_timeout`, los dos `revoke all`
   y grants explícitos, `updated_by … on delete set null`, trigger `set_updated_at()`, autoverificación
   y `notify pgrst`.
6. `PaymentMethod` ya existía en `types.ts` (el método del cierre de venta). El tipo nuevo es
   **`PaymentMethodConfig`**: la entrega 3 (S5) tiene que usar ese nombre.
7. **Agregado:** `check (key <> 'cashea')`. `prepararPago` (S5) arma su enum con `"cashea"` más las
   claves activas; una fila con esa clave chocaría.

**N4**
8. **Hueco de seguridad cerrado:** con `agents_update_self`, un asesor podía cambiarse sus propias
   áreas. El trigger `agents_role_guard` pasó a `before update of role, id, areas`; la función conserva
   su cuerpo y sigue `security invoker` (el guardián de permisos sigue contando 38).
9. `conversations_all` deja a cualquier asesor escribir `escalation_area` y `seba_pedido`. Se aceptó:
   ya escriben cualquier columna de `conversations`. **Para la entrega 3:** si `seba_pedido` va a
   decidir un total o un pago, no puede confiar en que solo lo escribió Seba.
10. `seba_pedido` viaja en cada evento Realtime de `conversations` (identidad de réplica por defecto).
11. **Agregados:** `check (jsonb_typeof(seba_pedido) = 'object')`, `shadow_daily_cap_usd >= 0`, los dos
    montos de Cashea `>= 0`, y el índice parcial `conversations_escalation_area_idx`.
12. «Cada frase ≤ 160» no cabe en un CHECK sin una función. La base acota cantidad (2 a 8), sin nulos
    ni vacías y largo total (≤ 1.280); el tope por frase lo valida `seba-v2-config.ts`.
13. Un test de vitest (`seba-v2-defaults.test.ts`) ata los tres textos por defecto de la migración a
    los de `docs/seba-v2/system-prompt-seba-v2.md` §3: cambiar uno sin el otro lo pone en rojo.

**N5**
14. Las casillas de área no están en `team-panel.tsx` (decisión E1).
15. El rol no llega como prop: la vista deriva `canEditConfig`. Los tests de panel reciben callbacks y
    mockean solo `toast`.
16. No hay `Switch`/`Select`/`Checkbox` de HeroUI en uso: interruptores `.ac-switch` y casillas nativas.
    La vista previa de WhatsApp se armó con `FormattedText` (`whatsapp-preview.tsx`).
17. Las columnas nuevas **no** se sumaron a `fetchAgentSettings` ni a `fetchAllAgents`: se leen aparte
    (`fetchSebaV2Config`, `fetchAgentAreas`) y devuelven `null` solo ante 42703, para que Control IA
    abra aunque falte la migración. `fetchPaymentMethods` va envuelta en `readListIfTableExists`.
18. «Área» se resuelve contra la base **y** se vuelve a comprobar en memoria (el brief decía solo la
    base). El refetch vive en `inbox-sidebar.tsx`, no en `crm-shell.tsx`.
19. La píldora no lleva número: `InboxCounts` y `fetchInboxCounts` no se tocaron.
20. El panel de modo avisa que Seba v2 todavía no está instalada. **Para la entrega 3:** quitar ese
    aviso (`seba-v2-panel.tsx`) y el subtítulo de la pestaña cuando el modo empiece a regir.
21. Los commits 4 y 5 del plan (paneles y áreas) salieron en uno solo: comparten la vista.

## Qué se verificó

- **Suite completa:** 326 archivos y 7.176 tests en verde (1 archivo saltado, 1 `todo`), con Redis arriba.
- **Tipos:** `tsc --noEmit` sin errores. **Lint:** 0 errores, las 8 advertencias de siempre.
- **Build en frío** (`.next` borrada, `node_modules` propio del worktree): termina bien y deja un
  `BUILD_ID` nuevo.
- **Tests SQL** contra la base local, con cada migración aplicada dos veces (idempotentes):
  `formas_de_pago.sql` y `seba_v2_configuracion.sql` en verde; siguen en verde, sin editarlos,
  `agents_rol_sin_autoascenso.sql`, `config_solo_supervisor.sql` y `lecturas_de_media.sql`. Aplicar una
  migración sin `-1` aborta por la guarda.
- **Base desde cero** (lo que hace el CI): una base temporal aparte, con `supabase db start`, aplicó las
  116 migraciones y los tres seeds sin error, y sobre ella pasaron `formas_de_pago.sql`,
  `seba_v2_configuracion.sql`, `agents_rol_sin_autoascenso.sql`, `config_solo_supervisor.sql`,
  `lecturas_de_media.sql` y `permisos_funciones.sql`.
- **Mutaciones** (cada una puso en rojo su test y se restauró desde una copia): política de UPDATE de
  `payment_methods` abierta a `is_agent()`; trigger sin la rama de `areas`; una letra cambiada en el
  texto de bienvenida de la migración; `setSebaV2Mode` sin `assertRowsAffected`; `deletePaymentMethod`
  filtrando por otra clave; `fetchSebaV2Config` devolviendo `null` ante cualquier error; el botón
  «Borrar» sin `canEdit`; «Siempre» sin diálogo; casillas habilitadas para el propio asesor;
  `changeSebaV2Mode` tragándose el error; `fetchConversationRows` sin el `.eq("escalation_area", …)`;
  `matchesFilter` devolviendo `true` para «Área»; el área fuera del `sessionKey`.
- **Revisión de seguridad** (`security-review`) sobre el rango: sin hallazgos. Se comprobó por lectura
  que ni un asesor, ni la caja, ni `anon` escriben `payment_methods` ni las columnas nuevas de
  `agent_settings`; que el trigger cubre todas las vías de cambio de `areas`; que no hay XSS en la
  vista previa (los enlaces solo salen de `https?://`) ni inyección de filtros PostgREST.
- **Revisión de código** (`code-review high`): 9 hallazgos, 8 corregidos en el commit 6 y 1 dejado a
  propósito (ver «Observaciones»).
- **Revisión visual** en el navegador contra Supabase local, como supervisor y como asesor: pestaña
  «Seba v2» en oscuro, en claro y a 390 px (sin desborde horizontal: `scrollWidth` 390); diálogo de
  confirmación de «Siempre»; un cambio de modo y uno de área guardados de verdad en la base; la vista
  del asesor sin ningún control de edición; y la píldora «Área» pidiendo
  `escalation_area=not.is.null` y `escalation_area=eq.pagos` a PostgREST con respuesta 200.

## Lo que no se pudo verificar acá

- El CI no corre en ramas `entrega/**`: los dos pasos nuevos de `ci.yml` se ejecutan recién cuando
  `main` avance.
- No hay datos reales: las formas de pago del seed son inventadas, y `escalation_area` se cargó a mano
  en nueve conversaciones locales para ver la píldora.

## Observaciones fuera de alcance

- **La píldora «Área» hereda el corte «solo hoy»**, como «Mías»: un caso escalado ayer a un área y ya
  leído no aparece salvo con «Ver todo». Se dejó así para no apartarla del resto de las píldoras;
  conviene decidirlo en la entrega 3, cuando el área empiece a escribirse.
- `supabase/tests/rol_caja.sql` falla también sobre una base recién reconstruida (errores sobre
  `presupuestos`, `presupuesto_items`, `product_photos` y `saint_borradores`) y **no está cableado en
  `ci.yml`**. Es anterior a esta entrega y no toca nada de lo que cambió: quedó viejo frente a las
  migraciones de presupuestos y de fotos.
- Un refresco en vivo que llegue a mitad de un guardado optimista de áreas puede mostrar un instante el
  valor anterior; se corrige solo con el evento del propio guardado.
- La fila de frases del mensaje 2 a 390 px pone «Quitar» debajo de cada campo: se lee bien, pero ocupa.
