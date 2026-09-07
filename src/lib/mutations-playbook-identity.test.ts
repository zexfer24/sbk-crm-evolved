import { describe, expect, it, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPlaybook, updatePlaybook, PlaybookIdentityError, type PlaybookDraft } from "@/lib/mutations";

// ---------------------------------------------------------------------------
// El 26-27/8/2026 la IA se presentó 60 veces como "asistente automatizado":
// la prohibición vivía solo en el guion y el modelo la rompió igual. Los
// escenarios son la única otra vía por la que sale texto sin pasar por la
// guarda en caliente de agent.ts, así que createPlaybook/updatePlaybook la
// aplican ANTES de tocar la base. Estas pruebas fijan eso: cuando el texto
// calza, ni siquiera se llama a `from` — la base no se toca.
// ---------------------------------------------------------------------------

let llamadasFrom: string[] = [];

function createFakeSupabase() {
  const client = {
    from(table: string) {
      llamadasFrom.push(table);

      if (table === "ai_playbooks") {
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "pb-nuevo" }, error: null }) }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }

      if (table === "ai_playbook_tags") {
        return {
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
          delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
          insert: async () => ({ error: null }),
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return client as unknown as SupabaseClient;
}

function draft(responseText: string): PlaybookDraft {
  return {
    name: "Escenario de prueba",
    triggerDescription: "el cliente pregunta algo",
    responseText,
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    tagIds: [],
  };
}

beforeEach(() => {
  llamadasFrom = [];
});

describe("createPlaybook — guarda de identidad", () => {
  it("rechaza la frase real del 26/8/2026 sin tocar la base", async () => {
    let capturado: unknown;
    try {
      await createPlaybook(createFakeSupabase(), draft("Soy el asistente automatizado de SBK Motorcycles."));
    } catch (err) {
      capturado = err;
    }

    expect(capturado).toBeInstanceOf(PlaybookIdentityError);
    const err = capturado as PlaybookIdentityError;
    expect(err.name).toBe("PlaybookIdentityError");
    expect(err.message).toContain("automatizada");
    expect(err.message).toContain("«asistente automatizado»");
    expect(err.match.categoria).toBe("automatizacion");
    expect(llamadasFrom).toEqual([]);
  });

  it("rechaza una autorreferencia a persona sin tocar la base", async () => {
    let capturado: unknown;
    try {
      await createPlaybook(createFakeSupabase(), draft("Hola, me llamo Carlos y estoy en el mostrador."));
    } catch (err) {
      capturado = err;
    }

    expect(capturado).toBeInstanceOf(PlaybookIdentityError);
    const err = capturado as PlaybookIdentityError;
    expect(err.message).toContain("una persona concreta");
    expect(err.match.categoria).toBe("persona");
    expect(llamadasFrom).toEqual([]);
  });

  it("un repuesto del catálogo (\"automático\") no dispara la guarda y sí inserta", async () => {
    await expect(
      createPlaybook(
        createFakeSupabase(),
        draft("El automático de la Horse está en 12$ a tasa BCV. Te lo confirma un asesor.")
      )
    ).resolves.toBeUndefined();

    expect(llamadasFrom).toContain("ai_playbooks");
  });
});

describe("updatePlaybook — guarda de identidad", () => {
  it("rechaza la frase real del 26/8/2026 sin tocar la base", async () => {
    await expect(
      updatePlaybook(createFakeSupabase(), "pb-1", draft("Soy el asistente automatizado de SBK Motorcycles."))
    ).rejects.toBeInstanceOf(PlaybookIdentityError);

    expect(llamadasFrom).toEqual([]);
  });

  it("un uso real del negocio (\"el sistema lo hace automáticamente\", Cashea) no dispara la guarda y sí actualiza", async () => {
    await expect(
      updatePlaybook(
        createFakeSupabase(),
        "pb-1",
        draft("El sistema lo hace automáticamente cuando pagas con la app de Cashea.")
      )
    ).resolves.toBeUndefined();

    expect(llamadasFrom).toContain("ai_playbooks");
  });
});
