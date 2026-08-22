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
