// Redondeo del contador de la ventana de 24h de WhatsApp (C2, 5/9/2026).
//
// Antes se sacaba `hours` con Math.floor y `minutes` con Math.round por
// separado sobre el resto en horas: un restante de 23h 59m 40s (23.9944...
// horas) daba floor = 23 y round((23.9944 - 23) * 60) = round(59.667) = 60,
// mostrando "23h 60m" en vez de "24h 0m". La cuenta correcta redondea los
// MINUTOS TOTALES una sola vez y de ahí deriva horas y minutos, para que el
// acarreo de un redondeo hacia el minuto 60 empuje a la hora siguiente.
export function formatWindowRemaining(hoursRemaining: number): { hours: number; minutes: number } {
  const totalMinutes = Math.round(hoursRemaining * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return { hours, minutes };
}
