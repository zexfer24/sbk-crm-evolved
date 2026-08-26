import { describe, expect, it } from "vitest";
import { daysBetween, shouldRefetchBcv, venezuelaDate, weekdayOf } from "@/lib/bcv-schedule";

// Semana de referencia, para no contar días a mano en cada caso:
const VIERNES = "2026-08-21";
const SABADO = "2026-08-22";
const DOMINGO = "2026-08-23";
const LUNES = "2026-08-24";
const MARTES = "2026-08-25";

/**
 * Es el número que hace que el aviso del log sirva: distingue "el BCV tardó de
 * más una vez" de "llevamos tres días cotizando con una tasa muerta".
 */
describe("daysBetween", () => {
  it("cuenta los días entre dos fechas", () => {
    expect(daysBetween(SABADO, MARTES)).toBe(3);
    expect(daysBetween(VIERNES, SABADO)).toBe(1);
  });

  it("el mismo día son cero", () => {
    expect(daysBetween(LUNES, LUNES)).toBe(0);
  });

  /**
   * El sábado el BCV publica la tasa del lunes, así que la fecha de vigencia
   * puede estar en el futuro. Ahí la cuenta da negativo, y eso es correcto: no
   * es una tasa vieja, es una que todavía no empezó a regir.
   */
  it("da negativo cuando la tasa rige a futuro", () => {
    expect(daysBetween(LUNES, SABADO)).toBe(-2);
  });

  /** Cruza el fin de mes sin contar a mano. */
  it("cruza el cambio de mes", () => {
    expect(daysBetween("2026-08-30", "2026-09-02")).toBe(3);
  });
});

describe("weekdayOf", () => {
  it("ubica bien los días de la semana de referencia", () => {
    expect(weekdayOf(DOMINGO)).toBe(0);
    expect(weekdayOf(LUNES)).toBe(1);
    expect(weekdayOf(VIERNES)).toBe(5);
    expect(weekdayOf(SABADO)).toBe(6);
  });
});

describe("venezuelaDate", () => {
  it("usa la fecha de Venezuela, no la UTC", () => {
    // 2026-08-23T01:00:00Z es todavía sábado 22 a las 21:00 en Caracas.
    expect(venezuelaDate(new Date("2026-08-23T01:00:00Z"))).toBe(SABADO);
  });

  it("cambia de día a la medianoche de Caracas, no a la de Londres", () => {
    expect(venezuelaDate(new Date("2026-08-23T03:59:00Z"))).toBe(SABADO);
    expect(venezuelaDate(new Date("2026-08-23T04:01:00Z"))).toBe(DOMINGO);
  });
});

describe("shouldRefetchBcv", () => {
  it("sin saber cuándo se leyó, hay que volver a buscarla", () => {
    // Es el caso de la fila que siembra el seed: si se diera por buena,
    // taparía la tasa real para siempre.
    expect(shouldRefetchBcv(LUNES, null)).toBe(true);
  });

  it("si ya se leyó hoy, no se vuelve a preguntar", () => {
    expect(shouldRefetchBcv(MARTES, MARTES)).toBe(false);
  });

  it("el domingo se reusa lo que se leyó el sábado", () => {
    expect(shouldRefetchBcv(DOMINGO, SABADO)).toBe(false);
  });

  it("el lunes sí se vuelve a preguntar aunque se haya leído el sábado", () => {
    // Es el día en que el BCV puede publicar una nueva: hay que detectar el cambio.
    expect(shouldRefetchBcv(LUNES, SABADO)).toBe(true);
  });

  it("el sábado se sale a buscar: es cuando el BCV publica la del lunes", () => {
    expect(shouldRefetchBcv(SABADO, VIERNES)).toBe(true);
  });

  it("un domingo cuya última lectura no es del sábado manda a buscar igual", () => {
    expect(shouldRefetchBcv(DOMINGO, VIERNES)).toBe(true);
  });

  it("entre semana, lo leído ayer nunca sirve para hoy", () => {
    expect(shouldRefetchBcv(MARTES, LUNES)).toBe(true);
  });
});

describe("shouldRefetchBcv — el fin de semana completo", () => {
  it("sábado, domingo y lunes: se lee el sábado, se reusa el domingo, se relee el lunes", () => {
    // Sábado por la mañana: lo último es del viernes, hay que salir.
    expect(shouldRefetchBcv(SABADO, VIERNES)).toBe(true);
    // Ya leída el sábado: el resto del sábado no se vuelve a molestar al BCV.
    expect(shouldRefetchBcv(SABADO, SABADO)).toBe(false);
    // Domingo: el BCV no publica, vale la del sábado.
    expect(shouldRefetchBcv(DOMINGO, SABADO)).toBe(false);
    // Lunes: toca comprobar si cambió.
    expect(shouldRefetchBcv(LUNES, SABADO)).toBe(true);
  });
});
