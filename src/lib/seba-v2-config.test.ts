import { describe, expect, it } from "vitest";
import {
  AREAS,
  AREA_LABELS,
  SEBA_V2_MODES,
  SEBA_V2_MODE_DESCRIPTIONS,
  SEBA_V2_MODE_LABELS,
  hasWelcomeErrors,
  isArea,
  modeNeedsConfirmation,
  normalizeWelcomeDraft,
  parseAreas,
  parseCasheaSettings,
  parseSebaV2Mode,
  parseShadowLimits,
  toggleArea,
  validateWelcomeDraft,
  type WelcomeDraft,
} from "@/lib/seba-v2-config";

// Los topes se fijan con LITERALES (1000, 160, 2, 8, 999999.99): comparar contra
// el símbolo importado no probaría el número (CLAUDE.md, "un tope numérico
// probado contra su propio símbolo no prueba el número").

describe("áreas de un asesor", () => {
  it("son cuatro, en este orden", () => {
    expect([...AREAS]).toEqual(["pagos", "ventas", "envios", "reclamos"]);
    expect(AREA_LABELS).toEqual({ pagos: "Pagos", ventas: "Ventas", envios: "Envíos", reclamos: "Reclamos" });
  });

  it("isArea reconoce solo las cuatro", () => {
    expect(isArea("pagos")).toBe(true);
    expect(isArea("Pagos")).toBe(false);
    expect(isArea(42)).toBe(false);
    expect(isArea(null)).toBe(false);
  });

  it("parseAreas: lo que no es un arreglo da []", () => {
    expect(parseAreas(null)).toEqual([]);
    expect(parseAreas(undefined)).toEqual([]);
    expect(parseAreas("pagos")).toEqual([]);
    expect(parseAreas({ 0: "pagos" })).toEqual([]);
  });

  it("parseAreas: descarta desconocidos y repetidos, y devuelve en el orden de AREAS", () => {
    expect(parseAreas(["reclamos", "pagos", "cobranza", 7, null, "pagos"])).toEqual(["pagos", "reclamos"]);
    expect(parseAreas(["envios", "ventas", "pagos", "reclamos"])).toEqual(["pagos", "ventas", "envios", "reclamos"]);
  });

  it("toggleArea enciende y apaga sin repetir y en el orden de AREAS", () => {
    expect(toggleArea(["reclamos"], "pagos", true)).toEqual(["pagos", "reclamos"]);
    expect(toggleArea(["pagos"], "pagos", true)).toEqual(["pagos"]);
    expect(toggleArea(["pagos", "ventas"], "pagos", false)).toEqual(["ventas"]);
    expect(toggleArea([], "envios", false)).toEqual([]);
  });

  it("toggleArea no muta el arreglo que recibe", () => {
    const original: readonly ("pagos" | "ventas")[] = ["ventas"];
    toggleArea(original, "pagos", true);
    expect(original).toEqual(["ventas"]);
  });
});

describe("modo de Seba v2", () => {
  it("son cinco, con 'apagado' primero", () => {
    expect([...SEBA_V2_MODES]).toEqual(["apagado", "sombra", "copiloto", "fuera_de_horario", "siempre"]);
  });

  it("un valor desconocido cae a 'apagado': nunca se inventa un modo que responda solo", () => {
    expect(parseSebaV2Mode("siempre")).toBe("siempre");
    expect(parseSebaV2Mode("fuera_de_horario")).toBe("fuera_de_horario");
    expect(parseSebaV2Mode("Siempre")).toBe("apagado");
    expect(parseSebaV2Mode("auto")).toBe("apagado");
    expect(parseSebaV2Mode(null)).toBe("apagado");
    expect(parseSebaV2Mode(undefined)).toBe("apagado");
    expect(parseSebaV2Mode(3)).toBe("apagado");
  });

  it("etiquetas y descripciones literales", () => {
    expect(SEBA_V2_MODE_LABELS).toEqual({
      apagado: "Apagado",
      sombra: "Sombra",
      copiloto: "Copiloto",
      fuera_de_horario: "Fuera de horario",
      siempre: "Siempre",
    });
    expect(SEBA_V2_MODE_DESCRIPTIONS).toEqual({
      apagado: "Seba v2 no corre. Es el estado de fábrica.",
      sombra: "Redacta cada respuesta en silencio y la guarda para revisión. Al cliente no le llega nada.",
      copiloto: "Le propone la respuesta al asesor, que decide si la envía, la edita o la descarta.",
      fuera_de_horario: "Responde sola a los clientes cuando la tienda está cerrada.",
      siempre: "Responde sola a los clientes a toda hora.",
    });
  });

  it.each([
    ["apagado", false],
    ["sombra", false],
    ["copiloto", false],
    ["fuera_de_horario", true],
    ["siempre", true],
  ] as const)("modeNeedsConfirmation(%s) = %s", (mode, esperado) => {
    expect(modeNeedsConfirmation(mode)).toBe(esperado);
  });
});

