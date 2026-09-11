# Plan · El CI vuelve a verde (10/9/2026)

> **Para quien ejecute:** metodología `liminalwork` (plan aprobado → un
> subagente por tarea → reporte → validación del orquestador; equivale a
> `superpowers:subagent-driven-development`). Los subagentes corren como
> `subagent_type: "implementador"` (Sonnet, esfuerzo alto), que crea la
> Tarea 0. Los pasos usan casillas `- [ ]`. El prompt orquestador listo para
> pegar está al final.

**Objetivo:** que el paso "Pruebas" del CI vuelva a verde y que la suite local
vea lo mismo que ve el CI, para que un rojo no vuelva a pasar días sin que
nadie lo note.

**Enfoque:** la suite local corre con el mismo `localStorage` que el CI (una
bandera de Node en los workers de vitest), el setup de jsdom vacía el
almacenamiento antes de cada test y un test de resguardo fija las dos cosas.
El código de la aplicación no se toca.

**Stack:** Vitest 4.1.11 (pool forks), jsdom 30, Testing Library 16, React
19.2.8. Node 26.3.0 en esta máquina; Node 22 en el CI y en el Dockerfile.

**Base:** `origin/main` = `38a540e`. Sin migración, sin variables de entorno.

---

## Contexto

El paso "Pruebas" del CI (`.github/workflows/ci.yml`) está rojo desde
`1379b2c` (6/9/2026; el último verde fue `26d356d`, del 30/8). Todas las
corridas fallan con los mismos tests de
`src/components/inbox/inbox-sidebar.test.tsx`, incluida la de `2f80f1e`, que
es la que está en producción. El job de migraciones estuvo siempre verde.
Nadie lo vio porque Dokploy despliega con el push sin esperar al CI, y cada
corrida se cerró con la suite local en verde.

**Causa, reproducida el 10/9/2026:**

- Node 26 (esta máquina) trae Web Storage nativo y, sin `--localstorage-file`,
  deja `localStorage` en `undefined` dentro de jsdom. La preferencia que
  guarda la barra de la bandeja (`sbk:inbox:{agentId}`,
  `inbox-sidebar.tsx:340-382`) nunca se guarda, y por eso los tests pasan.
