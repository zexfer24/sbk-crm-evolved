/**
 * Nombre de canal Realtime único POR SUSCRIPCIÓN (hotfix 29/10/2026,
 * "/inventario se cae al guardar un presupuesto").
 *
 * `RealtimeClient.channel(topic)` de realtime-js DEVUELVE el canal que ya
 * existe con ese topic, y `RealtimeChannel.on()` lanza si ese canal ya está
 * `joining`/`joined`: dos suscripciones vivas con el mismo nombre tiran el
 * árbol de React desde un `useEffect`. Y `removeChannel` no lo saca de la
 * lista hasta que el servidor confirma la salida: una suscripción nueva con el
 * mismo nombre en ese hueco recibe el canal que se está yendo y muere en
 * silencio. Por eso el sufijo sale de un contador de MÓDULO y se pide DENTRO
 * del efecto: cambia en cada suscripción, no solo en cada montaje (`useId()`
 * sería igual en un remontaje de StrictMode).
 */
let secuencia = 0;

export function nombreCanalUnico(base: string): string {
  secuencia += 1;
  return `${base}:${secuencia}`;
}