describe("normalizeWelcomeDraft", () => {
  it("recorta espacios del texto y de cada frase, sin tocar saltos de línea internos", () => {
    const out = normalizeWelcomeDraft({ welcomeText: "  Hola\n\ncómo estás  ", followups: ["  uno ", "dos\ncon salto  "] });
    expect(out).toEqual({ welcomeText: "Hola\n\ncómo estás", followups: ["uno", "dos\ncon salto"] });
  });
});

describe("validateWelcomeDraft", () => {
  const ok: WelcomeDraft = { welcomeText: "Hola", followups: ["Una frase", "Otra frase"] };

  it("un borrador correcto no da errores", () => {
    const errors = validateWelcomeDraft(ok);
    expect(errors).toEqual({});
    expect(hasWelcomeErrors(errors)).toBe(false);
  });

  it("texto vacío o solo espacios", () => {
    expect(validateWelcomeDraft({ ...ok, welcomeText: "   " }).welcomeText).toBe("Escribe el mensaje de bienvenida.");
    expect(validateWelcomeDraft({ ...ok, welcomeText: "" }).welcomeText).toBe("Escribe el mensaje de bienvenida.");
  });

  it("borde exacto del texto: 1000 entra, 1001 no", () => {
    expect(validateWelcomeDraft({ ...ok, welcomeText: "a".repeat(1000) }).welcomeText).toBeUndefined();
    expect(validateWelcomeDraft({ ...ok, welcomeText: "a".repeat(1001) }).welcomeText).toBe(
      "El mensaje no puede pasar de 1000 caracteres."
    );
  });

  it("los espacios de los bordes no cuentan para el tope del texto", () => {
    expect(validateWelcomeDraft({ ...ok, welcomeText: ` ${"a".repeat(1000)} ` }).welcomeText).toBeUndefined();
  });

  it("frases: con 1 falta, con 2 entra, con 8 entra y con 9 sobra", () => {
    const frases = (n: number) => Array.from({ length: n }, (_, i) => `Frase ${i + 1}`);
    expect(validateWelcomeDraft({ ...ok, followups: frases(1) }).followups).toBe(
      "Hacen falta al menos 2 frases: Seba no repite la misma dos veces seguidas."
    );
    expect(validateWelcomeDraft({ ...ok, followups: [] }).followups).toBe(
      "Hacen falta al menos 2 frases: Seba no repite la misma dos veces seguidas."
    );
    expect(validateWelcomeDraft({ ...ok, followups: frases(2) }).followups).toBeUndefined();
    expect(validateWelcomeDraft({ ...ok, followups: frases(8) }).followups).toBeUndefined();
    expect(validateWelcomeDraft({ ...ok, followups: frases(9) }).followups).toBe("Máximo 8 frases.");
  });

  it("una frase vacía marca SU posición", () => {
    const errors = validateWelcomeDraft({ ...ok, followups: ["Una", "   ", "Tres"] });
    expect(errors.followupItems).toEqual({ 1: "Escribe la frase o quítala." });
    expect(errors.followups).toBeUndefined();
    expect(hasWelcomeErrors(errors)).toBe(true);
  });

  it("borde exacto de la frase: 160 entra, 161 no (marca su posición)", () => {
    expect(validateWelcomeDraft({ ...ok, followups: ["a".repeat(160), "b"] }).followupItems).toBeUndefined();
    const errors = validateWelcomeDraft({ ...ok, followups: ["a", "b".repeat(161)] });
    expect(errors.followupItems).toEqual({ 1: "La frase no puede pasar de 160 caracteres." });
  });

  it("las frases con espacios alrededor se normalizan antes de medirlas", () => {
    expect(validateWelcomeDraft({ ...ok, followups: [` ${"a".repeat(160)} `, "b"] })).toEqual({});
  });

  it("hasWelcomeErrors ve cualquiera de los tres tipos", () => {
    expect(hasWelcomeErrors({ welcomeText: "x" })).toBe(true);
    expect(hasWelcomeErrors({ followups: "x" })).toBe(true);
    expect(hasWelcomeErrors({ followupItems: { 0: "x" } })).toBe(true);
    expect(hasWelcomeErrors({ followupItems: {} })).toBe(false);
    expect(hasWelcomeErrors({})).toBe(false);
  });
});

