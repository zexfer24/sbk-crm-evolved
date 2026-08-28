---
name: liminalwork
description: Metodología de trabajo de Liminal Flows. Usar al iniciar cualquier proyecto nuevo, al retomar o cargar el estatus de un proyecto existente, al diagnosticar un repositorio, o antes de planificar e implementar cualquier cambio de diseño, lógica o código. Define el flujo contexto → planificación → implementación orquestada con subagentes y reportes.
---

# Metodología de trabajo con Claude Code

## Objetivo
Estandarizar cómo se aborda cada proyecto: primero contexto, luego planificación explícita, y solo después implementación. Ningún cambio (diseño, lógica o código) se ejecuta sin un plan aprobado. La implementación se orquesta mediante subagentes: un subagente por tarea, con reporte obligatorio al orquestador.

La metodología tiene **dos vías de entrada** que convergen en el mismo flujo:

- **Proyecto nuevo** → Fase 1-A (carga de contexto).
- **Proyecto existente** → Fase 1-B (diagnóstico y carga de estatus). A partir de su adopción, toda modificación al proyecto pasa por esta metodología, desplazando la forma de trabajo anterior.

---

## Fase 1-A — Carga de contexto (proyectos nuevos)

1. **Recopilar la información vital del proyecto** antes de tocar nada: procesos de trabajo, flujos, documentación, credenciales de entorno y toda la información accesible del escenario.
2. **Ejecutar `/init` en la carpeta del proyecto** con esa información ya cargada, de modo que el `CLAUDE.md` generado refleje el contexto real del proyecto y no solo la estructura del código.

> Resultado esperado: Claude Code arranca cada sesión conociendo el escenario completo sin necesidad de re-explicarlo.

---

## Fase 1-B — Diagnóstico y carga de estatus (proyectos existentes)

1. **Recopilar la información vital disponible**: documentación existente, procesos y flujos actuales, decisiones históricas, deuda conocida y todo lo accesible del escenario.
2. **Ejecutar `/init` sobre el repositorio** y enriquecer el `CLAUDE.md` resultante con la información recopilada, no solo con la estructura del código.
3. **Sectorizar el proyecto y construir el glosario de archivos**: mapear módulo por módulo qué hace cada archivo o carpeta y registrarlo en un glosario (dentro del `CLAUDE.md` o en un documento referenciado desde él). El glosario permite a orquestador y subagentes ubicar el código relevante sin releer el proyecto completo, ahorrando contexto en cada sesión.
4. **Emitir un diagnóstico al operador** con el estado real del proyecto:
   - Arquitectura actual y sus puntos débiles.
   - Cobertura de tests: qué módulos tienen verificación y cuáles no.
   - Deuda técnica, riesgos y zonas frágiles del código.
   - Brechas entre la forma de trabajo actual y esta metodología.
5. **Acordar el plan de reforma con el operador**: qué se regulariza de inmediato (p. ej., tests mínimos en módulos críticos) y qué se reforma de manera incremental.

> Regla de adopción incremental: no se refactoriza todo el proyecto de golpe. Desde el día uno, **todo cambio nuevo entra por la metodología** (plan → subagentes → reportes → tests). Cada módulo que se toca queda "reformado": con tests, con su entrada en el glosario actualizada y documentado en el `CLAUDE.md`. El proyecto migra a la metodología módulo a módulo, a medida que se trabaja sobre él.

---

## Fase 2 — Planificación

6. **Activar Plan Mode (`/plan`) con Fable 5 u Opus 5 en razonamiento Alto.** La planificación siempre usa el modelo más capaz disponible.
7. **La planificación es obligatoria antes de cualquier paso**: cambios de diseño, de lógica, de código o de arquitectura. Nada se implementa directamente. En proyectos existentes, esto reemplaza cualquier práctica previa de modificar directamente.
8. **El plan debe explicarse en detalle al operador**: qué se va a hacer, en qué archivos, en qué orden y por qué. En proyectos existentes, el plan apoya sus referencias en el glosario y señala qué módulos sin tests se verán afectados. El operador aprueba antes de continuar.
9. **Sugerir skills según el escenario.** En cada fase de creación del producto o servicio (diseño, codificación, seguridad, documentación, etc.), evaluar si existe una skill que eleve la calidad del resultado y proponerla.
10. **Proponer los tests inmediatamente después del plan.** El plan no está completo hasta definir cómo se va a verificar: qué tests se escribirán y qué criterios marcan la tarea como terminada. Si la tarea toca un módulo heredado sin cobertura, el plan incluye primero los tests de resguardo de ese módulo.
11. **Descomponer el plan en tareas delegables.** El plan aprobado se divide en tareas independientes y acotadas, cada una con su alcance, archivos involucrados y tests asociados. Esta descomposición es la que consumirán los subagentes en la Fase 3.

---

## Fase 3 — Implementación orquestada

12. **Un subagente por tarea.** El Claude orquestador despliega los subagentes de forma individual: cada tarea del plan se asigna a un subagente propio, con su propia ventana de contexto limpia. Así se mantiene la calidad y se evita arrastrar contexto degradado entre tareas. El orquestador no implementa: coordina, delega y valida.
13. **Reporte obligatorio al finalizar.** Al dar por terminada su tarea, cada subagente entrega un reporte al orquestador con:
    - Qué se implementó y qué decisiones se tomaron sobre la marcha.
    - Archivos creados o modificados (y sus entradas de glosario actualizadas, si aplica).
    - Resultado de los tests definidos en el plan (en verde / fallos y su causa).
    - Problemas encontrados, deuda técnica introducida o desvíos respecto al plan.
14. **El orquestador valida cada reporte antes de cerrar la tarea.** Ninguna tarea se marca como completa hasta que el orquestador recibe el reporte, confirma que los tests están en verde y que el resultado coincide con lo planificado. Si hay desvíos, decide si corrige con otro subagente o escala al operador.
15. **Verificación reforzada (opcional).** Además de los tests en verde, se puede proponer un escenario límite o una prueba de mutación manual: alterar una condición del código para verificar que el test correspondiente efectivamente se rompe. Si el test no se rompe, el test no está cubriendo lo que dice cubrir.

---

## Modelos por fase

| Fase | Rol | Modelo | Razonamiento |
|---|---|---|---|
| Diagnóstico (1-B) | Orquestador | Fable 5 u Opus 5 | Alto |
| Planificación | Orquestador | Fable 5 u Opus 5 | Alto |
| Implementación | Subagentes | Sonnet | Medio–Alto |

---

## Resumen del flujo

**Proyecto nuevo:** contexto → `/init` → flujo común.
**Proyecto existente:** información disponible → `/init` → glosario de archivos → diagnóstico al operador → plan de reforma → flujo común (adopción incremental, módulo a módulo).

**Flujo común:** `/plan` (Fable/Opus, Alto) → explicación al operador → skills sugeridas → tests propuestos → descomposición en tareas → aprobación → despliegue de subagentes (Sonnet, uno por tarea) → reporte de cada subagente al orquestador → validación del orquestador → tests en verde → tarea finalizada.
