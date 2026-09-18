import { describe, expect, it } from "vitest";
import { AI_NAME, APP_TITLE, BUSINESS_NAME } from "@/lib/brand";

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

// 18/9/2026: plan "Seba atiende el mostrador", requisito 1 del cliente — el
// agente se llama Seba, no "el asistente" ni "la IA".
describe("AI_NAME", () => {
  it("es Seba", () => {
    expect(AI_NAME).toBe("Seba");
  });
});
