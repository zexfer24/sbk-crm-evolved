import { format, isToday, isYesterday } from "date-fns";
import { es } from "date-fns/locale";

export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  return format(date, "HH:mm", { locale: es });
}

export function formatConversationTimestamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (isToday(date)) return format(date, "HH:mm", { locale: es });
  if (isYesterday(date)) return "Ayer";
  return format(date, "d MMM", { locale: es });
}

export function formatFullDateTime(iso: string): string {
  return format(new Date(iso), "d 'de' MMMM, HH:mm", { locale: es });
}
