// ---------------------------------------------------------------------------
// Tarea K, corrida "El resguardo antes del push" (20/9/2026). Caso a mano de
// ese mismo día, conversación local `db8d3120…`: el cliente escribió "Precio
// del casco LS2" + "Buenas tardes" (dos mensajes de la misma ráfaga). La
// intención se clasificó `consulta_disponibilidad`, el escenario "Catálogo
// general" se cedió bien al inventario (`escenario_cedido_al_catalogo`,
// H1 de "Seba atiende el mostrador"), pero el modelo (gemini-3.1-flash-lite
// en local) contestó en UN solo paso, SIN llamar a `buscarRepuesto`
// (`turno_tiempos`: `"pasos":1,"herramientas":""`): "¡Buenas tardes! Tenemos
// varios modelos de cascos LS2 disponibles…", cuando en `products` hay CERO
// cascos. Seba afirmó existencia sin mirar el inventario.
//
// La red de seguridad del catálogo de `agent.ts` (~línea 2125) solo actúa
// si `catalogOutcome.ran` es `true` — y hasta esta tarea nada obligaba al
// modelo a llamar a la herramienta antes de redactar. `firstStepToolChoice`
// es la pieza que cierra ese hueco: si la intención es
// `consulta_disponibilidad` y el catálogo está encendido, el PRIMER paso
// del tool loop (`stepNumber === 0`) fuerza `buscarRepuesto` — el modelo no
// puede afirmar ni descartar existencia sin haber mirado la base primero.
// Del paso 1 en adelante queda libre (`undefined`, que en `prepareStep`
// del SDK significa "usar la configuración de más arriba", `toolChoice:
// "auto"` por defecto) porque si no el modelo nunca podría redactar la
// respuesta final ni escalar.
//
// Con una consulta vaga ("¿tienen disponible?"), el paso forzado igual
// corre: `buscarRepuesto` devuelve sin resultados o `generico` (sin marca
// ni modelo de moto y varios términos calzan, `tools.ts`), y las redes que
// ya existen se encargan solas — `generico` bloquea la red de seguridad del
// catálogo a propósito (pide UNA pregunta de filtro, no escala ese turno,
// requisito 5 de "Seba atiende el mostrador") y "sin resultados" cae en el
// texto fijo + escalada de siempre. No hace falta código nuevo para ese
// caso: forzar el primer paso no cambia lo que la herramienta devuelve,
// solo garantiza que se haya llamado.
//
// Función PURA, sin nada de Supabase ni del SDK de IA — igual que
// identity-guard.ts, history-line.ts y saludo.ts — para poder probarla sin
// levantar `ToolLoopAgent`. El nombre literal de la herramienta
// (`"buscarRepuesto"`) viaja como string suelto porque `tools.ts` no
// exporta una constante para él y `ToolSet` (SDK `ai`) tipa sus claves como
// `string`, no como un literal — atarlo a un import de `ai` habría hecho
// que este módulo dejara de ser puro sin ganar nada en seguridad de tipos.
import type { Intent } from "@/lib/ai/classify";

/** Nombre de la única herramienta que este módulo puede forzar. */
export const CATALOG_TOOL_NAME = "buscarRepuesto" as const;

/**
 * Decide si el paso `stepNumber` del tool loop debe forzar la llamada a
 * `buscarRepuesto`. Piensa como el `prepareStep` del SDK: `undefined`
 * significa "no cambies nada, seguí con la configuración de siempre".
 */
export function firstStepToolChoice(
  intent: Intent,
  hasCatalogTool: boolean,
  stepNumber: number
): { toolChoice: { type: "tool"; toolName: typeof CATALOG_TOOL_NAME } } | undefined {
  if (stepNumber !== 0) return undefined;
  if (intent !== "consulta_disponibilidad") return undefined;
  if (!hasCatalogTool) return undefined;
  return { toolChoice: { type: "tool", toolName: CATALOG_TOOL_NAME } };
}
