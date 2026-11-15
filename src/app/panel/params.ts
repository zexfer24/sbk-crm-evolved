/**
 * `searchParams` de Next 16 es una Promise de `string | string[] | undefined`
 * (un parámetro repetido llega como arreglo). Los paneles solo leen el primero:
 * `?periodo=7d&periodo=30d` es 7 días, no un error.
 */
export type ParametrosDePagina = Promise<Record<string, string | string[] | undefined>>;

export function primero(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}
