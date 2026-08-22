import { describe, expect, it } from "vitest";
import { formatQuote } from "@/lib/ai/precio";

/**
 * El precio que lee el cliente se arma acá, en código, y le llega al modelo
 * ya escrito. El modelo solo lo copia.
 *
 * Esto no es cosmética: pedirle a un modelo que convierta, redondee o
 * reformatee un número es pedirle aritmética, y ahí es donde alucina. Un
 * precio inventado en un chat de ventas es una discusión con un cliente que
 * ya se sintió engañado.
 */
describe("formatQuote", () => {
  it("escribe el precio en formato venezolano: coma decimal, punto de miles", () => {
    expect(formatQuote(12.5, 9850)).toBe("$12,50 (Bs. 9.850,00)");
  });

  it("siempre muestra dos decimales, incluso en montos redondos", () => {
    expect(formatQuote(8, 6300)).toBe("$8,00 (Bs. 6.300,00)");
  });

  it("separa los miles en montos grandes en bolívares", () => {
    expect(formatQuote(1250.75, 984590.5)).toBe("$1.250,75 (Bs. 984.590,50)");
  });

  it("no redondea hacia arriba un precio que ya viene con dos decimales", () => {
    expect(formatQuote(19.99, 15742.13)).toBe("$19,99 (Bs. 15.742,13)");
  });
});
