# Plan · "La búsqueda encuentra lo que el cliente pide" (25/9/2026)

## Contexto

`buscar_repuesto` está apagada desde el 25/8. Al simularla en el VPS contra el catálogo real (6.035 productos que llegan de Saint), la búsqueda falló en casi la mitad de los casos:
- `tools.ts:333-335` corta con `.limit(31)` sin `order`, y recién después `rankByTerms` ordena esas 31.
- Usa subcadenas: "rin" trae ORINGS.
- No entiende plurales.
- Descarta los números cortos ("45", "DT 200").
- Filtra la moto por `product_compatibility`, que tiene 0 filas.
- Hace la pregunta de filtro en 235 de 300 consultas reales.

Además, Seba copió precios del historial ("108$ BCV" del 10/9, repetido el 20/9) y calculó cuotas de Cashea.

Esta ola corrige la búsqueda en SQL, decide cuándo una consulta es genérica según lo que de verdad calza, agrega una guarda en código contra cifras sin fuente y ajusta el guion y el formato del precio. Después, el código de la IA queda congelado por meses. Por eso cada regla lleva un test que se sostiene solo.

**Decisiones del operador (Plan Mode):**
- **D1 aprobada.** Se agrega un segundo texto fijo de filtro para cuando la moto no importa.
- **Tolerancia: N−1 solo cuando hay 4 términos o más.** Con 1 a 3 términos se exige que calcen todos. Cuenta como coincidencia completa la fila con el puntaje más alto, siempre que ese puntaje sea N (N ≤ 3) o al menos N−1 (N ≥ 4). Si alguna fila calza con todos, solo cuentan esas.
- **Lista corta de palabras de relleno** en `searchTerms`, con test: `para, con, del, los, las, que, una, precio, tienen, hay`.
- En el VPS, "asiento sbr original" ya calza 3/3 y "disco freno delantero dt200" calza 4/4 con singular + unión letra-número. Por eso la regla estricta con 3 términos no deja afuera esos casos.

**Estado de git (corregido por el operador):** `34a5b65` ya está en producción (push 05:40:18 UTC, Dokploy desplegó solo a las 05:42, verificado en el VPS). **El push a `main` SÍ despliega.** Por eso esta entrega **no va a `main`**: se pushea a `entrega/busqueda-que-encuentra`, y el VPS aplica la migración y después hace fast-forward de `main` a esa rama. Primero `git fetch` y se parte de `origin/main` (`34a5b65`). La memoria `push-a-main-no-despliega.md` se corrige al salir de Plan Mode. `docs/entregas/2026-09-25-tasa-bcv-y-pendientes-del-inventario.md` no se toca si sigue sin commitear.

**Rol con el que corre la IA:** `service_role`. `runAgentTurn` crea `createAdminClient()` (`agent.ts:3162`) y se lo pasa a `buildCatalogTool` por `ToolDeps`. El simulador (`api/dev/simulate-message`) también pasa por `runAgentTurn`. Ningún camino con sesión llama a `buildCatalogTool`.

---

## Desvíos respecto del prompt (justificados)

1. **Los términos viajan como grupos de alternativas (`jsonb`, arreglo de arreglos), no como `text[]` plano.** Un grupo calza si calza cualquiera de sus alternativas. Hace falta por dos motivos:
   - **Sinónimos.** Con la regla estricta, `maleta 45 litros` + sinónimo `litros→lts` en plano daría 4 términos (`maleta, 45, litro, lts`). Ningún producto dice "litro" y "lts" a la vez, así que fallaría. Como grupos da 3: `{maleta} {45} {litro|lts}`, y MALETA CUADRADA 45 LTS calza 3/3. Hoy un sinónimo reemplaza al término, no lo suma.
   - **Letra + número.** "dt 200" genera el grupo `{dt200 | dt 200}` y el "200" suelto desaparece. Así calza tanto el catálogo que escribe `DT200` como el que escribe `DT 200`, y el "200" no queda como término obligatorio que calce con cualquier cosa. Si las letras tienen 3 o más ("sbr 200"), se agrega la alternativa `sbr` al mismo grupo.
