import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPlaybook, updatePlaybook, type PlaybookDraft } from "@/lib/mutations";

// ---------------------------------------------------------------------------
// T4, plan "El catálogo configurado sale siempre" (21/9/2026): la cuarta
// condición de "el repuesto manda" (H1, 18/9/2026) vive en la columna
// `ai_playbooks.cede_al_inventario` (T1). Esta prueba confirma que el
// borrador la lleva hasta el insert/update.
//
// Los fakes hermanos (`mutations-playbook-identity.test.ts`,
// `mutations-playbook-tags.test.ts`) no registran el payload que le llega a
// `ai_playbooks.insert`/`.update` — no hacía falta antes de esta columna—,
// así que acá el fake se endurece para capturarlo (trampa de CLAUDE.md: "Un
// fake de Supabase en un test puede tragarse el operador o el argumento").
// ---------------------------------------------------------------------------

let payloadInsert: Record<string, unknown> | undefined;
let payloadUpdate: Record<string, unknown> | undefined;

function createFakeSupabase() {
  const client = {
    from(table: string) {
      if (table === "ai_playbooks") {
        return {
          insert: (payload: Record<string, unknown>) => {
            payloadInsert = payload;
            return {
              select: () => ({ single: async () => ({ data: { id: "pb-nuevo" }, error: null }) }),
            };
          },
          update: (payload: Record<string, unknown>) => {
            payloadUpdate = payload;
            return { eq: async () => ({ error: null }) };
          },
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

function draft(cedeAlInventario: boolean): PlaybookDraft {
  return {
    name: "Catálogo general",
    triggerDescription: "el cliente pide el catálogo",
    responseText: "Acá tienes nuestro catálogo.",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    cedeAlInventario,
    tagIds: [],
  };
}

beforeEach(() => {
  payloadInsert = undefined;
  payloadUpdate = undefined;
});

describe("createPlaybook / updatePlaybook — cede_al_inventario (T4)", () => {
  it("el insert manda cede_al_inventario en true cuando el borrador lo trae encendido", async () => {
    await createPlaybook(createFakeSupabase(), draft(true));

    expect(payloadInsert).toMatchObject({ cede_al_inventario: true });
  });

  it("el insert manda cede_al_inventario en false cuando el borrador lo trae apagado", async () => {
    await createPlaybook(createFakeSupabase(), draft(false));

    expect(payloadInsert).toMatchObject({ cede_al_inventario: false });
  });

  it("el update manda cede_al_inventario con el valor del borrador", async () => {
    await updatePlaybook(createFakeSupabase(), "pb-1", draft(true));

    expect(payloadUpdate).toMatchObject({ cede_al_inventario: true });
  });
});
