// ---------------------------------------------------------------------------
// Variables posicionales {{1}}, {{2}}... del cuerpo de una plantilla de
// WhatsApp (T3.3, 5/9/2026).
//
// Puro y compartido a propósito: lo usa el selector de plantillas (cliente,
// para saber cuántos campos pedir y renderizar la vista previa) y la ruta
// `api/messages/send` (servidor, para armar los `components` que espera la
// Graph API y para sustituir el cuerpo que se guarda en `messages.content`).
// Guardar la lógica una sola vez evita que las dos copias se desincronicen
// sobre qué significa "variable N" o cómo se ve un hueco sin llenar.
// ---------------------------------------------------------------------------

const VARIABLE_PATTERN = /\{\{(\d+)\}\}/g;

/** Cuántas variables posicionales tiene el cuerpo (0 si no tiene ninguna). */
export function templateVariableCount(bodyPreview: string): number {
  let max = 0;
  for (const match of bodyPreview.matchAll(VARIABLE_PATTERN)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * Sustituye cada `{{n}}` por `variables[n-1]`. Un hueco sin valor (vacío o
 * que no vino en el arreglo) se deja tal cual: la vista previa del selector
 * necesita distinguir "todavía no lo llenaste" de "lo llenaste con algo".
 */
export function substituteTemplateVariables(bodyPreview: string, variables: string[]): string {
  return bodyPreview.replace(VARIABLE_PATTERN, (match, indexStr: string) => {
    const value = variables[Number(indexStr) - 1];
    return value && value.trim() ? value : match;
  });
}

/** Forma que la Graph API espera para un parámetro de texto dentro de un componente. */
export interface WhatsappTemplateParameter {
  type: "text";
  text: string;
}

/** Un componente (`header` o `body`) del payload `template.components` de Meta. */
export interface WhatsappTemplateComponent {
  type: "header" | "body";
  parameters: WhatsappTemplateParameter[];
}

/**
 * Arma el componente `body` a partir de las variables posicionales, o
 * `undefined` si no hay ninguna (una plantilla sin variables no lleva
 * `components` en el payload).
 */
export function buildTemplateBodyComponents(variables: string[]): WhatsappTemplateComponent[] | undefined {
  if (variables.length === 0) return undefined;
  return [
    {
      type: "body",
      parameters: variables.map((text) => ({ type: "text", text })),
    },
  ];
}
