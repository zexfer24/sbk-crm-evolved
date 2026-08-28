import { CRM_TIME_ZONE, crmMinuteOfDay } from "@/lib/time-zone";

// ---------------------------------------------------------------------------
// A qué hora puede salir un texto ya redactado.
//
// El 27 de agosto de 2026, de 14 saludos, 4 salieron con el saludo equivocado:
// "¡Buenos días!" a las 10 de la noche. El emparejador no tenía cómo saber la
// hora — `matchPlaybook` recibía el historial y los escenarios, y nada más—,
// así que elegía entre tres saludos por lo que decía el texto del cliente. Con
// un "Hola" pelado no hay nada que copiar, y caía siempre en el mismo.
//
// La regla que se aplica acá NO mira el disparador ni el nombre del escenario:
// mira el TEXTO QUE VA A RECIBIR EL CLIENTE. Un mensaje que empieza diciendo
// "buenos días" solo puede salir de mañana, se llame como se llame el
// escenario y diga lo que diga su disparador. Es la única fuente que no
// depende de cómo el dueño haya redactado la regla en el panel — y da la
// vuelta correcta al problema: lo que está mal a las 10 de la noche no es la
// elección del escenario, es la frase que sale.
//
// Falla ABIERTO: un texto que no empieza saludando por la hora no queda
// restringido a ninguna franja. Equivocarse hacia ese lado deja las cosas como
// estaban; hacia el otro apagaría un escenario del dueño sin avisarle.
// ---------------------------------------------------------------------------

/** Franja del día en la que un texto tiene sentido, en minutos desde medianoche. */
export interface GreetingWindow {
  from: number;
  to: number;
}

/**
 * Los bordes salen de los disparadores que escribió el dueño, no de una
 * convención: "12:00 pm hasta las 7:00pm" para la tarde y "7:01 pm a las
 * 11:59 pm" para la noche. Las 7:00 en punto son todavía tarde.
 *
 * La mañana se estira hasta cubrir la madrugada porque las tres franjas tienen
 * que tapar el día entero: si quedara un hueco, a las 3 am no habría ningún
 * saludo que ofrecer y el escenario del dueño desaparecería en silencio. A esa
 * hora casi no entra nadie, y el que entra recibe "buenos días" — que es lo
 * que recibía antes.
 */
const MANANA: GreetingWindow = { from: 0, to: 11 * 60 + 59 };
const TARDE: GreetingWindow = { from: 12 * 60, to: 19 * 60 };
const NOCHE: GreetingWindow = { from: 19 * 60 + 1, to: 23 * 60 + 59 };

/**
 * Los tres saludos, escritos como los escribe la gente: con acento o sin él,
 * en singular o en plural. "buen día" y "buenos días" son el mismo saludo.
 */
const SALUDOS: { patron: RegExp; ventana: GreetingWindow }[] = [
  { patron: /^buen(os|as|a)?\s+dias?\b/, ventana: MANANA },
  { patron: /^buen(as|a)\s+tardes?\b/, ventana: TARDE },
  { patron: /^buen(as|a)\s+noches?\b/, ventana: NOCHE },
];

/**
 * El texto tal como lo compara la regla: sin acentos, en minúsculas y sin lo
 * que venga antes de la primera letra. Eso último es lo que deja pasar
 * "¡Buenos días!" y "🌙 Buenas noches" — el signo de apertura y el emoji son
 * decoración, no parte del saludo.
 */
function normalizar(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^[^\p{L}]+/u, "");
}

/**
 * Franja horaria de la que habla un texto ya redactado, o null si no habla de
 * ninguna.
 *
 * Solo cuenta el saludo con el que ARRANCA. Un texto que menciona la hora más
 * adelante ("trabajamos de 8 am a 6 pm, buenas tardes") no queda atado a
 * ninguna franja: lo que sale mal a destiempo es abrir con el saludo, no
 * nombrar una hora.
 */
export function greetingWindow(responseText: string): GreetingWindow | null {
  const texto = normalizar(responseText);
  return SALUDOS.find(({ patron }) => patron.test(texto))?.ventana ?? null;
}

/**
 * Los escenarios que pueden salir a esta hora, en el mismo orden en que
 * llegaron.
 *
 * Se aplica ANTES de llamar al modelo y no después de que conteste: filtrar la
 * lista le quita la opción imposible en vez de corregirle la respuesta. El
 * modelo sigue decidiendo lo suyo —si esto es un saludo o no— y el reloj
 * decide lo que es del reloj.
 */
export function playbooksAtTime<T extends { responseText: string }>(
  playbooks: T[],
  now: Date = new Date(),
  timeZone: string = CRM_TIME_ZONE
): T[] {
  const minuto = crmMinuteOfDay(now, timeZone);

  return playbooks.filter((playbook) => {
    const ventana = greetingWindow(playbook.responseText);
    return ventana === null || (minuto >= ventana.from && minuto <= ventana.to);
  });
}
