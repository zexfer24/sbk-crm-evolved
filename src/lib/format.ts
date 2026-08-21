import { format, isToday, isYesterday } from "date-fns";
import { es } from "date-fns/locale";

/**
 * Hora en formato 12 h con "a.m."/"p.m." en minúsculas y con puntos —
 * el locale es de date-fns produce "a. m." (con espacio, sin coherencia de
 * puntos), así que el período se arma a mano para tener siempre el mismo
 * formato exacto en toda la app.
 */
export function formatTime12h(iso: string): string {
  const date = new Date(iso);
  const time = format(date, "h:mm");
  const period = date.getHours() < 12 ? "a.m." : "p.m.";
  return `${time} ${period}`;
}

export function formatMessageTime(iso: string): string {
  return formatTime12h(iso);
}

export function formatConversationTimestamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (isToday(date)) return formatTime12h(iso);
  if (isYesterday(date)) return "Ayer";
  return format(date, "d MMM", { locale: es });
}

export function formatFullDateTime(iso: string): string {
  return `${format(new Date(iso), "d 'de' MMMM", { locale: es })}, ${formatTime12h(iso)}`;
}

/** Etiqueta del separador de día en el hilo de mensajes: "Hoy", "Ayer" o fecha completa. */
export function formatDaySeparator(iso: string): string {
  const date = new Date(iso);
  if (isToday(date)) return "Hoy";
  if (isYesterday(date)) return "Ayer";
  return format(date, "d 'de' MMMM 'de' yyyy", { locale: es });
}

/** Clave de agrupación por día en la zona horaria local del navegador. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
