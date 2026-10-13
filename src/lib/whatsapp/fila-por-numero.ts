// Fila por número de cliente para los POST a `/messages` de 360dialog.
// Server-only: vive en la memoria del proceso del servidor.
import "server-only";

// ---------------------------------------------------------------------------
// Por qué existe (hotfix 2, 9/10/2026, "Los mensajes al mismo cliente salen de
// a uno y en orden por 360dialog"). Medido en producción: 4 textos rápidos de
// un asesor salieron 1.º, 3.º, failed, 2.º. Cada envío corre su propio
// `after()` en `/api/messages/send`, así que el bucle de reintento de 429 de
// `callGraphApi` corría en PARALELO para cada mensaje y uno adelantaba al que
// estaba reintentando. La solución es que todo POST al MISMO número salga de a
// uno, en orden de llegada (FIFO), y que el reintento del 429 viva DENTRO del
// turno de la fila.
//
// El límite de 360dialog (medido, no documentado):
//  - Es por NÚMERO DE CLIENTE y lo comparten texto, media, sticker, read y
//    typing: un "visto" también se come el cupo del mensaje que viene detrás.
//  - Probabilidad de que el POST sea aceptado según el tiempo desde el último
//    POST ACEPTADO (200) a ese número: < 1,5 s 0 %; 1,5-2 s 7 %; 2-2,5 s 25 %;
//    2,5-4 s ~55 %; 4-4,5 s 80 %; 4,5-5 s 94 %; ≥ 5 s 100 % (50 de 50).
//  - Una ráfaga tras 20 s de descanso deja pasar UNA sola.
//  - Con un ritmo fijo de 5.000 ms se aceptaron 18 de 20: NO es determinista,
//    ningún intervalo garantiza el 200. Por eso a la pausa se suma el
//    reintento del 429 (que no penaliza el cupo).
//
// La fila está en memoria del proceso: Dokploy corre UN solo contenedor `app`,
// así que alcanza. Si algún día hay réplicas, esto tiene que pasar a Redis
// (otro hotfix): dos procesos tendrían dos filas y volverían a competir por el
// mismo cupo del número.
// ---------------------------------------------------------------------------

/** Pausa mínima entre el último POST aceptado a un número y el siguiente (medición del 9/10/2026). */
export const PAUSA_360_MS = 5000;

/**
 * Reintentos de un 429 dentro del turno de la fila (7 intentos en total). Con
 * ~10-20 % de 429 por intento a ≥ 5 s, fallar los 7 es < 1e-5; el peor caso
 * ronda los 35 s por mensaje.
 */
export const REINTENTOS_429_360 = 6;

interface EntradaCola {
  /** Último eslabón encadenado: el siguiente espera a que termine. */
  cola: Promise<unknown>;
  /** Tareas pendientes de esa clave, incluida la que corre. */
  pendientes: number;
}

interface Estado {
  colas: Map<string, EntradaCola>;
  /** Hora (ms) del último POST ACEPTADO por clave. Aparte de `colas`: esa se borra al vaciarse. */
  aceptados: Map<string, number>;
}

// En `globalThis` para sobrevivir a que Next duplique el módulo en bundles
// distintos (ruta, `after()`, agente): dos copias con su propio Map serían dos
// filas y no ordenarían nada.
const g = globalThis as typeof globalThis & { __sbkFilasWhatsapp?: Estado };

function estado(): Estado {
  g.__sbkFilasWhatsapp ??= { colas: new Map(), aceptados: new Map() };
  return g.__sbkFilasWhatsapp;
}

/**
 * Clave de la fila: proveedor + número en solo dígitos. La regex duplica la de
 * `toWaId` (meta-client.ts) a propósito: meta-client importa este módulo y
 * importarlo de vuelta crearía un ciclo.
 */
export function claveFila(provider: string, to: string): string {
  return `${provider}:${to.replace(/[^\d]/g, "")}`;
}

/** Borra las horas de aceptación que ya no influyen (más viejas que la pausa). */
function podarAceptados(ahoraMs: number): void {
  const { aceptados } = estado();
  for (const [clave, t] of aceptados) {
    if (ahoraMs - t > PAUSA_360_MS) aceptados.delete(clave);
  }
}

/**
 * Encadena `tarea` detrás de la última de su clave. Corre cuando termina la
 * anterior, haya salido bien o mal: un fallo no corta la cadena, y a quien
 * llamó le llega su propio error intacto.
 */
export function enFila<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const { colas } = estado();
  podarAceptados(Date.now());

  const entrada = colas.get(clave) ?? { cola: Promise.resolve(), pendientes: 0 };
  entrada.pendientes++;

  // El descuento de `pendientes` ocurre dentro del propio turno, ANTES de que
  // `miTurno` se resuelva: quien espera la tarea y mira enseguida
  // `tareasEnFila` ya la ve en 0 (si descontara en un `.then` aparte, llegaría
  // un microtask tarde).
  const correr = async (): Promise<T> => {
    try {
      return await tarea();
    } finally {
      entrada.pendientes--;
      if (entrada.pendientes === 0 && colas.get(clave) === entrada) colas.delete(clave);
    }
  };
  const miTurno: Promise<T> = entrada.cola.then(correr, correr);
  // El eslabón guardado nunca rechaza: solo sirve para encadenar. El error real
  // le llega a quien llamó por `miTurno`.
  entrada.cola = miTurno.then(
    () => undefined,
    () => undefined
  );
  colas.set(clave, entrada);

  return miTurno;
}

/** Tareas pendientes de esa clave (la que corre incluida). */
export function tareasEnFila(clave: string): number {
  return estado().colas.get(clave)?.pendientes ?? 0;
}

/** Hora (ms) del último POST aceptado a esa clave, o `null` si no hay registro vigente. */
export function ultimoAceptadoMs(clave: string): number | null {
  return estado().aceptados.get(clave) ?? null;
}

/** Anota que 360dialog aceptó (200) un POST a esa clave. */
export function marcarAceptado(clave: string, ahoraMs: number = Date.now()): void {
  podarAceptados(ahoraMs);
  estado().aceptados.set(clave, ahoraMs);
}

/** Ms que faltan para cumplir la pausa desde el último 200; 0 si no hay registro o ya pasó. */
export function esperaHastaPausa(clave: string, ahoraMs: number = Date.now()): number {
  const ultimo = estado().aceptados.get(clave);
  if (ultimo === undefined) return 0;
  return Math.max(0, PAUSA_360_MS - (ahoraMs - ultimo));
}

/** Solo para tests: vacía las filas y las horas de último 200. */
export function __reiniciarFilasParaTests(): void {
  g.__sbkFilasWhatsapp = { colas: new Map(), aceptados: new Map() };
}
