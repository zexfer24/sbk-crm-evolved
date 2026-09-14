import { describe, expect, it } from "vitest";
import { customerFirstName } from "./customer-name";

describe("customerFirstName", () => {
  it("prefiere display_name sobre profile_name", () => {
    expect(customerFirstName("Ana Pérez", "Anita 🛵")).toBe("Ana");
  });

  it("cae a profile_name cuando display_name no viene", () => {
    expect(customerFirstName(null, "Carlos Ramírez")).toBe("Carlos");
  });

  it("cae a profile_name cuando display_name no parece un nombre de persona", () => {
    // Un asesor dejó el teléfono en display_name; profile_name de Meta sí sirve.
    expect(customerFirstName("+584121112233", "Carlos Ramírez")).toBe("Carlos");
  });

  it("capitaliza mayúsculas sostenidas", () => {
    expect(customerFirstName("JOSE RIERA", null)).toBe("Jose");
  });

  it("capitaliza minúsculas y respeta acentos", () => {
    expect(customerFirstName("maría", null)).toBe("María");
  });

  it("acepta el nombre de un negocio como si fuera de persona (aceptable, el prompt cubre el resto)", () => {
    expect(customerFirstName("SBK Motos", null)).toBe("Sbk");
  });

  it("devuelve null con un teléfono en las dos fuentes", () => {
    expect(customerFirstName("+584121112233", "+584121112233")).toBeNull();
  });

  it("devuelve null con puros emojis o símbolos", () => {
    expect(customerFirstName("😀👍", null)).toBeNull();
    expect(customerFirstName(null, "🙂")).toBeNull();
  });

  it("devuelve null con una sola letra", () => {
    expect(customerFirstName("A", null)).toBeNull();
  });

  it("devuelve null cuando el nombre trae dígitos mezclados", () => {
    expect(customerFirstName("Jose123", null)).toBeNull();
  });

  it("devuelve null sin ninguna de las dos fuentes", () => {
    expect(customerFirstName(null, null)).toBeNull();
  });
});
