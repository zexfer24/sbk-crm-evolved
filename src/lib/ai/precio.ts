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
 *
 * 25/9/2026, plan "La búsqueda encuentra lo que el cliente pide" (T4,
 * decisión del operador): el monto en dólares lleva " BCV" pegado. El "$" de
 * esta tienda siempre es a la tasa BCV registrada — así cotizan los asesores
 * de verdad ("108$ BCV" el 10/9/2026, por un producto de 88.000 Bs a
 * 814,69) — y sin la marca un cliente puede leer ese número como si fuera un
 * dólar fijo o "de calle", o compararlo días después contra una tasa que ya
 * cambió.
 */

const VE = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$12,50 BCV (Bs. 9.850,00)" — listo para copiar tal cual en el mensaje. */
export function formatQuote(precioUsd: number, precioBs: number): string {
  return `$${VE.format(precioUsd)} BCV (Bs. ${VE.format(precioBs)})`;
}