- Node 22 (CI y Dockerfile) no trae ese almacenamiento nativo, y jsdom pone su
  `localStorage` real. Lo que guarda un test lo hereda el siguiente dentro del
  archivo: la píldora arranca en "Mías" en vez de "Pendientes" y las filas
  sembradas no se ven.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run
  src/components/inbox/inbox-sidebar.test.tsx` produce 15 fallas en local, las
  mismas del CI (GitHub muestra solo 10 anotaciones por paso). Con un
  `localStorage.clear()` entre tests (setup temporal, ya borrado) pasan los 87,
  con la bandera y sin ella. La suite completa con la bandera solo falla en ese
  archivo (15 de 2056).
- `--no-experimental-webstorage` la aceptan Node 26.3.0 y Node 22.23.2
  (probado con `npx -p node@22`).
- Además, el test "sin localStorage disponible no rompe…"
  (`inbox-sidebar.test.tsx:2344`) no simula nada: da por hecho que el entorno
  no tiene almacenamiento. En el CI sí lo tiene, así que ahí no prueba la
  ausencia. Y el comentario de cabecera (`:2265-2276`) afirma que "Node 22+"
  deja `localStorage` en `undefined`, algo falso justamente para el 22.

No es una falla de la aplicación: en el navegador, recordar la píldora es lo
que se diseñó (T2.2, 5/9/2026).

## Decisiones (se aprueban con este plan)

1. La suite local se alinea con el CI, no al revés: el CI y producción corren
   Node 22 con `localStorage` real en jsdom, y esa es la condición que hay que
   probar.
2. El setup vacía `localStorage` en un `beforeEach`, para que cada test
   arranque limpio sin depender del orden de los `afterEach`. Si el
   almacenamiento no existe, no lanza error: el contrato del entorno lo fija un
   test aparte (`vitest.setup.test.ts`), no el setup.
3. El test de la ausencia la simula con `vi.stubGlobal("localStorage",
   undefined)` y afirma que las píldoras siguen en pantalla. En React 19, un
   error dentro de un efecto puede desmontar la raíz sin que `render` lance
   nada.
4. Nace el agente `implementador` (`.claude/agents/implementador.md`, `model:
   sonnet`, `effort: high`), versionado junto a los otros agentes del repo. Es
   la forma de que "Sonnet en alto" se cumpla de verdad: el Agent tool no tiene
   un parámetro de esfuerzo, y en las corridas anteriores el "razonamiento
   alto" que pedía el prompt no se aplicaba.
5. Fuera de alcance: que Dokploy espere al CI antes de desplegar. Es
   configuración del VPS y queda como recomendación al operador.

## Reglas para todos

- Leer `CLAUDE.md` y `docs/GLOSARIO.md` antes de tocar nada. Todo en español;
  los comentarios cuentan el porqué y la historia, con fecha, no el qué.
- Los subagentes NO commitean ni hacen push. Entregan un reporte con: qué
  implementaron y qué decidieron, los archivos tocados, la salida de sus tests
  y de `rtk npx tsc --noEmit` y `rtk npm run lint`, y los desvíos. El
  orquestador corre él mismo esos comandos antes de cerrar la tarea y hace el
  commit.
- Pruebas de mutación: `cp <archivo> <scratchpad>/<archivo>.bak` antes de
  mutar y restaurar con `cp` desde esa copia. **Nunca `git checkout --
  <archivo>`.**
- Comandos: `rtk npx vitest run <ruta>`, `rtk npm run test`, `rtk npx tsc
  --noEmit`, `rtk npm run lint`.
- Si dos tests de `crm-shell.test.tsx` fallan justo al cruzar la medianoche de
  Caracas, es una trampa conocida y no tiene que ver con esta corrida: repetir.
- Si un paso que debe dar rojo da verde (o al revés), parar y reportarlo al
  orquestador; no seguir.

## Archivos

| Archivo | Tarea | Cambio |
|---|---|---|
| `docs/planes/2026-09-10-el-ci-vuelve-a-verde.md` | 0 | Crear: este plan, copiado tal cual |
| `.claude/agents/implementador.md` | 0 | Crear: subagente Sonnet con esfuerzo alto |
| `vitest.config.ts` | 1 | `execArgv: ["--no-experimental-webstorage"]` |
| `vitest.setup.ts` | 1 | `beforeEach` que vacía `localStorage` (solo jsdom) |
| `vitest.setup.test.ts` | 1 | Crear: resguardo del entorno |
| `src/components/inbox/inbox-sidebar.test.tsx` | 1 | Test de ausencia con stub explícito; cabecera corregida |
| `docs/GLOSARIO.md` (fila de `vitest.config.ts` / `vitest.setup.ts`, ~línea 28) | 1 | Actualizar |
| `CLAUDE.md` | 2 | Trampa nueva y comando para ver el CI sin `gh` |

---

## Tarea 0 · El plan a mano y el implementador Sonnet (orquestador, sin subagente)

- [ ] Copiar este plan tal cual a `docs/planes/2026-09-10-el-ci-vuelve-a-verde.md`.
- [ ] Crear `.claude/agents/implementador.md`:

```markdown
---
name: implementador
description: Implementa UNA tarea de un plan ya aprobado del SBK CRM bajo la metodología liminalwork. Recibe el texto de su tarea tal cual, no commitea y entrega el reporte obligatorio al orquestador.
model: sonnet
effort: high
---

Implementas UNA tarea de un plan aprobado del repo SBK CRM. Antes de escribir,
lee `CLAUDE.md`, `docs/GLOSARIO.md` y los archivos que nombra tu tarea.

- Todo en español: comentarios (el porqué y la historia, con fecha), logs y
  textos de interfaz.
- Sigue los pasos de tu tarea en orden. Si un paso dice que un test debe
  fallar, comprueba que falla antes de seguir; si no falla, detente y
  repórtalo.
- No commitees ni hagas push. No toques archivos fuera de tu tarea.
- Pruebas de mutación: respalda con `cp` antes de mutar y restaura desde esa
  copia. Nunca `git checkout -- <archivo>`.
