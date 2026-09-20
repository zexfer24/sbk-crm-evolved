import { describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_LESSONS,
  MAX_GLOBAL_LESSONS,
  MAX_LESSON_CHARS,
  buildChatLessonsLine,
  buildGlobalLessonsBlock,
  fetchTurnLessons,
} from "@/lib/ai/lessons";

/**
 * F (20/9/2026, "El resguardo antes del push"): el resto de este archivo mide
 * el MECANISMO de recorte usando el propio símbolo importado
 * (`MAX_GLOBAL_LESSONS + 10`, por ejemplo) — así que un cambio en el VALOR de
 * la constante no pone rojo ningún test existente, porque cada test se
 * reajusta solo. Estos tres fijan el número tal como lo documenta el
 * comentario del módulo (presupuesto del plan "Seba atiende el mostrador",
 * T5, 18/9/2026), para que cambiarlo por accidente sí se note.
 */
describe("los topes son los números exactos del plan (F, 20/9/2026)", () => {
  it("MAX_GLOBAL_LESSONS es 15", () => {
    expect(MAX_GLOBAL_LESSONS).toBe(15);
  });

  it("MAX_CHAT_LESSONS es 5", () => {
    expect(MAX_CHAT_LESSONS).toBe(5);
  });

  it("MAX_LESSON_CHARS es 200", () => {
    expect(MAX_LESSON_CHARS).toBe(200);
  });
});

describe("buildGlobalLessonsBlock", () => {
  it("bloque vacío sin lecciones", () => {
    expect(buildGlobalLessonsBlock([])).toBe("");
  });

  it("una lección aparece como viñeta, con la cabecera fija", () => {
    const bloque = buildGlobalLessonsBlock(["No prometas descuentos por WhatsApp"]);

    expect(bloque).toContain("LECCIONES DEL EQUIPO");
    expect(bloque).toContain("- No prometas descuentos por WhatsApp");
  });

  /** Tope: MAX_GLOBAL_LESSONS = 15. Con más, se recorta a las primeras 15 del arreglo recibido. */
  it("recorta a MAX_GLOBAL_LESSONS aunque lleguen más", () => {
    const muchas = Array.from({ length: MAX_GLOBAL_LESSONS + 10 }, (_, i) => `lección ${i}`);

    const bloque = buildGlobalLessonsBlock(muchas);
    const lineas = bloque.split("\n").filter((linea) => linea.startsWith("- "));

    expect(lineas).toHaveLength(MAX_GLOBAL_LESSONS);
    // Se queda con las PRIMERAS del arreglo (el orden ya lo decidió quien
    // llama — created_at desc en fetchTurnLessons), no una selección al azar.
    expect(lineas[0]).toContain("lección 0");
    expect(lineas.at(-1)).toContain(`lección ${MAX_GLOBAL_LESSONS - 1}`);
  });

  /** Clip: el CHECK de la base ya limita a 200, pero acá se recorta igual, defensivamente. */
  it("recorta cada lección a MAX_LESSON_CHARS", () => {
    const larga = "x".repeat(MAX_LESSON_CHARS + 50);

    const bloque = buildGlobalLessonsBlock([larga]);

    expect(bloque).toContain(`- ${"x".repeat(MAX_LESSON_CHARS)}`);
    expect(bloque).not.toContain("x".repeat(MAX_LESSON_CHARS + 1));
  });

  /** Orden: no reordena — respeta el arreglo tal como llega. */
  it("mantiene el orden en el que llegan las lecciones", () => {
    const bloque = buildGlobalLessonsBlock(["primera", "segunda", "tercera"]);
    const indicePrimera = bloque.indexOf("primera");
    const indiceSegunda = bloque.indexOf("segunda");
    const indiceTercera = bloque.indexOf("tercera");

    expect(indicePrimera).toBeLessThan(indiceSegunda);
    expect(indiceSegunda).toBeLessThan(indiceTercera);
  });
});

describe("buildChatLessonsLine", () => {
  it("línea vacía sin lecciones de esta conversación", () => {
    expect(buildChatLessonsLine([])).toBe("");
  });

  it("una lección aparece con la cabecera de chat", () => {
    const linea = buildChatLessonsLine(["Este cliente ya pagó con Cashea"]);

    expect(linea).toContain("LECCIONES DE ESTE CHAT");
    expect(linea).toContain("- Este cliente ya pagó con Cashea");
  });

  it("recorta a MAX_CHAT_LESSONS aunque lleguen más", () => {
    const muchas = Array.from({ length: MAX_CHAT_LESSONS + 3 }, (_, i) => `lección ${i}`);

    const linea = buildChatLessonsLine(muchas);
    const cantidad = linea.split("\n").filter((l) => l.startsWith("- ")).length;

    expect(cantidad).toBe(MAX_CHAT_LESSONS);
  });

  it("recorta cada lección a MAX_LESSON_CHARS", () => {
    const larga = "y".repeat(MAX_LESSON_CHARS + 20);

    const linea = buildChatLessonsLine([larga]);

    expect(linea).toContain(`- ${"y".repeat(MAX_LESSON_CHARS)}`);
    expect(linea).not.toContain("y".repeat(MAX_LESSON_CHARS + 1));
  });
});

