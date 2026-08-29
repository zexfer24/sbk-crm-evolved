# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# SBK Motorcycles CRM

CRM multiagente de ventas por WhatsApp para una tienda de motos y repuestos en
Venezuela (equipo en Barinas, zona horaria `America/Caracas`, tasa BCV como
referencia cambiaria). Bandeja compartida en tiempo real + un agente de IA
vendedor que responde solo, cotiza contra el inventario real y escala a los
asesores humanos. Conectado de verdad a la WhatsApp Cloud API de Meta.

**Mapa del código:** `docs/GLOSARIO.md` — módulo por módulo, qué hace cada
archivo. Consultarlo antes de buscar a ciegas; actualizar su línea en el mismo
commit que toque un archivo.

**Puesta en producción:** `docs/PRODUCCION.md` — la guía completa, con la
verificación de cada paso. El despliegue real corre en un VPS administrado por
otro Claude; los commits se le entregan con un reporte (ver Convenciones).

## Comandos

```bash
npm run dev                        # Next dev (Supabase local: npx supabase start / db reset)
rtk npm run test                   # Suite completa (vitest run)
rtk npx vitest run <ruta>          # Un solo archivo de test
rtk npm run lint                   # ESLint
rtk npx tsc --noEmit               # Tipos
rtk proxy npm run build            # Build — ¡NUNCA `rtk next build`! (ver Trampas)
```

CI (`.github/workflows/ci.yml`): tipos + lint + tests + build, y en paralelo
reconstruye la base desde cero con las migraciones y seeds del repo.

## Arquitectura

**Camino de un mensaje entrante** (el flujo que explica la mitad del código):

1. `api/webhooks/whatsapp` verifica la firma HMAC de Meta, escribe
   mensaje/contacto/conversación con el cliente admin (service role, sin
   sesión) y **encola** el turno de IA. Nunca procesa en línea.
2. La cola (`lib/ai/queue.ts` + `redis-queue.ts`, Redis con scripts Lua)
   espera silencio antes de atender: 6 s si el mensaje parece ráfaga a medias,
   2 s si cierra la idea. Impone cupos globales de turnos simultáneos y por
   minuto. `api/cron/process-queue` (cada 5 min, `CRON_SECRET`) es la red de
   seguridad para turnos huérfanos.
3. El turno (`lib/ai/agent.ts`) corre en paralelo la fase 0 (¿calza un
   escenario/playbook del supervisor? → se envía tal cual) y la fase 1
   (clasificar intención → define qué herramientas recibe el modelo), y solo
   entonces el tool loop (máx. 5 pasos: catálogo, biblioteca, historial,
   escalar).
4. El envío sale por `lib/whatsapp/meta-client.ts` (server-only). Canal no
   `connected` = envío simulado (demo sin gastar).

**Frenos del agente**, todos independientes: lock por conversación con lease
que se renueva solo, cupos globales en Redis, rate limit de peticiones hacia
el proveedor (`rate-limit.ts`), tope de gasto diario, interruptor global,
interruptor por herramienta, y la regla "si un humano ya escribió en el chat,
la IA no entra"
(`human-handled.ts`). `turn-target.ts` congela a quién se le habla;
`turn-delivery.ts` impide el doble envío en reintentos.

**Frontend:** App Router con una página por sección; `components/crm-shell.tsx`
es el cliente raíz de la bandeja (estado, suscripciones realtime de Supabase,
outbox de envíos). Lecturas en `lib/data.ts` y `lib/*-data.ts`; escrituras en
`lib/mutations.ts`. La lógica con reglas de negocio vive separada de React en
módulos puros (`inbox-filters`, `outbox`, `sale-cart`, `customers`,
`inventory`…) precisamente para poder probarla sin levantar nada.

**Base:** Supabase self-hosted (Postgres + Auth + Realtime + Storage). RLS
activo pero compartido —cualquier agente autenticado lee/escribe todo; no es
multi-tenant— salvo las acciones sensibles, que exigen rol
supervisor/admin **en RLS**, no solo en la interfaz. El bucket
`whatsapp-media` es privado: el multimedia se sirve por `api/media/[...path]`
con sesión. Inventario y catálogo de la IA son la MISMA tabla `products`, sin
copia intermedia.

## Convenciones

- **Todo en español**: commits, comentarios, logs (`lib/log.ts`, eventos como
  `cola_turno_fallido`), UI. Los comentarios explican el porqué y la historia
  (fallas reales con fecha), no el qué.
