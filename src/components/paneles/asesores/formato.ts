import { CRM_TIME_ZONE } from "@/lib/time-zone";

/**
 * Formato de los números de Asesores (plan "Paneles", 13/11/2026). Todo lo que
 * llega `null` ("no se puede calcular") se pinta «—», nunca como 0: un 0 sería
 * una afirmación ("respondió al instante") que el dato no hace.
 */

const GUION = "—";

/**
 * Minutos de duración: «2,4 min», «13 min», «2 h 05 min», «1 d 1 h».
 * Menos de un minuto es «< 1 min» (no «0 min»: nadie respondió en cero).
 */
export function formatoMinutos(minutos: number | null | undefined): string {
  if (minutos === null || minutos === undefined || !Number.isFinite(minutos)) return GUION;
  if (minutos < 1) return "< 1 min";
  if (minutos < 10) {
    const un = Math.round(minutos * 10) / 10;
    return `${String(un).replace(".", ",")} min`;
  }
  const total = Math.round(minutos);
  if (total < 60) return `${total} min`;

  const dias = Math.floor(total / 1440);
  const horas = Math.floor((total % 1440) / 60);
  const resto = total % 60;
  if (dias > 0) return horas > 0 ? `${dias} d ${horas} h` : `${dias} d`;
  return resto > 0 ? `${horas} h ${String(resto).padStart(2, "0")} min` : `${horas} h`;
}

/** Fracción 0–1 como «72 %». `null` es «—»; un 0 verdadero sí es «0 %». */
export function formatoPorcentaje(fraccion: number | null | undefined): string {
  if (fraccion === null || fraccion === undefined || !Number.isFinite(fraccion)) return GUION;
  return `${Math.round(fraccion * 100)} %`;
}

/**
 * Reloj en vivo de una espera: «2:00:05», o «1 d 2:00:03» pasado el día. Un
 * valor negativo (el reloj del navegador va adelantado respecto al servidor)
 * se pinta como cero en vez de un tiempo negativo.
 */
export function formatoReloj(ms: number): string {
  const segundos = Math.max(0, Math.floor(ms / 1000));
  const dias = Math.floor(segundos / 86400);
  const horas = Math.floor((segundos % 86400) / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const seg = segundos % 60;
  const hms = `${horas}:${String(minutos).padStart(2, "0")}:${String(seg).padStart(2, "0")}`;
  return dias > 0 ? `${dias} d ${hms}` : hms;
}

/** «AG» para «Ana Gómez Pérez»; «?» si no hay nombre. */
export function iniciales(nombre: string): string {
  const letras = nombre
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((palabra) => palabra[0]?.toUpperCase() ?? "");
  const junto = letras.join("");
  return junto === "" ? "?" : junto;
}

/** «13 nov, 2:20 p. m.» en hora de Caracas, sea cual sea la zona del navegador. */
export function formatoFechaHora(iso: string | null | undefined): string {
  if (!iso) return GUION;
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return GUION;
  return new Intl.DateTimeFormat("es-VE", {
    timeZone: CRM_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(fecha);
}
