import { businessMinutesBetween, type BusinessHours } from "@/lib/business-hours";

/**
 * Cuánto lleva esperando un mensaje (plan "Paneles", 13/11/2026). Dos medidas:
 * el reloj de pared (`ms`, el que corre en vivo) y los minutos dentro del
 * horario de atención (`laborales`), que son los que cuentan para decir si un
 * pendiente está atascado — de noche o un domingo nadie está atrasado (misma
 * definición que "atascado" en `dashboard.ts`, CLAUDE.md 5/9/2026).
 */
export interface Espera {
  ms: number;
  laborales: number;
}

export function esperaDe(desde: string, ahora: Date, horario: BusinessHours): Espera {
  const inicio = new Date(desde);
  if (Number.isNaN(inicio.getTime())) return { ms: 0, laborales: 0 };
  return {
    ms: Math.max(0, ahora.getTime() - inicio.getTime()),
    laborales: Math.floor(businessMinutesBetween(inicio, ahora, horario)),
  };
}

export type TonoEspera = "neutro" | "alerta" | "critico";

/** Hasta 15 min laborales es normal; de 15 a 60, atención; más de 60, atascado. */
export function tonoEspera(laborales: number): TonoEspera {
  if (laborales >= 60) return "critico";
  if (laborales >= 15) return "alerta";
  return "neutro";
}