- Si el plan no decide algo, elige lo más simple que respete `CLAUDE.md` y
  anótalo. Si la decisión cambia el plan, detente y repórtalo.
- Termina con el reporte: qué implementaste y qué decidiste; archivos
  tocados; salida de los tests de la tarea, de `rtk npx tsc --noEmit` y de
  `rtk npm run lint`; problemas, deuda o desvíos respecto al plan.
```

- [ ] Commit (ver "Commits").
- [ ] Confirmar que `implementador` aparece entre los tipos de agente
  disponibles. Si no aparece, porque la sesión carga los agentes al arrancar,
  pedir al operador que reinicie con `claude --continue`. Como último recurso,
  usar `subagent_type: "general-purpose"` + `model: "sonnet"` (con el esfuerzo
  por defecto) y avisar al operador.

## Tarea 1 · La suite local ve el mismo almacenamiento que el CI y cada test arranca limpio (subagente `implementador`)

**Archivos:** crear `vitest.setup.test.ts`; modificar `vitest.config.ts`,
`vitest.setup.ts`, `src/components/inbox/inbox-sidebar.test.tsx` (`:2265-2276`
y `:2344-2349`) y `docs/GLOSARIO.md` (la fila de `vitest.config.ts` /
`vitest.setup.ts` / `vitest.server-only-stub.ts`).

**Produce:** un entorno de pruebas con el `localStorage` real de jsdom tanto
en Node 22 como en 26, vacío al empezar cada test.

- [ ] **Paso 1. El resguardo, en rojo.** Crear `vitest.setup.test.ts` en la
  raíz, junto a `vitest.setup.ts`:

```ts
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

/**
 * Resguardo del entorno de pruebas (10/9/2026). El CI estuvo rojo desde el
 * 6/9 sin que nadie lo viera: esta máquina corre Node 26, que deja
 * `localStorage` en `undefined` dentro de jsdom, y el CI corre Node 22, donde
 * jsdom trae uno real y lo que guarda un test lo hereda el siguiente. Estos
 * dos tests fijan las dos mitades del arreglo: que el almacenamiento exista
 * en cualquier Node (`execArgv` en vitest.config.ts) y que cada test arranque
 * con él vacío (`beforeEach` en vitest.setup.ts). El segundo depende de que
 * el primero corra antes —vitest corre en orden los tests de un archivo—, y
 * es a propósito: es exactamente el contagio que no puede volver a pasar.
 */
describe("entorno de pruebas: el localStorage de jsdom", () => {
  it("existe, igual que en el Node 22 del CI", () => {
    expect(typeof globalThis.localStorage?.setItem).toBe("function");
    globalThis.localStorage.setItem("sbk:resguardo", "lo-escribió-el-test-anterior");
  });

  it("cada test arranca con el almacenamiento vacío", () => {
    expect(globalThis.localStorage.getItem("sbk:resguardo")).toBeNull();
    expect(globalThis.localStorage.length).toBe(0);
  });
});
```

- [ ] **Paso 2. Ver el rojo.** `rtk npx vitest run vitest.setup.test.ts`.
  Esperado: FALLAN los dos, el primero con `expected 'undefined' to be
  'function'`.

- [ ] **Paso 3. La bandera.** En `vitest.config.ts`, dentro de `test`,
  justo después de `setupFiles`:

```ts
    // 10/9/2026: Node 25+ trae Web Storage nativo y, sin --localstorage-file,
    // deja `localStorage` en undefined dentro de jsdom; Node 22 (el del CI y
    // el del Dockerfile) no lo trae y jsdom pone uno real. Con esa diferencia
    // la suite local daba verde mientras el CI estaba rojo (desde el 6/9:
    // estado de inbox-sidebar heredado de un test al siguiente). Apagar el
    // nativo deja a jsdom igual en las dos versiones. Aceptada por Node
    // 22.23.2 y 26.3.0 (probado el 10/9/2026).
    execArgv: ["--no-experimental-webstorage"],