2. **`searchTerms` (plano) sigue existiendo**, porque lo usa también `knowledge.ts:58` (biblioteca). Gana singular, números de 2+ dígitos, unión letra+número y palabras de relleno, y la biblioteca hereda esas mejoras. Para el catálogo se agrega `catalogTermGroups(query, synonyms)`.
3. **La función es `security invoker`, no `definer`.** La llama `service_role`, que se salta RLS, así que no paga `is_agent()` por fila (la trampa de `search_conversations_by_message`). Así no aparece una nueva función `security definer` que contar en `permisos-funciones.test.ts`. Los revokes de la convención se aplican igual.
4. **Fuentes permitidas de la guarda T3:** se suma **(c) las lecciones de Seba del turno** (`lessons` global + del chat, que ya están en el prompt). Son texto del operador; si "compras mayores a $100" está cargado como lección y no en la biblioteca, la guarda no puede bloquearlo. El historial anterior sigue prohibido.
5. **El texto fijo de D1 lo agrega T4** (que ya edita la sección 3 del prompt y lo necesita), no T2. Así T2 y T3 no tocan `seba.ts` al mismo tiempo.

---

## T1 — `buscar_productos` + términos (Sonnet)

**Migración** `supabase/migrations/20260926010000_busqueda_ordena_antes_de_recortar.sql` (sale sola en un commit `[migración]`):

```
public.buscar_productos(p_terminos jsonb, p_moto jsonb default '[]', p_limite int default 10)
returns table(id, name, brand, price, currency, stock_quantity, updated_at,
              compatibilidad jsonb,          -- agregado de product_compatibility (hoy siempre [])
              puntaje int, puntaje_moto int,
              puntaje_maximo int, filas_con_puntaje_maximo bigint,
              puntaje_moto_maximo int,       -- max(puntaje_moto) entre las filas con puntaje = puntaje_maximo
              filas_con_maximo_y_moto bigint) -- filas con puntaje = puntaje_maximo Y puntaje_moto = puntaje_moto_maximo
language sql stable security invoker set search_path = public, pg_catalog
```

