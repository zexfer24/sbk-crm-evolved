import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { escribirCarritoDeSeba } from "./carrito-servidor";

/**
 * Fake de Supabase que REGISTRA cada operación con tabla, operador + columna +
 * valor de cada filtro y el payload (un fake que ignora el operador o el valor no
 * detecta un `.eq` cambiado por un `.neq`, ni un id equivocado).
 */
interface Filtro {
  operador: string;
  columna: string;
  valor: unknown;
}
interface Operacion {
  tabla: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  columnas?: string;
  filtros: Filtro[];
}
interface Respuesta {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

function crearFake(responder: (op: Operacion) => Respuesta) {
  const operaciones: Operacion[] = [];

  function constructor(tabla: string) {
    const op: Operacion = { tabla, op: "select", filtros: [] };
    const q = {
      select(columnas?: string) {
        // `insert(...).select("id")` conserva la operación de escritura.
        if (op.op === "select") op.columnas = columnas;
        return q;
      },
      insert(payload: unknown) {
        op.op = "insert";
        op.payload = payload;
        return q;
      },
      update(payload: unknown) {
        op.op = "update";
        op.payload = payload;
        return q;
      },
      eq(columna: string, valor: unknown) {
        op.filtros.push({ operador: "eq", columna, valor });
        return q;
      },
      in(columna: string, valor: unknown) {
        op.filtros.push({ operador: "in", columna, valor });
        return q;
      },
      then(resolve: (v: unknown) => unknown) {
        operaciones.push(op);
        const r = responder(op);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve);
      },
    };
    return q;
  }

  const client = { from: (tabla: string) => constructor(tabla) } as unknown as SupabaseClient<Database>;
  return { client, operaciones };
}

const CONV = "conv-1";
const P1 = "prod-1";
const P2 = "prod-2";

describe("escribirCarritoDeSeba", () => {
  it("inserta con origen «seba» los productos que el carrito aún no tiene", async () => {
    const { client, operaciones } = crearFake((op) => (op.op === "select" ? { data: [] } : {}));

    await escribirCarritoDeSeba(client, CONV, [
      { productId: P1, cantidad: 2, priceKind: "promocion" },
      { productId: P2, cantidad: 1, priceKind: "estandar" },
    ]);

    const inserts = operaciones.filter((o) => o.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].tabla).toBe("conversation_cart_items");
    expect(inserts[0].payload).toEqual([
      { conversation_id: CONV, product_id: P1, quantity: 2, price_kind: "promocion", origin: "seba" },
      { conversation_id: CONV, product_id: P2, quantity: 1, price_kind: "estandar", origin: "seba" },
    ]);
    expect(operaciones.filter((o) => o.op === "update")).toHaveLength(0);
  });

  it("lee los renglones existentes de ESTA conversación y de esos productos", async () => {
    const { client, operaciones } = crearFake((op) => (op.op === "select" ? { data: [] } : {}));

    await escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 1, priceKind: "promocion" }]);

    const lectura = operaciones.find((o) => o.op === "select")!;
    expect(lectura.tabla).toBe("conversation_cart_items");
    expect(lectura.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "in", columna: "product_id", valor: [P1] },
    ]);
  });

  it("si el producto ya está, actualiza cantidad y tipo de precio SIN tocar el origen", async () => {
    const { client, operaciones } = crearFake((op) =>
      op.op === "select" ? { data: [{ id: "item-1", product_id: P1, origin: "inventory" }] } : { data: [{ id: "item-1" }] }
    );

    await escribirCarritoDeSeba(client, CONV, [
      { productId: P1, cantidad: 3, priceKind: "estandar" },
      { productId: P2, cantidad: 1, priceKind: "promocion" },
    ]);

    const updates = operaciones.filter((o) => o.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ quantity: 3, price_kind: "estandar" });
    expect(updates[0].payload).not.toHaveProperty("origin");
    expect(updates[0].filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "eq", columna: "product_id", valor: P1 },
    ]);

    // El nuevo se inserta aparte; el existente no se reinserta.
    const inserts = operaciones.filter((o) => o.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual([
      { conversation_id: CONV, product_id: P2, quantity: 1, price_kind: "promocion", origin: "seba" },
    ]);
  });

  it("nunca borra renglones (el asesor puede haber puesto otros)", async () => {
    const { client, operaciones } = crearFake((op) => (op.op === "select" ? { data: [] } : {}));

    await escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 1, priceKind: "promocion" }]);

    expect(operaciones.map((o) => o.op)).not.toContain("delete");
  });

  it("una línea repetida cuenta una sola vez, la última gana", async () => {
    const { client, operaciones } = crearFake((op) => (op.op === "select" ? { data: [] } : {}));

    await escribirCarritoDeSeba(client, CONV, [
      { productId: P1, cantidad: 1, priceKind: "promocion" },
      { productId: P1, cantidad: 4, priceKind: "estandar" },
    ]);

    const insert = operaciones.find((o) => o.op === "insert")!;
    expect(insert.payload).toEqual([
      { conversation_id: CONV, product_id: P1, quantity: 4, price_kind: "estandar", origin: "seba" },
    ]);
  });

  it("sin líneas no toca la base", async () => {
    const { client, operaciones } = crearFake(() => ({}));

    await escribirCarritoDeSeba(client, CONV, []);

    expect(operaciones).toHaveLength(0);
  });

  it("lanza si la lectura devuelve error de base", async () => {
    const { client } = crearFake(() => ({ error: { message: "se cayó la base" } }));

    await expect(
      escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 1, priceKind: "promocion" }])
    ).rejects.toThrow("se cayó la base");
  });

  it("lanza si el insert devuelve error de base", async () => {
    const { client } = crearFake((op) => (op.op === "insert" ? { error: { message: "insert roto" } } : { data: [] }));

    await expect(
      escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 1, priceKind: "promocion" }])
    ).rejects.toThrow("insert roto");
  });

  it("lanza si el update devuelve error de base", async () => {
    const { client } = crearFake((op) => {
      if (op.op === "select") return { data: [{ id: "item-1", product_id: P1, origin: "quote" }] };
      return { error: { message: "update roto" } };
    });

    await expect(
      escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 1, priceKind: "promocion" }])
    ).rejects.toThrow("update roto");
  });

  it("si el insert choca con el índice único (el asesor lo agregó en medio), actualiza ese renglón", async () => {
    const { client, operaciones } = crearFake((op) => {
      if (op.op === "select") return { data: [] };
      if (op.op === "insert") return { error: { message: "duplicate key", code: "23505" } };
      return { data: [{ id: "item-9" }] };
    });

    await escribirCarritoDeSeba(client, CONV, [{ productId: P1, cantidad: 2, priceKind: "estandar" }]);

    const updates = operaciones.filter((o) => o.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ quantity: 2, price_kind: "estandar" });
  });
});
