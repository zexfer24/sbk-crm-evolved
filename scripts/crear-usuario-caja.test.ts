import { describe, expect, it } from "vitest";
import { LARGO_MINIMO_PASSWORD, parsearArgumentos } from "./crear-usuario-caja";

describe("parsearArgumentos (alta de usuario de caja)", () => {
  it("acepta las tres banderas con valor separado", () => {
    const r = parsearArgumentos(["--email", "caja1@sbk.com", "--password", "clave-larga-1", "--nombre", "Caja 1"]);
    expect(r).toEqual({
      ok: true,
      valor: { email: "caja1@sbk.com", password: "clave-larga-1", nombre: "Caja 1" },
    });
  });

  it("acepta la forma --bandera=valor, en cualquier orden", () => {
    const r = parsearArgumentos(["--nombre=Caja 2", "--password=clave-larga-2", "--email=caja2@sbk.com"]);
    expect(r).toEqual({
      ok: true,
      valor: { email: "caja2@sbk.com", password: "clave-larga-2", nombre: "Caja 2" },
    });
  });

  it("normaliza el correo (recorta y pasa a minúsculas) y recorta el nombre, pero no la contraseña", () => {
    const r = parsearArgumentos(["--email", "  Caja3@SBK.com ", "--password", " con espacios ", "--nombre", "  Caja 3  "]);
    expect(r).toEqual({
      ok: true,
      valor: { email: "caja3@sbk.com", password: " con espacios ", nombre: "Caja 3" },
    });
  });

  it("falla y nombra la bandera que falta", () => {
    for (const faltante of ["email", "password", "nombre"]) {
      const base: Record<string, string> = { email: "c@sbk.com", password: "clave-larga-1", nombre: "Caja" };
      delete base[faltante];
      const argv = Object.entries(base).flatMap(([k, v]) => [`--${k}`, v]);
      const r = parsearArgumentos(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(`--${faltante}`);
    }
  });

  it("falla si una bandera queda sin valor (la siguiente es otra bandera o es la última)", () => {
    expect(parsearArgumentos(["--email", "--password", "x", "--nombre", "y"]).ok).toBe(false);
    const r = parsearArgumentos(["--email", "c@sbk.com", "--password", "clave-larga-1", "--nombre"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--nombre");
  });

  it("rechaza banderas desconocidas, repetidas y argumentos sueltos", () => {
    const base = ["--email", "c@sbk.com", "--password", "clave-larga-1", "--nombre", "Caja"];
    const desconocida = parsearArgumentos([...base, "--rol", "admin"]);
    expect(desconocida.ok).toBe(false);
    if (!desconocida.ok) expect(desconocida.error).toContain("--rol");
    expect(parsearArgumentos([...base, "--email", "otro@sbk.com"]).ok).toBe(false);
    expect(parsearArgumentos([...base, "suelto"]).ok).toBe(false);
  });

  it("rechaza un correo sin forma de correo", () => {
    for (const email of ["caja", "caja@", "@sbk.com", "caja@sbk", "ca ja@sbk.com"]) {
      const r = parsearArgumentos(["--email", email, "--password", "clave-larga-1", "--nombre", "Caja"]);
      expect(r.ok, email).toBe(false);
    }
  });

  it("exige una contraseña de al menos 8 caracteres", () => {
    expect(LARGO_MINIMO_PASSWORD).toBe(8);
    const corta = parsearArgumentos(["--email", "c@sbk.com", "--password", "1234567", "--nombre", "Caja"]);
    expect(corta.ok).toBe(false);
    const justa = parsearArgumentos(["--email", "c@sbk.com", "--password", "12345678", "--nombre", "Caja"]);
    expect(justa.ok).toBe(true);
  });

  it("un nombre en blanco cuenta como faltante", () => {
    const r = parsearArgumentos(["--email", "c@sbk.com", "--password", "clave-larga-1", "--nombre", "   "]);
    expect(r.ok).toBe(false);
  });
});