- **Escapado.** Cada alternativa se escapa como regex con `regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')` y como patrón `like` (`\`, `%`, `_`). Los términos llegan como parámetros; no hay SQL dinámico.
- **Prefiltro** (se mantiene para el trigram): `is_active and price > 0 and search_text ilike any(<'%alt%' de todos los grupos de producto>)`. La moto nunca entra al prefiltro.
- **Puntaje.** `puntaje` = cuántos grupos de producto tienen alguna alternativa con `search_text ~ ('\m' || escapada)`. `puntaje_moto` = lo mismo con los grupos de moto.
- **Conteos antes del límite.** `puntaje_maximo = max(puntaje) over ()` y `filas_con_puntaje_maximo = count(*) filter (where puntaje = max) over ()`, calculados antes del `limit`. Lo mismo vale para `puntaje_moto_maximo` y `filas_con_maximo_y_moto`, que se calculan sobre las filas con puntaje máximo de producto.
- **Orden:** `puntaje desc, puntaje_moto desc, (stock_quantity > 0) desc, name`. Después, `limit least(greatest(p_limite,1),50)`.
- **Topes defensivos:** como máximo 12 grupos y 4 alternativas por grupo. Si viene más, se recorta y no se lanza error.
- **Permisos:** `revoke execute … from public`, `revoke execute … from anon, authenticated`, `grant execute … to service_role`, más `notify pgrst, 'reload schema'`. La migración solo crea la función y no bloquea `products`, así que no hace falta el candado `lock_timeout`.

**Test SQL** `supabase/tests/buscar_productos.sql` (patrón `do $$ … raise exception` de los existentes, todo dentro de `begin … rollback`). Corre como `postgres`, así que el trigger de solo lectura de `products` lo deja insertar.
- **Fixture:**
  - Los 6 nombres reales del §2.1.
  - Ruido: ORINGS, MAGNETO DT200 MS, GOMA ASIENTO UNIVERSAL TRACTOR, BASE MALETA COLORES GP, PATIN CADENA TX LECHUZA…
  - **Más de 31 filas** con "delantero" o "freno", insertadas **antes** que los correctos.
  - 13 intercomunicadores.
  - 1 producto con `price = 0`.
  - Pastillas de freno para varias motos, una de ellas BERA.
- **Casos:**
  - La tabla §5: el primero esperado en cada una. En la de maleta, el grupo es `{litro|lts}`.
  - `intercomunicador`: `filas_con_puntaje_maximo` = 13.
  - `rin` no trae ORINGS.
  - El producto con `price = 0` no aparece nunca.
  - Términos `(`, `[`, `.`, `*`, `\`, `'`, `%`, `_`: no lanza error y no calza de más (`.` no calza con cualquier carácter y `%` no es comodín).
  - `pastilla, freno` + moto `{bera}`: la de BERA sale primera, `filas_con_puntaje_maximo` no cambia por la moto, `puntaje_moto_maximo` = 1 y `filas_con_maximo_y_moto` = 1.
  - `aceite, motul, 5100` + moto `{kavak}` sin ningún aceite Kavak: `puntaje_moto_maximo` = 0.
  - `has_function_privilege`: `anon` y `authenticated` dan false, `service_role` da true.

**`catalog-search.ts`** (+ test):
- `singular(w)`:
  - Una palabra que contiene dígitos no se toca.
  - Si termina en `[rlndjy]` + "es" y tiene 5 o más letras, se quita "es": intercomunicadores → intercomunicador, rines → rin, motores → motor.
  - Si no, cuando termina en "s", tiene 4 o más letras y no está en `NO_PLURAL = {tres, seis, gas, mas, jes, dos, mes, bus}`, se quita la "s": baterias, defensas, pastillas, ejes → eje, cascos.
  - Por ser coincidencia por **inicio** de palabra, el singular calza también con el plural del catálogo.
- `searchTerms`:
  - Normaliza y parte en palabras.
  - Conserva las palabras de 3+ letras y los números de 2+ dígitos (45, 12, 150).
  - Une un token de 1 a 4 letras con el número que lo sigue (dt 200 → dt200).
  - Pasa a singular y después quita el relleno (`para, con, del, los, las, que, una, precio, tienen, hay`; "precios" → "precio" → se quita).
  - Deduplica. El fallback de consulta entera se mantiene.
- `catalogTermGroups(query, synonyms): string[][]`:
  - Un grupo por término, con la alternativa espaciada para las uniones letra+número.
  - Los sinónimos se aplican **después** del singular: `singular(normalize(from))` contra el término.
  - `to` se agrega normalizado, reducido a `[a-z0-9 ]` y sin pasar a singular, porque es el nombre real que escribió el asesor.
  - `expandTerms` se reemplaza (o queda privado).
- Se borran `catalogFilter` y `rankByTerms` (con sus tests, ya sin uso), y se reescriben los comentarios que quedaron falsos ("tres o más letras", `.or()`).
- **Tests:**
  - Singular de intercomunicadores, baterias, defensas y pastillas.
  - gas, tres y jes quedan igual.
  - Se conservan 45 y 150.
  - "dt 200" → grupo `[dt200, dt 200]`.
  - Relleno: "precio de pastillas para bera" → pastilla, bera.
  - Un sinónimo en plural ("litros→lts") expande.
  - `knowledge.test.ts` sigue en verde.

## T4 — Guion, formato del precio y D1 (Sonnet, en paralelo con T1)

- **`precio.ts`:** `formatQuote` → `"$102,84 BCV (Bs. 88.000,00)"`. Se actualiza `precio.test.ts`.
- **`seba.ts`:** `PREGUNTA_FILTRO_PRODUCTO = "Claro, ¿tienes alguna marca, medida o modelo en mente?"`, con test de `revealsIdentity` en `seba.test.ts`. `PREGUNTA_FILTRO` no cambia.
- **`prompt.ts`** (todo en `SYSTEM_PROMPT`, el prefijo cacheable; nada nuevo en el sufijo):
  - **Sección 2:** la línea 219 queda "Nunca inventes existencia, precio ni compatibilidad de un repuesto." Lo de "no lo tenemos en el catálogo" se borra. Sobre cálculos: no sumas, no multiplicas ni calculas cuotas, iniciales, totales ni precio por cantidad; eso lo da el asesor. Puedes decir la condición de Cashea tal como la trae la biblioteca, sin hacer la cuenta.
  - **Sección 3:** la regla de la única pregunta nombra los dos textos y cuándo va cada uno. «PREGUNTA_FILTRO» va si el repuesto depende de la moto (piezas de motor, frenos, carrocería, eléctrico). «PREGUNTA_FILTRO_PRODUCTO» va si no depende (aceites, cascos, intercomunicadores, maletas, accesorios).
  - **Sección 4, junto al párrafo de la búsqueda:** el formato con "BCV". Un precio del historial, tuyo o de un asesor, no es el de hoy porque la tasa cambia a diario: si vuelven a preguntar, se busca de nuevo.
  - **Sección 5.5:** si el cliente contesta la pregunta de filtro con una moto, una marca o una medida, se busca de nuevo con eso.
- **`prompt.test.ts`:**
  - La sección 2 ya no dice "no lo tenemos en el catálogo".
  - La regla de historial y cuentas está en `cacheablePrefix()`.
  - Aparecen los dos textos de filtro.
  - El prefijo sigue pasando `revealsIdentity`.

## T2 — `buildCatalogTool` usa la función (Sonnet, después de T1 y T4)

- **Consulta:** `supabase.rpc("buscar_productos", { p_terminos: grupos, p_moto: grupos de motoBrand+motoModel, p_limite: MAX_CATALOG_RESULTS })`. Se agrega la firma a mano en `database.types.ts` (Functions). Desaparecen `.or(catalogFilter)`, `CATALOG_FETCH_LIMIT` y `rankByTerms`, y el comentario se reescribe con lo que el código hace de verdad.
- **Decisión:** N = cantidad de grupos de producto. `requerido = N ≤ 3 ? N : N − 1`.
  - Sin filas, o `puntaje_maximo < requerido` → `sinResultados` / `NO_IDENTIFICADO_INSTRUCTION`, sin insertar cotizaciones.
  - **Moto que nombra algo (corrección del operador).** Si `p_moto` no está vacío y la primera fila tiene `puntaje_moto > 0`, entonces `quoted` = las filas con `puntaje = puntaje_maximo` **y** `puntaje_moto = puntaje_moto_maximo`, y `coinciden = filas_con_maximo_y_moto`. No es genérico, porque el cliente ya dio la moto.
  - **Moto que nadie nombra.** Si `p_moto` viene vacío, o si ninguna fila del máximo nombra la moto (`puntaje_moto_maximo = 0`), la moto se ignora y rige la regla sin moto: `coinciden = filas_con_puntaje_maximo` y `quoted` = las filas con `puntaje = puntaje_maximo` (como mucho 10, ya ordenadas).
  - `hayMas = coinciden > 10`.
  - **Genérico** = `coinciden > 3` sin moto que calce. Con 1 a 3 se cotiza. Si la moto llegó pero se ignoró y es genérico, la instrucción manda **solo** `PREGUNTA_FILTRO_PRODUCTO` (`GENERICO_MOTO_IGNORADA_INSTRUCTION`), porque volver a preguntar por la moto no tiene sentido.
  - La precedencia generico → conExistencia → agotados queda igual. Solo cambia **cuándo** se marca cada una.
- **Filtros por `product_compatibility`:** se quedan, aplicados sobre `compatibilidad`, con un comentario que dice que hoy la tabla tiene 0 filas y no filtran nada. Se reescriben las `.describe()` de `motoBrand`/`motoModel` (ordenan, no filtran) y la de `query` (solo el nombre del repuesto, sin relleno).
- **`GENERICO_INSTRUCTION`:** lleva los dos textos y el criterio de D1.
- **`conversation_quotes`:** sigue registrando exactamente `quoted`.
- **`tools.test.ts`:** el fake de Supabase suma `.rpc()` y registra nombre y argumentos.
  - **Nuevos:**
    - motul 5100 20w50 con 1 fila de puntaje máximo → cotiza, no es genérico.
    - pastillas de freno con 5 filas → genérico, y `p_moto` va vacío.
    - La misma consulta con `motoModel` → no es genérico y `p_moto` lleva la moto.
    - **(a)** 5 pastillas, una BERA, con moto bera → cotiza **solo** la BERA.
    - **(b)** "aceite motul 5100" con moto kavak y ningún aceite que diga Kavak → cotiza igual que sin moto.
    - La moto ignorada con más de 3 coincidencias → genérico con `PREGUNTA_FILTRO_PRODUCTO` y sin la pregunta de moto.
    - `puntaje_maximo < requerido` → no_identificado.
    - N = 4 con máximo 3 → cotiza (tolerancia).
    - N = 3 con máximo 2 → no_identificado.
    - Una fila con puntaje menor que el máximo no se cotiza.
    - `precio` sale con "BCV".
  - **Adaptados sin perder la aserción:** recorte (`p_limite` = 10, el aviso de recorte con `filas_con_puntaje_maximo > 10`), antigüedad, sinónimos (el grupo lleva la alternativa), alcance de sinónimos, `clienteNoNombroRepuesto` (no llama a `rpc`), error de base, y los casos genérico / tres / exactamente tres (ahora medidos con `filas_con_puntaje_maximo`).

## T3 — Guarda de cifras sin fuente (Sonnet, después de T4; en paralelo con T2)

**`src/lib/ai/price-guard.ts`** (puro, mismo patrón que `identity-guard.ts`):
- `moneyFigures(text)`: un número pegado, antes o después, a `US$`, `$`, `USD`, `dólar(es)`, `Bs`/`Bs.`, `bolívar(es)` o `BCV` (con `\b` para que "Bs" no calce dentro de palabras). Número: `\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`. "30%" no es dinero.
- `numericReadings(raw)`: todas las lecturas posibles (VE `88.000,00`; US `12.50`; ambiguo `88.000` → 88000 y 88). `sourceNumbers(texts)` extrae todas las lecturas de cualquier número de las fuentes.
- `findUnsourcedFigure(text, sources): string | null`: una cifra pasa si **alguna** de sus lecturas coincide con **alguna** lectura de las fuentes, con tolerancia de 0,005.

**En `agent.ts`**, justo antes de `applyIdentityGuard` (≈2951), solo en el camino del tool loop y si `text.trim()`:
- **Fuentes:**
  - (a) `JSON.stringify` de cada `output` de `result.steps[].toolResults` (mismo acceso defensivo que `toolNamesUsed`; se guardan los `steps` fuera del `try`).
  - (b) `rafagaCliente` (`pendingCustomerLines`).
  - (c) El texto de `lessons`.
  - Nunca `history`.
- **Si hay una cifra sin fuente:**
  - `log.warn("cifra_sin_fuente", { conversationId, cifra })`.
  - Si `!esperandoAsesor && !outcome.escalated` → `escalateConversation(… motivo: "confirmar_inventario" …)` y se copian los campos de `outcome` como en las otras redes.
  - El texto pasa a `TEXTO_PRECIO_A_CONFIRMAR` (nuevo en `seba.ts`: «Para darte el precio de hoy te paso con un asesor, que te lo confirma por acá.»). Si `outcome.unassigned`, se le añade `DESPEDIDA_SIN_ASESOR`.
  - `priceMark = true` → prefijo `"[cifra sin fuente] "` en el `summary` de `logTurn`, junto a `identityPrefix`. No hace falta columna nueva.
- El texto reemplazado pasa después por la guarda de identidad, como todo.

**Tests:**
- **`price-guard.test.ts`:**
  - Caso 20/9 (historial con "108$ BCV", sin herramientas, "El intercomunicador sale en *108$ BCV*") → bloqueado.
  - Caso 13/9 ($36,60, $85,40, $14,23) → bloqueado.
  - Pasan: "$102,84 BCV (Bs. 88.000,00)" presente en la salida de la herramienta, "los de $44" dicho por el cliente, "mayores a $100" venido de la biblioteca (y de una lección), "30%" solo, y el monto del historial de compras en una devolución.
  - Formatos: 108$, $ 108, 108,00 $, Bs. 88.000,00, 88000 bs, US$ 12.50.
- **`seba.test.ts`:** `TEXTO_PRECIO_A_CONFIRMAR` pasa `revealsIdentity`.
- **`agent.test.ts`:**
  - Guarda bloqueando sin asesor → `escalateConversation` con `confirmar_inventario` y sale el texto fijo.
  - Con asesor → no hay segunda escalada.
  - Con la cifra dentro de un `toolResult` del mock → el texto sale tal cual.
  - Los tests de "red de seguridad del catálogo" siguen verdes **sin editar sus aserciones**.

## T5 — Documentación (Sonnet, al final)

- **`docs/GLOSARIO.md`:** `buscar_productos`, `price-guard.ts`, `catalog-search.ts` (grupos, singular, relleno), `precio.ts`.
- **`CLAUDE.md`:** trampas nuevas.
  - "La búsqueda ordena y cuenta en SQL: nunca `.limit()` sin orden sobre `products`."
  - "`product_compatibility` está vacía y la moto solo ordena."
  - La regla N / N−1 con sus casos.
  - "Una cifra de dinero de la IA necesita fuente en el turno."
- **`docs/PRODUCCION.md`:** el orden de encendido del §8 (backup → simulacro `BEGIN…ROLLBACK` → aplicar migración → deploy → re-simular §2.1/§2.3 con la función → encender `buscar_repuesto` → medir 48 h).
- **`docs/entregas/2026-09-26-la-busqueda-encuentra.md`:** reporte para el VPS, con los 5 puntos por commit.

---

## Orden y commits

- **Tanda 1:** T1 ∥ T4.
- **Tanda 2:** T2 ∥ T3 (archivos disjuntos: `tools*` contra `agent*`/`price-guard*`/`seba.ts`).
- **Tanda 3:** T5.

Cada subagente escribe primero el test en rojo, no commitea y entrega su reporte. Commits narrativos (con `git commit -F`):
1. `[migración] La búsqueda del catálogo ordena y cuenta en la base antes de recortar` (migración + test SQL).
2. La búsqueda entiende plurales, números cortos y modelos como DT200 (`catalog-search`).
3. Seba cotiza en dólares BCV y no hace cuentas ni repite precios viejos (T4).
4. Seba pregunta solo cuando calzan varios, y la moto ordena en vez de filtrar (T2).
5. Una cifra de dinero sin fuente en el turno no le llega al cliente (T3).
6. Docs y entrega (T5).

Al final: push a la rama **`entrega/busqueda-que-encuentra`** (nunca a `main`: el push a `main` despliega). En el reporte van el SHA exacto y el `git ls-remote --heads origin`. El CI corre solo sobre `main`/PR, así que se reproduce en local (y, si hace falta, con una rama `ci/**` desechable). La migración **no** se aplica desde acá: el VPS la aplica y después hace fast-forward de `main` a la rama. T5 además corrige en `CLAUDE.md`/`docs/PRODUCCION.md` todo lo que `34a5b65` dejó escrito sobre "el push a main no despliega".

## Verificación

- `rtk npm run test`, `rtk npx tsc --noEmit`, `rtk npm run lint`, `rtk proxy npm run build` (y el timestamp de `.next/BUILD_ID`).
- Todos los `supabase/tests/*.sql` contra la base local reconstruida (`docker exec … psql -1 -v ON_ERROR_STOP=1`).
- **`EXPLAIN (ANALYZE, BUFFERS)`** de `pechera ava deer` y `disco freno delantero dt200`, sobre la base local con ~6.000 productos sintéticos insertados como `postgres` dentro de `BEGIN … ROLLBACK`. El resultado va al reporte.
- **Mutaciones manuales** (respaldo con `cp`, nunca `git checkout`), con la tabla escrita a disco tras cada una:
  - (a) El límite antes del orden en la función → el test SQL se pone rojo.
  - (b) La guarda acepta números del historial → el caso del 20/9 se pone rojo.
  - (c) `generico` por `quoted.length > 3` → "motul 5100 20w50" se pone rojo.
  - Extra: (d) sin la tolerancia N−1 → el caso N = 4 se pone rojo; (e) sin `price > 0` → el test SQL se pone rojo.
  - **(f) (operador):** sin la restricción por `puntaje_moto_maximo` → el test (a) de las 5 pastillas se pone rojo.
- **Escenario a mano en local** con `buscar_repuesto` encendida (simulador): "¿tienen intercomunicadores?" → pregunta de producto; "rin delantero bera kavak" → cotiza con "BCV" y escala.

## Fuera de esta ola (decidido)

- Llenar `product_compatibility`.
- La cantidad de stock que se le dice al cliente.
- El camino de "espera abierta".
- Forzar `buscarRepuesto` con la intención "otro".
- Los sinónimos de jerga (los carga el operador).
- La tasa BCV cuatro veces al día (ya en `8cfc56a`).

---

## Correcciones durante la ejecución (26/9/2026)

Cuatro desvíos del orquestador sobre lo que este plan describía, ninguno
aprobado de antemano en Plan Mode — los cuatro se detectaron probando el
código contra consultas reales o corriendo las mutaciones de verificación,
y quedaron documentados acá y en `CLAUDE.md`/`docs/GLOSARIO.md`.

1. **La unión letra+número distingue por el largo de las letras (T1,
   `terminosCrudos`, `catalog-search.ts`).** El plan (desvío 1) solo describía
   la unión para 1 a 4 letras genéricamente ("si las letras tienen 3 o más
   [...], se agrega la alternativa suelta al mismo grupo"). Probando el
   agente contra consultas reales, "rin 17" armaba UN solo término con "rin"
   como alternativa suelta DENTRO del mismo grupo que "rin17"/"rin 17" — y
   "rin" solo ya calza cualquier rin del catálogo, así que la medida "17"
   dejaba de ser un requisito real de la búsqueda (cualquier rin, de
   cualquier medida, habría calzado igual). La unión final distingue por el
   largo de las letras: 1-2 letras ("dt", "cg") siguen siendo UN término,
   sigla y número solo tienen sentido pegados; 3-4 letras ("rin", "sbr") la
   palabra sale COMO TÉRMINO COMPLETO APARTE (un cliente puede preguntar
   "¿tienen rines?" sin medida) Y la unión sigue siendo obligatoria en un
   SEGUNDO término, con el número suelto como tercera alternativa (nunca
   como grupo propio, para no duplicar el requisito). Así "rin 17" exige
   tanto "rin" (grupo 1) como "rin17"/"rin 17"/"17" (grupo 2) — la medida no
   se pierde.
2. **Dedupe de grupos con la misma lista de alternativas
   (`catalogTermGroups`).** No estaba en el plan. "caucho 90/90-18" parte en
   cuatro tokens (caucho, 90, 90, 18) y el "90" repetido armaba DOS grupos
   idénticos (`[["90"],["90"]]`) — no agregan ningún requisito nuevo, solo
   inflan `p_terminos` que viaja a la base. Se deduplican los grupos con la
   MISMA lista de alternativas (después de aplicar sinónimos) y las
   alternativas repetidas DENTRO de un mismo grupo, conservando el orden de
   la primera aparición.
3. **La fixture del test SQL tuvo que insertar el ruido ANTES que los
   productos correctos.** La primera versión de `buscar_productos.sql`
   insertaba los 6 nombres reales del §2.1 primero y el ruido (ORINGS,
   MAGNETO DT200 MS, más de 31 filas con "delantero"/"freno"…) después. Con
   esa fixture, la mutación de verificación (a) — el límite antes del orden
   — seguía dando VERDE: los productos correctos, por estar insertados
   primero, ya quedaban entre las primeras filas que Postgres devuelve por
   orden físico sin `order by`, así que el bug que la migración corrige (el
   mismo de `tools.ts:333-335`) no se manifestaba en el test aunque el
   código mutado lo reintrodujera de verdad. Se reordenó la fixture (ruido
   primero, correctos después) y recién ahí la mutación puso el test en
   rojo. Ver la trampa nueva en `CLAUDE.md`: "un test SQL de orden tiene
   que insertar el ruido ANTES que la fila correcta".
4. **La mutación (c) exigió revertir también la selección de filas, no solo
   la condición de `generico` (T2, `tools.ts`).** El plan (verificación,
   mutación c) decía "`generico` por `quoted.length > 3`... 'motul 5100
   20w50' se pone rojo". La primera versión de esa mutación solo cambiaba
   la condición de `generico` (de `!motoCalza && coinciden > 3` a
   `!motoCalza && quoted.length > 3`), pero dejaba intacta la selección de
   filas nueva (`candidatos.filter((r) => r.puntaje === puntajeMaximo)`,
   que ya filtra correctamente antes de armar `quoted`). Con solo ese
   cambio, `quoted.length` seguía coincidiendo con `coinciden` en el caso de
   prueba — la mutación no cambiaba nada observable y el test seguía verde,
   dando una falsa sensación de que la aserción no dependía del conteo de
   la base. Hubo que revertir las DOS cosas juntas (la condición de
   `generico` Y la selección de filas, volviendo a la vieja
   `ranked.slice(0, MAX_CATALOG_RESULTS)` sobre TODO lo devuelto) para que
   la mutación fuera fiel a "¿qué pasaría si el código volviera a contar
   sobre el arreglo ya recortado, como antes de esta ola?" — recién con las
   dos reversas juntas el caso "motul 5100 20w50" (una sola fila de puntaje
   máximo, no debería ser genérico) se puso rojo de verdad.
