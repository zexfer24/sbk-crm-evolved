import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgents, fetchAllAgents } from "@/lib/data";

// ---------------------------------------------------------------------------
// El rol `caja` (13/10/2026) solo ve el Inventario. Una cuenta de caja no es
// un asesor: no puede ser el destino de "Asignar a…" ni de ninguna lista de
// asesores asignables, aunque esté activa. `fetchAgents` alimenta justo esas
// listas (Recorrido, Casos); `fetchAllAgents` es el roster completo de Control
// IA y SÍ devuelve la caja, porque la pestaña «Equipo» (solo admin) tiene que
// poder renombrarla o cambiarle la contraseña — el roster de asesores la
// filtra en pantalla (`agent-roster-panel`).
//
// El fake aplica cada filtro de verdad (operador + columna + valor), no solo
// lo registra: así excluir la caja en la consulta se nota en el resultado, y
// un fake que ignorara `.neq()` no taparía el hueco (CLAUDE.md, 20/9/2026).
// ---------------------------------------------------------------------------

type Fila = {
  id: string;
  display_name: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
};

const FILAS: Fila[] = [
  { id: "a1", display_name: "Ana", full_name: null, avatar_url: null, role: "agent", is_active: true },
  { id: "s1", display_name: "Sofía", full_name: null, avatar_url: null, role: "supervisor", is_active: true },
  { id: "c1", display_name: "Caja", full_name: null, avatar_url: null, role: "caja", is_active: true },
  { id: "c2", display_name: "Caja inactiva", full_name: null, avatar_url: null, role: "caja", is_active: false },
];

type Filtro = { op: "eq" | "neq"; col: string; val: unknown };

function crearFake(filas: Fila[]) {
  const filtros: Filtro[] = [];
  const client = {
    from(table: string) {
      if (table !== "agents") throw new Error(`tabla inesperada: ${table}`);
      return {
        select() {
          const aplicados: Filtro[] = [];
          const builder = {
            eq(col: string, val: unknown) {
              aplicados.push({ op: "eq", col, val });
              filtros.push({ op: "eq", col, val });
              return builder;
            },
            neq(col: string, val: unknown) {
              aplicados.push({ op: "neq", col, val });
              filtros.push({ op: "neq", col, val });
              return builder;
            },
            order() {
              const data = filas.filter((f) =>
                aplicados.every((a) => {
                  const actual = (f as unknown as Record<string, unknown>)[a.col];
                  return a.op === "eq" ? actual === a.val : actual !== a.val;
                })
              );
              return Promise.resolve({ data, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, filtros };
}

describe("fetchAgents — los asesores asignables", () => {
  it("excluye el rol caja en la propia consulta (operador, columna y valor)", async () => {
    const { client, filtros } = crearFake(FILAS);

    await fetchAgents(client);

    expect(filtros).toContainEqual({ op: "neq", col: "role", val: "caja" });
    expect(filtros).toContainEqual({ op: "eq", col: "is_active", val: true });
  });

  it("devuelve a los asesores activos y ninguna cuenta de caja", async () => {
    const { client } = crearFake(FILAS);

    const agentes = await fetchAgents(client);

    expect(agentes.map((a) => a.id)).toEqual(["a1", "s1"]);
  });
});

describe("fetchAllAgents — el roster completo de Control IA", () => {
  it("sigue devolviendo todas las cuentas, caja incluida: «Equipo» las administra", async () => {
    const { client } = crearFake(FILAS);

    const agentes = await fetchAllAgents(client);

    expect(agentes.map((a) => a.id)).toEqual(["a1", "s1", "c1", "c2"]);
    expect(agentes.find((a) => a.id === "c1")?.role).toBe("caja");
  });
});
