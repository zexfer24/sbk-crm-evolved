/**
 * Formato de los precios que el agente le muestra al cliente.
 *
 * Vive en código y no en el prompt por una razón concreta: convertir,
 * redondear o reformatear un número es aritmética, y ahí es donde los
 * modelos alucinan — sobre todo los baratos. Al modelo le llega la cadena ya
 * escrita y su único trabajo es copiarla, así que la elección de modelo deja
 * de poder afectar el precio que lee un cliente.
 *
 * Formato venezolano: coma decimal, punto para los miles.
 */

const VE = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$12,50 (Bs. 9.850,00)" — listo para copiar tal cual en el mensaje. */
export function formatQuote(precioUsd: number, precioBs: number): string {
  return `$${VE.format(precioUsd)} (Bs. ${VE.format(precioBs)})`;
}