```

- [ ] **Paso 4. El contagio, visible en local.**
  `rtk npx vitest run vitest.setup.test.ts`. Esperado: pasa el primero y
  FALLA el segundo (`expected 'lo-escribió-el-test-anterior' to be null`).
  Después, `rtk npx vitest run src/components/inbox/inbox-sidebar.test.tsx`.
  Esperado: 15 fallas, las mismas del CI (entre ellas `expected 'Mías' to be
  'Pendientes'`).

- [ ] **Paso 5. La limpieza.** En `vitest.setup.ts`, agregar `import {
  beforeEach } from "vitest";` debajo del import de `jest-dom`, y al final del
  archivo:

```ts
/**
 * 10/9/2026: jsdom conserva su `localStorage` durante todo un archivo de
 * pruebas, así que lo que guardaba un test (la píldora y el orden de la
 * bandeja, `sbk:inbox:{agentId}`) lo heredaba el siguiente. En el CI (Node
 * 22) eso dejó rojos 15 tests de inbox-sidebar.test.tsx desde el 6/9; en
 * local no se veía porque Node 26 no le daba `localStorage` a jsdom (ver
 * `execArgv` en vitest.config.ts). Se vacía ANTES de cada test para que cada
 * uno arranque limpio sin depender del orden de los `afterEach`. Si algún día
 * falta el almacenamiento, no se lanza desde acá: el contrato del entorno lo
 * cuida vitest.setup.test.ts.
 */
if (typeof window !== "undefined") {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      // Un stub sin `clear` o un almacenamiento bloqueado: nada que vaciar.
    }
  });
}
```

- [ ] **Paso 6. Verde.** `rtk npx vitest run vitest.setup.test.ts
  src/components/inbox/inbox-sidebar.test.tsx`. Esperado: 2 + 87 en verde.

- [ ] **Paso 7. Comprobar que el test de la ausencia hoy no prueba nada.**
  Respaldar `src/components/inbox/inbox-sidebar.tsx` con `cp`. Borrar el
  `try`/`catch` de la LECTURA (`:341-362`), dejando el cuerpo del `try` tal
  cual. Correr `rtk npx vitest run src/components/inbox/inbox-sidebar.test.tsx
  -t "sin localStorage disponible"`. Esperado: VERDE aunque la guarda ya no
  existe, porque el entorno ahora trae almacenamiento. Restaurar con `cp`.

- [ ] **Paso 8. El test de la ausencia prueba la ausencia.** Reemplazar el
  test de `inbox-sidebar.test.tsx:2344-2349` por:

```ts
  it("sin localStorage disponible no rompe ni al montar ni al cambiar de píldora", () => {
    // La ausencia se simula a propósito: el entorno de pruebas SÍ trae el
    // localStorage de jsdom (execArgv en vitest.config.ts, 10/9/2026). El
    // afterEach de este describe lo restaura con vi.unstubAllGlobals().
    vi.stubGlobal("localStorage", undefined);

    expect(() => renderSidebar(JEFA)).not.toThrow();
    // Un error dentro de un efecto no siempre sale por `render`: en React 19
    // puede desmontar la raíz y reportarse aparte. Que las píldoras sigan en
    // pantalla es la prueba de que la bandeja sobrevivió.
    expect(activePillLabel()).toBe("Pendientes");

    expect(() => irATodos()).not.toThrow();
    expect(activePillLabel()).toBe("Todos");
  });
```

  Y reemplazar el comentario de cabecera de `:2265-2276` por:

```ts
/**
 * T2.2 del plan "La bandeja que no pierde" (5/9/2026): la píldora y el orden
 * activos se recuerdan entre sesiones bajo `sbk:inbox:{agentId}`. Los tests
 * que necesitan un almacenamiento con contenido controlado instalan uno falso
 * con `vi.stubGlobal`; el que prueba la AUSENCIA de almacenamiento la simula
 * con `vi.stubGlobal("localStorage", undefined)`.
 *
 * 10/9/2026: este comentario decía que "Node 22+" dejaba `localStorage` en
 * `undefined` dentro de jsdom. Era falso justo para Node 22, el del CI: ahí
 * jsdom trae uno real, el estado se contagiaba de un test al siguiente y el
 * CI estuvo rojo desde el 6/9 mientras la suite local (Node 26, sin
 * almacenamiento) daba verde. Desde entonces el entorno trae el de jsdom en
 * cualquier Node (`execArgv` en vitest.config.ts) y vitest.setup.ts lo vacía
 * antes de cada test.
 */