describe("parseShadowLimits", () => {
  it("acepta punto o coma decimal y devuelve números", () => {
    expect(parseShadowLimits({ capUsd: "25,5", samplePct: "40" })).toEqual({ ok: true, capUsd: 25.5, samplePct: 40 });
    expect(parseShadowLimits({ capUsd: "25.5", samplePct: "0" })).toEqual({ ok: true, capUsd: 25.5, samplePct: 0 });
    expect(parseShadowLimits({ capUsd: " 5 ", samplePct: " 100 " })).toEqual({ ok: true, capUsd: 5, samplePct: 100 });
    expect(parseShadowLimits({ capUsd: "0", samplePct: "10" })).toEqual({ ok: true, capUsd: 0, samplePct: 10 });
  });

  it("tope: 999999.99 entra y 1000000 no", () => {
    expect(parseShadowLimits({ capUsd: "999999.99", samplePct: "1" })).toEqual({ ok: true, capUsd: 999999.99, samplePct: 1 });
    expect(parseShadowLimits({ capUsd: "1000000", samplePct: "1" })).toEqual({
      ok: false,
      errors: { capUsd: "El monto es demasiado grande." },
    });
  });

  it.each([
    ["", "Escribe un monto en dólares."],
    ["   ", "Escribe un monto en dólares."],
    ["abc", "Escribe un monto en dólares."],
    ["1.000,50", "Escribe un monto en dólares."],
    ["-3", "El monto no puede ser negativo."],
    ["-0,5", "El monto no puede ser negativo."],
    ["1,234", "Usa como mucho dos decimales."],
    ["10.001", "Usa como mucho dos decimales."],
  ])("monto %j → %s", (capUsd, mensaje) => {
    expect(parseShadowLimits({ capUsd, samplePct: "10" })).toEqual({ ok: false, errors: { capUsd: mensaje } });
  });

  it.each(["", "-1", "101", "50.5", "50,5", "abc", "1000"])("porcentaje %j se rechaza", (samplePct) => {
    expect(parseShadowLimits({ capUsd: "5", samplePct })).toEqual({
      ok: false,
      errors: { samplePct: "Escribe un porcentaje entero entre 0 y 100." },
    });
  });

  it("reporta los dos errores a la vez", () => {
    expect(parseShadowLimits({ capUsd: "", samplePct: "x" })).toEqual({
      ok: false,
      errors: { capUsd: "Escribe un monto en dólares.", samplePct: "Escribe un porcentaje entero entre 0 y 100." },
    });
  });
});

describe("parseCasheaSettings", () => {
  const base = { datosText: "Mándame tu cédula", minimoUsd: "25", seisCuotasDesdeUsd: "100" };

  it("acepta un borrador correcto y recorta el texto", () => {
    expect(parseCasheaSettings({ ...base, datosText: "  Mándame tu cédula  ", minimoUsd: "25,5" })).toEqual({
      ok: true,
      datosText: "Mándame tu cédula",
      minimoUsd: 25.5,
      seisCuotasDesdeUsd: 100,
    });
  });

  it("texto vacío, y borde exacto: 1000 entra, 1001 no", () => {
    expect(parseCasheaSettings({ ...base, datosText: "  " })).toEqual({
      ok: false,
      errors: { datosText: "Escribe el texto que pide los datos." },
    });
    expect(parseCasheaSettings({ ...base, datosText: "a".repeat(1000) }).ok).toBe(true);
    expect(parseCasheaSettings({ ...base, datosText: "a".repeat(1001) })).toEqual({
      ok: false,
      errors: { datosText: "El texto no puede pasar de 1000 caracteres." },
    });
  });

  it("cada monto se valida con las mismas reglas que la sombra", () => {
    expect(parseCasheaSettings({ ...base, minimoUsd: "-1", seisCuotasDesdeUsd: "1,999" })).toEqual({
      ok: false,
      errors: { minimoUsd: "El monto no puede ser negativo.", seisCuotasDesdeUsd: "Usa como mucho dos decimales." },
    });
    expect(parseCasheaSettings({ ...base, seisCuotasDesdeUsd: "" })).toEqual({
      ok: false,
      errors: { seisCuotasDesdeUsd: "Escribe un monto en dólares." },
    });
    expect(parseCasheaSettings({ ...base, minimoUsd: "1000000" })).toEqual({
      ok: false,
      errors: { minimoUsd: "El monto es demasiado grande." },
    });
  });
});
