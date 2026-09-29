import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimNextAvailableAgent } from "@/lib/ai/claim-agent";

interface FakeAgentRow {
  id: string;
  display_name: string;
  is_active: boolean;
  last_assigned_at: string | null;
}

/**
 * Fake que simula el comportamiento atómico real de Postgres para
 * `UPDATE agents SET last_assigned_at = now() WHERE id = $1 AND
 * last_assigned_at IS NOT DISTINCT FROM $2`: el chequeo-y-set del valor
 * "visto" ocurre de forma síncrona, igual que garantiza una fila real.
 */
function createFakeSupabase(agents: FakeAgentRow[]) {
  const rows = new Map(agents.map((a) => [a.id, { ...a }]));

  const client = {
    from(table: string) {
      if (table !== "agents") throw new Error(`tabla inesperada: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return {
                    limit(n: number) {
                      // Copia como una respuesta real de PostgREST: un snapshot
                      // JSON, no un puntero vivo a la fila en el servidor.
                      const active = [...rows.values()]
                        .map((r) => ({ ...r }))
                        .filter((r) => r.is_active)
                        .sort((a, b) => {
                          if (a.last_assigned_at === b.last_assigned_at) return 0;
                          if (a.last_assigned_at === null) return -1;
                          if (b.last_assigned_at === null) return 1;
                          return a.last_assigned_at.localeCompare(b.last_assigned_at);
                        })
                        .slice(0, n);
                      return Promise.resolve({ data: active, error: null });
                    },
                  };
                },
              };
            },
          };
        },
        update(values: { last_assigned_at: string }) {
          return {
            eq(_col: string, id: string) {
              const row = rows.get(id);
              return {
                eq(_col2: string, seenValue: string) {
                  return {
                    select() {
                      if (!row || row.last_assigned_at !== seenValue) {
                        return Promise.resolve({ data: [], error: null });
                      }
                      row.last_assigned_at = values.last_assigned_at;
                      return Promise.resolve({ data: [{ id: row.id, display_name: row.display_name }], error: null });
                    },
                  };
                },
                is() {
                  return {
                    select() {
                      if (!row || row.last_assigned_at !== null) {
                        return Promise.resolve({ data: [], error: null });
                      }
                      row.last_assigned_at = values.last_assigned_at;
                      return Promise.resolve({ data: [{ id: row.id, display_name: row.display_name }], error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, rows };
}

describe("claimNextAvailableAgent", () => {
  it("reclama al asesor con last_assigned_at más antiguo (null primero)", async () => {
    const { client } = createFakeSupabase([
      { id: "a1", display_name: "Ana", is_active: true, last_assigned_at: "2026-01-01T00:00:00Z" },
      { id: "a2", display_name: "Beto", is_active: true, last_assigned_at: null },
    ]);

    const claimed = await claimNextAvailableAgent(client);
    expect(claimed?.id).toBe("a2");
  });

  it("dos reclamos casi simultáneos para el mismo pool: cada uno se lleva un asesor distinto", async () => {
    const { client } = createFakeSupabase([
      { id: "a1", display_name: "Ana", is_active: true, last_assigned_at: null },
      { id: "a2", display_name: "Beto", is_active: true, last_assigned_at: null },
    ]);

    const [first, second] = await Promise.all([
      claimNextAvailableAgent(client),
      claimNextAvailableAgent(client),
    ]);

    expect(first?.id).not.toBe(second?.id);
    expect([first?.id, second?.id].sort()).toEqual(["a1", "a2"]);
  });

  it("sin asesores activos, devuelve null", async () => {
    const { client } = createFakeSupabase([]);
    const claimed = await claimNextAvailableAgent(client);
    expect(claimed).toBeNull();
  });

  describe("excluir (T10b-2, reasignación por demora)", () => {
    it("nunca devuelve a un asesor excluido, aunque sea el de last_assigned_at más antiguo", async () => {
      const { client, rows } = createFakeSupabase([
        { id: "a1", display_name: "Ana", is_active: true, last_assigned_at: null },
        { id: "a2", display_name: "Beto", is_active: true, last_assigned_at: "2026-01-01T00:00:00Z" },
      ]);

      const claimed = await claimNextAvailableAgent(client, { excluir: ["a1"] });

      expect(claimed?.id).toBe("a2");
      // El excluido no se "marca" como asignado: su turno de reparto sigue intacto.
      expect(rows.get("a1")?.last_assigned_at).toBeNull();
    });

    it("excluye varios a la vez, incluso más de los que caben en el pool de candidatos (5)", async () => {
      const { client } = createFakeSupabase([
        ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id, i) => ({
          id,
          display_name: id,
          is_active: true,
          last_assigned_at: `2026-01-0${i + 1}T00:00:00Z`,
        })),
        { id: "a7", display_name: "Gabi", is_active: true, last_assigned_at: "2026-02-01T00:00:00Z" },
      ]);

      const claimed = await claimNextAvailableAgent(client, {
        excluir: ["a1", "a2", "a3", "a4", "a5", "a6"],
      });

      expect(claimed?.id).toBe("a7");
    });

    it("si todos los activos están excluidos, no reclama a nadie (igual que sin asesores)", async () => {
      const { client, rows } = createFakeSupabase([
        { id: "a1", display_name: "Ana", is_active: true, last_assigned_at: null },
        { id: "a2", display_name: "Beto", is_active: true, last_assigned_at: null },
      ]);

      const claimed = await claimNextAvailableAgent(client, { excluir: ["a1", "a2"] });

      expect(claimed).toBeNull();
      expect(rows.get("a1")?.last_assigned_at).toBeNull();
      expect(rows.get("a2")?.last_assigned_at).toBeNull();
    });

    it("sin excluir (o con lista vacía) el reparto es el de siempre", async () => {
      const filas: FakeAgentRow[] = [
        { id: "a1", display_name: "Ana", is_active: true, last_assigned_at: "2026-01-01T00:00:00Z" },
        { id: "a2", display_name: "Beto", is_active: true, last_assigned_at: null },
      ];
      const sinOpciones = await claimNextAvailableAgent(createFakeSupabase(filas).client);
      const listaVacia = await claimNextAvailableAgent(createFakeSupabase(filas).client, { excluir: [] });

      expect(sinOpciones?.id).toBe("a2");
      expect(listaVacia?.id).toBe("a2");
    });
  });
});
