import { describe, expect, it } from "vitest";
import {
  agentAccountPatchSchema,
  firstIssueMessage,
  validateAgentAccountDraft,
  type AgentAccountDraft,
} from "@/lib/agent-account";

/**
 * T6, "Ronda del cliente" (30/9/2026): la edición de cuentas del equipo. El
 * esquema lo comparten la ruta (`api/agents/[id]`) y el modal de la pestaña
 * «Equipo»; los topes se fijan con su literal (60, 8, 72), nunca con un
 * símbolo importado — ver la trampa "un tope numérico probado contra su
 * propio símbolo no prueba el número" (CLAUDE.md, 20/9/2026).
 */

function parse(body: unknown) {
  return agentAccountPatchSchema.safeParse(body);
}

describe("agentAccountPatchSchema", () => {
  it("acepta solo el nombre y lo recorta", () => {
    const result = parse({ displayName: "  María  " });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ displayName: "María" });
  });

  it("acepta solo la contraseña, sin recortarla", () => {
    const result = parse({ password: " secreta 1 " });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ password: " secreta 1 " });
  });

  it("acepta los dos a la vez", () => {
    const result = parse({ displayName: "Pedro", password: "12345678" });
    expect(result.success).toBe(true);
  });

  it("un cuerpo vacío es «Nada que cambiar.»", () => {
    const result = parse({});
    expect(result.success).toBe(false);
    expect(firstIssueMessage(result.error!)).toBe("Nada que cambiar.");
  });

  it("un nombre de solo espacios no pasa", () => {
    const result = parse({ displayName: "   " });
    expect(result.success).toBe(false);
    expect(firstIssueMessage(result.error!)).toBe("El nombre visible no puede quedar vacío.");
  });

  it("el nombre admite 60 caracteres y no 61", () => {
    expect(parse({ displayName: "a".repeat(60) }).success).toBe(true);
    const result = parse({ displayName: "a".repeat(61) });
    expect(result.success).toBe(false);
    expect(firstIssueMessage(result.error!)).toBe("El nombre visible admite hasta 60 caracteres.");
  });

  it("la contraseña exige 8 caracteres y admite hasta 72", () => {
    const corta = parse({ password: "1234567" });
    expect(corta.success).toBe(false);
    expect(firstIssueMessage(corta.error!)).toBe("La contraseña debe tener al menos 8 caracteres.");
    expect(parse({ password: "12345678" }).success).toBe(true);
    expect(parse({ password: "x".repeat(72) }).success).toBe(true);
    const larga = parse({ password: "x".repeat(73) });
    expect(larga.success).toBe(false);
    expect(firstIssueMessage(larga.error!)).toBe("La contraseña admite hasta 72 caracteres.");
  });

  it("rechaza campos que no sean nombre o contraseña (correo y rol quedan fuera)", () => {
    const result = parse({ displayName: "Ana", role: "admin" });
    expect(result.success).toBe(false);
    expect(firstIssueMessage(result.error!)).toBe("Solo se puede cambiar el nombre visible y la contraseña.");
  });

  it("un cuerpo que no es un objeto no pasa", () => {
    expect(parse("hola").success).toBe(false);
    expect(parse(null).success).toBe(false);
  });

  it("el mensaje de error nunca repite la contraseña que se mandó", () => {
    const result = parse({ password: "abc1234" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).not.toContain("abc1234");
  });
});

function draft(overrides: Partial<AgentAccountDraft> = {}): AgentAccountDraft {
  return {
    originalDisplayName: "María",
    displayName: "María",
    password: "",
    confirmPassword: "",
    ...overrides,
  };
}

describe("validateAgentAccountDraft", () => {
  it("sin cambios no hay nada que guardar ni errores", () => {
    const result = validateAgentAccountDraft(draft());
    expect(result.hasChanges).toBe(false);
    expect(result.errors).toEqual({});
    expect(result.patch).toEqual({});
  });

  it("espacios alrededor del mismo nombre no cuentan como cambio", () => {
    expect(validateAgentAccountDraft(draft({ displayName: "  María " })).hasChanges).toBe(false);
  });

  it("un nombre nuevo va recortado en el cambio y sin contraseña", () => {
    const result = validateAgentAccountDraft(draft({ displayName: "  María José " }));
    expect(result.hasChanges).toBe(true);
    expect(result.isValid).toBe(true);
    expect(result.patch).toEqual({ displayName: "María José" });
  });

  it("un nombre vacío es un error del campo", () => {
    const result = validateAgentAccountDraft(draft({ displayName: "  " }));
    expect(result.isValid).toBe(false);
    expect(result.errors.displayName).toBe("El nombre visible no puede quedar vacío.");
  });

  it("una contraseña vacía no se manda", () => {
    const result = validateAgentAccountDraft(draft({ displayName: "Otra" }));
    expect(result.patch).not.toHaveProperty("password");
  });

  it("una contraseña de 7 caracteres es un error del campo", () => {
    const result = validateAgentAccountDraft(draft({ password: "1234567", confirmPassword: "1234567" }));
    expect(result.isValid).toBe(false);
    expect(result.errors.password).toBe("La contraseña debe tener al menos 8 caracteres.");
  });

  it("una confirmación distinta es un error de la confirmación", () => {
    const result = validateAgentAccountDraft(draft({ password: "12345678", confirmPassword: "12345679" }));
    expect(result.isValid).toBe(false);
    expect(result.errors.confirmPassword).toBe("Las contraseñas no coinciden.");
    expect(result.errors.password).toBeUndefined();
  });

  it("contraseña y confirmación iguales van en el cambio, tal cual", () => {
    const result = validateAgentAccountDraft(draft({ password: " clave larga ", confirmPassword: " clave larga " }));
    expect(result.isValid).toBe(true);
    expect(result.patch).toEqual({ password: " clave larga " });
  });

  it("una confirmación escrita sin contraseña también es un error", () => {
    const result = validateAgentAccountDraft(draft({ confirmPassword: "12345678" }));
    expect(result.errors.confirmPassword).toBe("Las contraseñas no coinciden.");
    expect(result.isValid).toBe(false);
  });
});
