# Entrega A "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28-29/9/2026

Para el Claude del VPS. Plan aprobado:
`docs/planes/2026-09-28-seba-encuentra-y-el-mostrador-no-deja-esperando.md`.
El orden completo, las verificaciones SQL y la medición de 48 h están en
`docs/PRODUCCION.md` §15. Esta nota da la rama, los commits, lo que cambió
durante la ejecución y lo que queda para el operador.

**No se pushea a `main` directo.** Push a `main` despliega solo (Dokploy,
confirmado el 25/9/2026). La entrega vive en la rama
**`entrega/seba-encuentra`**, partida de `origin/main` = producción =
`08e0fa5`. El fast-forward de `main` es el paso que despliega, y va DESPUÉS
de aplicar y verificar las cinco migraciones (§15, pasos 1-5).

## Qué hay en la rama

`git log --oneline 08e0fa5..origin/entrega/seba-encuentra` (del más viejo al
más nuevo):

```
c9c95c7 La entrega del mostrador queda escrita para el VPS
ad2079b El plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando" queda escrito
fba766d Seba solo afirma lo que tiene fuente y deja la cotización al sistema
fd2ae64 [migración] La búsqueda del catálogo no suelta la marca y lee los números completos
13faa21 La consulta del cliente se reparte en producto, descriptivos, moto y cilindrada
f760ac9 Un guardado de configuración que la base rechaza ya no dice "guardado", y los mensajes rápidos mandan el catálogo vigente
499283c [migración] El catálogo tiene un corrector de tipeos para el segundo intento
5e99740 El envoltorio del corrector nombra lo que cambió
092d465 [migración] Un asesor ya no puede darse el rol de supervisor o admin
fecb232 [migración] Los escenarios eligen si pueden salir mientras el cliente espera al asesor
23d129c En la espera del asesor, Seba no repite el PDF ni manda escenarios que no corresponden
719d6c3 Seba busca con la marca obligatoria, mira el stock antes de decir "tenemos" y pregunta una sola vez
bda58dd Seba manda la cotización y la pregunta tal como las arma el código, corrige tipeos y no promete un asesor que no llamó
cb31849 [migración] Cada turno de Seba puede guardar las búsquedas de catálogo que hizo
402a009 El turno deja registradas sus búsquedas de catálogo y el pie de la foto que mandó el cliente
d6911b2 La entrega de Seba queda documentada y el CI corre sus cinco tests de base
3c8f12e Con la moto que calza, Seba cotiza como máximo tres con existencia y avisa cuántas opciones más hay
+ este archivo (punta de la rama)
```

`c9c95c7` es la nota de entrega de la ola del 27/9 (solo docs). Las
migraciones se aplican por FECHA (§15), no en el orden de los commits.
Esta nota vive en el último commit, así que no puede traer su propio SHA; el
operador lo pasa junto con el aviso. Antes de tocar nada:

```bash
git fetch origin
git ls-remote --heads origin entrega/seba-encuentra   # debe dar el SHA que pasó el operador
```

**Cinco migraciones, no cuatro** (el plan decía cuatro; la quinta,
`20260928050000`, salió del hallazgo de T7b). Orden y comandos: §15.

## Verificación hecha en local (29/9/2026)

- Suite completa: 3.595 tests en verde, más `tsc` y lint (0 errores).
- Los 27 archivos de `supabase/tests/` en verde sobre una base
  **reconstruida desde cero** (`supabase db reset` con las 86 migraciones y
  los seeds). Los cinco nuevos también pasan sin `-1`, igual que en el CI.
- `npm run build` correcto.
- **CI real en verde** sobre `d6911b2`: run 36591988161, por la rama
  desechable `ci/seba-encuentra` (= `d6911b2` + un commit que suma `ci/**`
  al disparador; NO se fusiona). La corrección `3c8f12e` es solo
  TypeScript, sin migración, con la suite local en verde.
- Escenario a mano por webhook, con Gemini local y fixtures de productos:
  - "aceite inca" → cotización con el nombre exacto y el texto fijo; escala.
  - "botas" (cinco, todas en cero) → tres "Agotado" y `TEXTO_SIN_STOCK`;
    nunca "tenemos".
  - "guardafango para horse" → una sola pregunta; "24" → cotiza el
    guardafango 24 sin repreguntar.
  - "batería 12N5-3B y motor de arranque" → una búsqueda por producto, una
    sola cotización.
  - Espera con escalada abierta: pedir el catálogo general NO reenvía el
    escenario; queda la nota para el asesor.
  - "asiento sbr" (seis en existencia, con 5, 4, 3, 2, 2 y 1 unidades) →
    los tres de 5, 4 y 3, «Hay 3 opciones más para tu moto; el asesor te
    muestra el resto.», el texto fijo literal y una sola escalada
    (corrección de abajo, verificada el 29/9 sobre `3c8f12e`).
  - `agent_turns.catalog_queries` se llena en cada turno que busca y queda
    `null` en los que no buscan.

## Cambió durante la ejecución (decisiones del operador, 29/9/2026)

**"asiento sbr" con muchos asientos en existencia.** El escenario a mano
mostró que, cuando la moto del cliente aparece en el nombre de los productos
(la moto "calza"), la búsqueda nunca era genérica y cotizaba todo lo que
coincidía: seis asientos SBR de una vez, y en producción serían más. Decisión:
con la moto que calza y **más de tres con existencia**, Seba cotiza las
**tres más relevantes** y escala con `confirmar_inventario`, sin preguntar.
Tras el puntaje y la moto, desempata la **mayor existencia**, no el nombre.
El bloque cierra con «Hay N opciones más para tu moto; el asesor te muestra
el resto.» (N = total con existencia − 3). Con tres o menos, o todo en cero,
no cambia nada. Por eso el paso 7 de §15 ya no espera que "asiento sbr" haga
una pregunta: espera las tres líneas y el aviso de las opciones restantes.

## Para el operador

1. Las cuatro tareas de panel de §15, paso 6: link vigente de cascos,
   marcador `{{catalogo:cascos}}` en el mensaje rápido, "Cede al inventario"
   en "CATALOGO CASCOS" y revisar los tres escenarios "Puede salir mientras
   espera al asesor".
2. **Decisión abierta.** Si el cliente se queja mientras espera a un asesor
   que todavía no fue asignado (escalada abierta, sin asesor), el mensaje no
   se clasifica: queda solo la nota interna y el reclamo no se marca como
   queja. Es la regla de "Seba no habla de más" (23/9). Con asesor asignado,
   la queja sí escala siempre. Cubrir el otro caso costaría una llamada más
   al modelo por cada mensaje en espera.
3. **Límite conocido.** Si el modelo pasa la frase entera como consulta
   ("necesito un asiento sbr"), "necesito" no se toma como palabra de relleno
   y la búsqueda sale sin resultados. En las pruebas el modelo mandó siempre
   "asiento sbr". Vigilar en `catalog_queries` las filas `sin_resultados` con
   verbos al inicio.
4. **Límite conocido.** El desempate por existencia se hace sobre las
   primeras 50 filas que ordena la base. En una familia con más de 50
   productos en existencia para la misma moto, las que quedaron fuera no
   compiten.

## Después de esta entrega

La Entrega B (el mostrador: carrito por conversación, scroll y existencia,
reasignación por demora) sale aparte en `entrega/mostrador-sin-esperas`,
desde la punta de esta rama, con su propia nota.