```

  Correr `rtk npx vitest run src/components/inbox/inbox-sidebar.test.tsx`.
  Esperado: 87 en verde.

- [ ] **Paso 9. Mutaciones.** Siempre con respaldo por `cp` y restaurando
  después de cada una:
  1. En `inbox-sidebar.tsx`, borrar el `try`/`catch` de la lectura
     (`:341-362`). Esperado: el test de la ausencia en ROJO (falla el test o
     vitest reporta un error no manejado que tumba la corrida).
  2. En `inbox-sidebar.tsx`, borrar el `try`/`catch` de la escritura
     (`:374-381`). Esperado: el test de la ausencia en ROJO.
  3. En `vitest.setup.ts`, comentar `globalThis.localStorage?.clear();`.
     Esperado: `vitest.setup.test.ts` en rojo en el segundo test, e
     `inbox-sidebar.test.tsx` de vuelta a 15 fallas.
  4. En `vitest.config.ts`, comentar la línea `execArgv`. Esperado:
     `vitest.setup.test.ts` en rojo en el primer test.

- [ ] **Paso 10. Glosario.** En `docs/GLOSARIO.md`, en la fila de
  `vitest.config.ts` / `vitest.setup.ts` / `vitest.server-only-stub.ts`: sumar
  `vitest.setup.test.ts` a la lista de archivos y agregar al final de la
  celda: "10/9/2026: `execArgv: ["--no-experimental-webstorage"]` para que
  jsdom tenga el mismo `localStorage` real en Node 22 (CI) y en Node 26
  (local), y `vitest.setup.ts` lo vacía en un `beforeEach`;
  `vitest.setup.test.ts` es el resguardo de las dos cosas (el CI estuvo rojo
  desde el 6/9 por estado heredado entre tests de `inbox-sidebar.test.tsx`)."

- [ ] **Paso 11. Suite, tipos y lint.** `rtk npm run test`: todo en verde. Ya
  no debería aparecer el aviso `ExperimentalWarning: localStorage is not
  available`; si aparece, anotarlo pero no es una falla. Además, `rtk npx tsc
  --noEmit` y `rtk npm run lint` sin errores. Entregar el reporte.

## Tarea 2 · La documentación (subagente `implementador`, cuando la Tarea 1 esté commiteada)

**Archivos:** `CLAUDE.md`.

- [ ] **Paso 1. Trampa nueva**, al final de "Trampas conocidas":

```markdown
- **La suite local y el CI no corren el mismo Node, y el CI no frena el
  deploy** (10/9/2026). Esta máquina corre Node 26; el CI y el Dockerfile,
  Node 22. Node 25+ trae Web Storage nativo que, sin `--localstorage-file`,
  deja `localStorage` en `undefined` dentro de jsdom; en Node 22 jsdom trae
  uno real. Con esa diferencia, 15 tests de `inbox-sidebar.test.tsx`
  heredaban la píldora que guardaba el test anterior y el paso "Pruebas" del
  CI estuvo ROJO desde el 6/9 (`1379b2c`) hasta el 10/9 mientras la suite
  local daba verde. Nadie lo vio porque Dokploy despliega con el push sin
  esperar al CI: `2f80f1e`, la versión en producción, salió con el CI en
  rojo. Desde entonces `vitest.config.ts` pasa `--no-experimental-webstorage`
  a los workers (`execArgv`), `vitest.setup.ts` vacía `localStorage` antes de
  cada test y `vitest.setup.test.ts` fija las dos cosas. **Después de cada
  push, mirar el CI**: sin `gh` alcanza la API pública (ver Comandos; campos
  `head_sha`, `status`, `conclusion`). GitHub muestra solo 10 anotaciones por
  paso: si hay más fallas, reproducirlas en local.