- **Commits narrativos**: una frase que dice el efecto observable ("El panel
  marca los escenarios que llevan un precio escrito a mano"), no `feat: ...`.
- **`[migración]` en el título** de todo commit que agregue una migración, y
  la migración va en commit separado del código que la usa. Omitirlo ya tiró
  producción 6 minutos en hora pico.
- **Tests al lado del módulo** (`foo.ts` + `foo.test.ts`). Un cambio de lógica
  trae su test en el mismo commit.
- **Entrega a producción**: preguntar en qué commit está producción antes de
  calcular qué migraciones aplicar (`produccion..HEAD`, nunca el HEAD local), y
  redactar el reporte de entrega por commit para el Claude del VPS.
- **Metodología de trabajo**: todo cambio entra por la skill `liminalwork`
  (plan aprobado → subagentes → reportes → tests). Sin plan no se implementa.

## Trampas conocidas

- `rtk next build` **reporta éxito sin construir**. Compilar siempre con
  `rtk proxy npm run build` y verificar el timestamp de `.next/BUILD_ID`.
- `rtk git commit -m` se rompe con comillas simples en el mensaje: los
  mensajes largos van con `git commit -F <archivo>` (sin rtk).
- **La suite en Windows corre con `pool: forks` + `isolate: true`**: un
  proceso nuevo por archivo, hasta 7 en paralelo sobre 8 núcleos. La
  contención que eso producía se atacó el 28/8/2026 (`testTimeout` 15s como
  red de seguridad, `slowTestThreshold: 1000` delata la degradación, entorno
  `node` por defecto —solo los tests que usan DOM declaran
  `/** @vitest-environment jsdom */`—, `userEvent.setup({delay: null,
  pointerEventsCheck: 0})` en los tests de teclado, tests de rutas
  importando en `beforeAll`) y se cerró el 29/8/2026: los archivos que aún
  caían bajo carga dependían de plazos de reloj de pared que no escalan —
  el `testTimeout` de 15s NUNCA gobernó los `waitFor` de Testing Library
  (traían 1000 ms de fábrica), ese era el hueco real. Ahora
  `asyncUtilTimeout: 5000` en `vitest.setup.ts` (solo jsdom) cubre esos
  `waitFor`, los tests de rutas esperan el hecho con `vi.waitFor({timeout:
  5000})` en vez de un `setTimeout(0)`, las cargas en frío pesadas
  (`new-contact-race.test.ts`, `bcv-fetch.test.ts`) calientan su grafo en un
  `beforeAll` con 30s propios, y Babel solo transforma `.tsx`/`.jsx`. Sigue
  vigente el diagnóstico: si un archivo falla en la suite y pasa aislado
  (`rtk npx vitest run <ruta>`) es contención, no regresión; palancas
  locales de diagnóstico: `VITEST_MAX_WORKERS=4` y `--no-file-parallelism`.
  Reproducido y verificado con quemadores de CPU a prioridad AboveNormal:
  12 quemadores tumban cualquier presupuesto e impiden arrancar workers —
  esa dosis es reproductor del mecanismo, no criterio de verde.
- **Un `vi.mock` con `importOriginal()` arrastra el grafo ENTERO del módulo
  real** (mockear `@/lib/ai/queue` cargaba los dos SDK de IA e ioredis para
  leer dos constantes). En tests de rutas: mockear también `@/lib/ai/agent` y
  `@/lib/redis`, e importar el route una sola vez en `beforeAll`.
  `route.test.ts` y `new-contact-race.test.ts` ya mantienen sus fábricas en
  espejo completo (incluido el mock de `@/lib/redis` en las dos); si se
  añade a `queue.ts` un export que el webhook use, actualizar ambas.
- El stack Supabase self-hosted es `supabase-squad` (se clona de
  `zexfer24/supabase-squad`, no vive en este repo). Studio/meta corren en su
  perfil `admin`: un 503 en el panel significa levantar esos contenedores, no
  tocar Envoy.
- **`has_reply` es vitalicio** (lo enciende la IA, el asesor y la bienvenida
  automática; nunca se apaga): NO sirve como corte de "sin atender" — usarlo
  así vació la píldora de la bandeja en producción el 28/8/2026. La píldora
  "No leídas" de la bandeja usa `unread_count`/`manually_unread`
  (`isUnread` en `inbox-filters.ts`), no `has_reply`. La ventana de 24h sin
  respuesta sigue existiendo, pero ya no en la bandeja: vive en
  `dashboard.ts` (`isStalePending`) y el `AgentHomePanel`.
- `supabase/seed.sql` **no va a producción** (trae usuarios con contraseña
  escrita); los seeds de catálogo y playbooks sí.
- Sin `WHATSAPP_APP_SECRET` el webhook acepta cualquier POST (a propósito,
  solo para local). En producción es obligatoria — igual que `CRON_SECRET`.

---

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test            # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

## Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history       # View command history with savings
rtk discover             # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>          # Run command without filtering (for debugging)
rtk init                 # Add RTK instructions to CLAUDE.md
rtk init --global        # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.

@AGENTS.md
