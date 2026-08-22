/**
 * Entrecomilla un valor para usarlo dentro de un filtro `.or()` de PostgREST.
 *
 * Ese filtro es un mini-lenguaje: la coma separa condiciones y el punto
 * separa columna/operador/valor. Interpolar texto crudo permite que quien
 * controle ese texto agregue condiciones a la consulta en vez de solo
 * buscar por ellas (CWE-943, inyección en lógica de consulta).
 *
 * En el catálogo del agente ese texto lo escribe el modelo a partir de lo
 * que dice el cliente por WhatsApp, así que es entrada no confiable.
 *
 * PostgREST trata como literal todo lo que va entre comillas dobles; hay
 * que escapar la comilla y la barra invertida para que nadie cierre el
 * literal antes de tiempo.
 */
export function pgrstLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Combina varios grupos de condiciones en una sola expresión para `.or()`.
 *
 * PostgREST junta con AND los parámetros repetidos de forma poco predecible,
 * así que dos llamadas a `.or()` en la misma consulta no son fiables. Cuando
 * hacen falta dos disyunciones a la vez —por ejemplo «(coincide con la
 * búsqueda) Y (le falta la cédula o la dirección)»— hay que distribuirlas:
 * cada combinación posible se vuelve un `and(...)` y todas se unen con OR.
 *
 *   orExpression([["a", "b"], ["c", "d"]])
 *     -> "and(a,c),and(a,d),and(b,c),and(b,d)"
 *
 * Con un solo grupo devuelve la disyunción tal cual. Los grupos vacíos se
 * descartan: un filtro que no aporta condiciones no debe eliminar filas.
 */
export function orExpression(groups: string[][]): string {
  const used = groups.filter((group) => group.length > 0);
  if (used.length === 0) return "";
  if (used.length === 1) return used[0].join(",");

  let combos: string[][] = [[]];
  for (const group of used) {
    combos = combos.flatMap((combo) => group.map((term) => [...combo, term]));
  }

  return combos.map((combo) => `and(${combo.join(",")})`).join(",");
}