/** Un Supabase falso mínimo: dos consultas encadenadas a `ai_lessons`, distinguidas por el filtro `scope`. */
function fakeSupabase(options: {
  global?: string[];
  chat?: string[];
  error?: { message: string } | null;
}) {
  const { global = [], chat = [], error = null } = options;

  return {
    from(table: string) {
      if (table !== "ai_lessons") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);

      const filters: Record<string, unknown> = {};
      const builder = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        order() {
          return {
            limit: async () => {
              if (error) return { data: null, error };
              const rows = filters.scope === "conversacion" ? chat : global;
              return { data: rows.map((content) => ({ content })), error: null };
            },
          };
        },
      };
      return { select: () => builder };
    },
  };
}

/**
 * F (20/9/2026, "El resguardo antes del push"): `fakeSupabase` de arriba
 * confía en que la consulta real filtra por `kind` — solo distingue `scope`
 * para separar global de chat, así que nunca notaría que alguien le quitara
 * el `.eq("kind", "nota")` a `fetchTurnLessons`. Este fake, en cambio, aplica
 * de verdad TODOS los `.eq()` que la consulta le pasa contra un juego de
 * filas con `kind` mixto (nota/sinonimo): si el filtro de `kind` desaparece,
 * un sinónimo se cuela en el prompt como si fuera una lección de equipo.
 */
function fakeSupabaseConFilasMixtas(
  filas: { scope: string; kind: string; content: string; conversation_id?: string; is_active?: boolean }[]
) {
  return {
    from(table: string) {
      if (table !== "ai_lessons") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);

      const filters: Record<string, unknown> = {};
      const builder = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        order() {
          return {
            limit: async () => {
              const rows = filas.filter((fila) =>
                Object.entries(filters).every(([col, val]) => (fila as Record<string, unknown>)[col] === val)
              );
              return { data: rows.map((fila) => ({ content: fila.content })), error: null };
            },
          };
        },
      };
      return { select: () => builder };
    },
  };
}

describe("fetchTurnLessons — filtra por kind = 'nota' (F, 20/9/2026)", () => {
  it("un sinónimo global (kind='sinonimo') no se cuela entre las lecciones globales", async () => {
    const supabase = fakeSupabaseConFilasMixtas([
      { scope: "global", kind: "nota", is_active: true, content: "No prometas descuentos" },
      { scope: "global", kind: "sinonimo", is_active: true, content: "pastilla -> pastillas de freno" },
    ]);

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabase, "conv-1");

    expect(lessons.global).toEqual(["No prometas descuentos"]);
  });

  it("un sinónimo de esta conversación (kind='sinonimo') no se cuela entre las lecciones de chat", async () => {
    const supabase = fakeSupabaseConFilasMixtas([
      {
        scope: "conversacion",
        kind: "nota",
        conversation_id: "conv-1",
        is_active: true,
        content: "Este cliente ya pagó con Cashea",
      },
      {
        scope: "conversacion",
        kind: "sinonimo",
        conversation_id: "conv-1",
        is_active: true,
        content: "pastilla -> pastillas de freno",
      },
    ]);

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabase, "conv-1");

    expect(lessons.chat).toEqual(["Este cliente ya pagó con Cashea"]);
  });
});

describe("fetchTurnLessons", () => {
  it("con lecciones en las dos tablas, las separa por scope", async () => {
    const supabase = fakeSupabase({
      global: ["No prometas descuentos", "Siempre confirma el color"],
      chat: ["Este cliente ya pagó con Cashea"],
    });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabase, "conv-1");

    expect(lessons.global).toEqual(["No prometas descuentos", "Siempre confirma el color"]);
    expect(lessons.chat).toEqual(["Este cliente ya pagó con Cashea"]);
  });

  it("sin ninguna lección, devuelve los dos arreglos vacíos", async () => {
    const supabase = fakeSupabase({});

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabase, "conv-1");

    expect(lessons).toEqual({ global: [], chat: [] });
  });

  /** Ante un error de la base, nunca tumba el turno: vacío + log.warn con errorText. */
  it("con un error de la base, devuelve vacío y avisa con turno_lecciones_no_legibles", async () => {
    const { log } = await import("@/lib/log");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const supabase = fakeSupabase({ error: { message: "conexión perdida" } });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabase, "conv-1");

    expect(lessons).toEqual({ global: [], chat: [] });
    expect(warn).toHaveBeenCalledWith(
      "turno_lecciones_no_legibles",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );

    warn.mockRestore();
  });

  /** Si el cliente falso LANZA (una excepción, no un `{ error }`), tampoco se cae. */
  it("si la consulta lanza en vez de devolver un error, igual devuelve vacío sin propagar", async () => {
    const supabaseQueRompe = {
      from() {
        throw new Error("boom");
      },
    };

    // @ts-expect-error -- fake mínimo suficiente para este test
    const lessons = await fetchTurnLessons(supabaseQueRompe, "conv-1");

    expect(lessons).toEqual({ global: [], chat: [] });
  });
});