```

- [ ] **Paso 2. Comandos.** En el bloque de "Comandos" de `CLAUDE.md`,
  agregar debajo de la línea del build:

```bash
curl -s "https://api.github.com/repos/zexfer24/sbk-crm-evolved/actions/runs?per_page=3"  # CI de los últimos push (sin gh)
```

- [ ] **Paso 3.** Releer el diff de `CLAUDE.md` y entregar el reporte.

## Commits (los hace el orquestador, en este orden, con `git commit -F <archivo>` y el trailer de atribución de su sesión)

1. Tarea 0: **El plan del CI en verde y un implementador Sonnet con esfuerzo
   alto quedan escritos**. Archivos: `docs/planes/2026-09-10-el-ci-vuelve-a-verde.md`
   y `.claude/agents/implementador.md`.
2. Tarea 1: **La suite local ve el mismo almacenamiento que el CI y cada test
   arranca limpio**.
3. Tarea 2: **La documentación cuenta cómo el CI estuvo rojo desde el 6/9 sin
   que nadie lo viera**.

## Verificación final (orquestador)

- [ ] `rtk npm run test`, `rtk npx tsc --noEmit` y `rtk npm run lint`, todos en
  verde.
- [ ] El comando exacto del CI: `rtk npm run test -- --no-file-parallelism`,
  en verde.
- [ ] Sin build: ningún archivo de la aplicación cambia (`next build` no lee
  la configuración de vitest), y el CI compila igual.
- [ ] `git diff 38a540e..HEAD --stat`: solo los archivos de la tabla.

## Salida (la decide el operador)

- El push a `main` dispara el rebuild de Dokploy (unos 5 min de compilación y
  unos 22 s de servicio cortado): hacerlo fuera de hora pico.
- **Criterio de terminado:** el CI del último commit termina en `success` en
  los dos jobs (`verificar` y `migraciones`), consultado con la API.

## Reporte de entrega

| Commit | Migración | Variables | Toca | Verificado |
|---|---|---|---|---|
| Tarea 0 | No | No | Solo documentación y configuración de agentes | — |
| Tarea 1 | No | No | Solo pruebas (configuración de vitest y tests) | suite, tsc, lint, 4 mutaciones |
| Tarea 2 | No | No | Solo documentación | — |

Aunque ninguno toca la aplicación, el push reconstruye la imagen igual.

## Pendientes fuera de esta corrida

- Confirmar en qué commit está producción y si ya estaban aplicadas
  `20260909050000` y `20260910010000`.
- Verificar en pantalla el Recorrido de producción ("Primer contacto" con los
  números nuevos del día, la tarjeta repetida en su etapa real y "entraron
  hoy" debajo de "Nuevos").
- Recomendación para el VPS: que Dokploy despliegue solo cuando el CI termina
  en verde.

---

## Prompt orquestador (para pegar en la sesión que ejecute)

```text
Actúa como ORQUESTADOR bajo la metodología liminalwork (léela con la skill)
junto con CLAUDE.md y docs/GLOSARIO.md. El plan ya está aprobado y vive en
docs/planes/2026-09-10-el-ci-vuelve-a-verde.md (si todavía no existe, está en
C:\Users\WinterOS\.claude\plans\elegant-twirling-barto.md). Léelo entero antes
de repartir nada.

1. La Tarea 0 la haces tú: copias el plan a docs/planes/, creas
   .claude/agents/implementador.md con el texto del plan y commiteas las dos
   cosas. Confirma que el tipo de agente "implementador" está disponible; si
   no lo está, pídeme reiniciar la sesión con claude --continue.
2. Tareas 1 y 2: un subagente por tarea, con subagent_type "implementador"
   (Sonnet, esfuerzo alto), en ese orden (la 2 recién cuando la 1 esté
   commiteada). Al subagente le pegas literalmente "Reglas para todos" y la
   sección completa de SU tarea; nada de resumirla.
3. No cierras una tarea sin su reporte Y sin correr tú mismo los comandos de
   verificación de la tarea. Si algo no cuadra, abres otro subagente con la
   corrección concreta; no parchees a mano.
4. Los commits los haces tú, con los títulos de la sección "Commits" y los
   mensajes largos con git commit -F <archivo>.
5. Al final corres la "Verificación final" y me entregas el reporte de
   entrega. No hagas push: pregúntame.
```
