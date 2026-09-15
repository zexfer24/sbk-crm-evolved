import { describe, expect, it } from "vitest";
import { APP_TITLE, BUSINESS_NAME } from "@/lib/brand";

// 15/9/2026: el nombre del negocio pasó de "SBK Motorcycles" a "SBK Motors"
// (Tarea 2, "La voz de mostrador con nombre propio"). Estos tests son la
// mutación 1 de esa tarea: si alguien vuelve a escribir "SBK Motorcycles"
// acá, tienen que ponerse rojos.
describe("BUSINESS_NAME", () => {
  it("es SBK Motors", () => {
    expect(BUSINESS_NAME).toBe("SBK Motors");
  });

  it("ya no contiene Motorcycles", () => {
    expect(BUSINESS_NAME).not.toContain("Motorcycles");
  });
});

describe("APP_TITLE", () => {
  it("termina en ' CRM'", () => {
    expect(APP_TITLE).toMatch(/ CRM$/);
  });

  it("se arma a partir de BUSINESS_NAME", () => {
    expect(APP_TITLE).toBe(`${BUSINESS_NAME} CRM`);
  });
});
