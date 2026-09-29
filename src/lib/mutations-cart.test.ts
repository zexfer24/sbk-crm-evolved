import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationQuote } from "@/lib/types";
import { addQuotesToCart, addToCart, removeFromCart, setCartQuantity } from "@/lib/mutations";

// ---------------------------------------------------------------------------
// T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): escrituras del carrito persistente de la
// conversación (`conversation_cart_items`).
//
// El fake de acá NO es un espía mudo: guarda filas en memoria, HONRA los
// `.eq(...)` de cada consulta y el `unique (conversation_id, product_id)`.
// Es lo que hace que estos tests fijen la parte delicada de `addToCart` —el
// "upsert que SUMA", con concurrencia optimista— y no solo que se llame a la
// tabla: un `.eq("quantity", …)` quitado, o una suma que se convierte en
// "reemplazar", pone rojo un test (CLAUDE.md: "un fake de Supabase nuevo
// registra operador + columna + valor").
// ---------------------------------------------------------------------------

interface CartRow {
  id: string;
  conversation_id: string;
  product_id: string;
  quantity: number;
  origin: string;
  quote_id: string | null;
}

interface Hooks {
  /** Corre una vez, justo antes de ejecutar el primer UPDATE (simula a otro asesor). */
  beforeFirstUpdate?: (rows: CartRow[]) => void;
  /** Corre una vez, justo antes de ejecutar el primer INSERT. */
  beforeFirstInsert?: (rows: CartRow[]) => void;
  /** Hace que toda escritura devuelva este error (la RLS ignora un UPDATE/DELETE: 0 filas). */
  ignoreWrites?: boolean;
  failDeleteWith?: { message: string };
}

function createCartFake(initial: CartRow[] = [], hooks: Hooks = {}) {
  const rows: CartRow[] = initial.map((r) => ({ ...r }));
  const log: { op: string; payload?: unknown; filters?: [string, unknown][]; options?: unknown }[] = [];
  let nextId = 1;
  let updateHookFired = false;
  let insertHookFired = false;

  function insertRow(payload: Omit<CartRow, "id"> & { id?: string }) {
    const dup = rows.some(
      (r) => r.conversation_id === payload.conversation_id && r.product_id === payload.product_id
    );
    if (dup) return { ok: false as const };
    const row: CartRow = {
      id: payload.id ?? `cart-new-${nextId++}`,
      conversation_id: payload.conversation_id,
      product_id: payload.product_id,
      quantity: payload.quantity,
      origin: payload.origin,
      quote_id: payload.quote_id ?? null,
    };
    rows.push(row);
    return { ok: true as const, row };
  }

  function query(op: "select" | "update" | "insert" | "upsert" | "delete", payload?: unknown, options?: unknown) {
    const filters: [string, unknown][] = [];
    let returning = false;
    let single = false;

    const builder = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      select() {
        returning = true;
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
        try {
          resolve(execute());
        } catch (error) {
          reject(error);
        }
      },
    };

    function matching() {
      return rows.filter((r) => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v));
    }

    function execute(): { data: unknown; error: unknown } {
      log.push({ op, payload, filters: [...filters], options });

      if (op === "select") {
        const found = matching();
        return { data: single ? (found[0] ?? null) : found, error: null };
      }

      if (op === "update") {
        if (!updateHookFired) {
          updateHookFired = true;
          hooks.beforeFirstUpdate?.(rows);
        }
        if (hooks.ignoreWrites) return { data: returning ? [] : null, error: null };
        const found = matching();
        for (const r of found) Object.assign(r, payload);
        return { data: returning ? found.map((r) => ({ id: r.id })) : null, error: null };
      }

      if (op === "delete") {
        if (hooks.failDeleteWith) return { data: null, error: hooks.failDeleteWith };
        if (hooks.ignoreWrites) return { data: returning ? [] : null, error: null };
        const found = matching();
        for (const r of found) rows.splice(rows.indexOf(r), 1);
        return { data: returning ? found.map((r) => ({ id: r.id })) : null, error: null };
      }

      if (op === "insert") {
        if (!insertHookFired) {
          insertHookFired = true;
          hooks.beforeFirstInsert?.(rows);
        }
        const result = insertRow(payload as Omit<CartRow, "id">);
        if (!result.ok) return { data: null, error: { code: "23505", message: "duplicate key" } };
        return { data: returning ? [{ id: result.row.id }] : null, error: null };
      }

      // upsert: con ignoreDuplicates salta los que ya están (on conflict do nothing).
      const inserted: CartRow[] = [];
      for (const item of payload as Omit<CartRow, "id">[]) {
        const result = insertRow(item);
        if (result.ok) inserted.push(result.row);
      }
      return { data: returning ? inserted.map((r) => ({ id: r.id })) : null, error: null };
    }

    return builder;
  }

  const client = {
    from(table: string) {
      if (table !== "conversation_cart_items") throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
      return {
        select: () => query("select"),
        update: (payload: unknown) => query("update", payload),
        insert: (payload: unknown) => query("insert", payload),
        upsert: (payload: unknown, options: unknown) => query("upsert", payload, options),
        delete: () => query("delete"),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, rows, log };
}

const ROW: CartRow = {
  id: "cart-1",
  conversation_id: "conv-1",
  product_id: "prod-1",
  quantity: 2,
  origin: "inventory",
  quote_id: null,
};

describe("addToCart — un repetido SUMA unidades, nunca duplica el renglón", () => {
  it("un producto nuevo entra con la cantidad pedida y su procedencia", async () => {
    const { client, rows } = createCartFake();

    await addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 3, origin: "inventory" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversation_id: "conv-1",
      product_id: "prod-1",
      quantity: 3,
      origin: "inventory",
      quote_id: null,
    });
  });

  it("sin cantidad, entra de a una unidad", async () => {
    const { client, rows } = createCartFake();

    await addToCart(client, { conversationId: "conv-1", productId: "prod-1", origin: "inventory" });

    expect(rows[0].quantity).toBe(1);
  });

  it("el mismo producto ya en el carrito SUMA las unidades al mismo renglón", async () => {
    const { client, rows } = createCartFake([ROW]);

    await addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 3, origin: "inventory" });

    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5); // 2 + 3, no 3
  });

  it("agregar desde una cotización guarda el vínculo con ella", async () => {
    const { client, rows } = createCartFake();

    await addToCart(client, {
      conversationId: "conv-1",
      productId: "prod-1",
      origin: "quote",
      quoteId: "q-1",
    });

    expect(rows[0]).toMatchObject({ origin: "quote", quote_id: "q-1" });
  });

  it("si otro asesor cambió la cantidad entre la lectura y la escritura, reintenta y no pierde unidades", async () => {
    const { client, rows } = createCartFake([ROW], {
      // Entre nuestra lectura (quantity = 2) y nuestro UPDATE, otro asesor sube a 5.
      beforeFirstUpdate: (all) => {
        all[0].quantity = 5;
      },
    });

    await addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 1, origin: "inventory" });

    expect(rows[0].quantity).toBe(6); // 5 (del otro asesor) + 1 (nuestro)
  });

  it("si otro asesor creó el renglón justo antes de nuestro INSERT, reintenta y suma", async () => {
    const { client, rows } = createCartFake([], {
      beforeFirstInsert: (all) => {
        all.push({ ...ROW, quantity: 4 });
      },
    });

    await addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 1, origin: "inventory" });

    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);
  });

  it("si la base ignora la escritura (0 filas) no da el guardado por bueno", async () => {
    const { client } = createCartFake([ROW], { ignoreWrites: true });

    await expect(
      addToCart(client, { conversationId: "conv-1", productId: "prod-1", origin: "inventory" })
    ).rejects.toThrow(/carrito/i);
  });

  it("rechaza una cantidad que no sea un entero positivo, sin tocar la base", async () => {
    const { client, log } = createCartFake();

    await expect(
      addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 0, origin: "inventory" })
    ).rejects.toThrow(/cantidad/i);
    await expect(
      addToCart(client, { conversationId: "conv-1", productId: "prod-1", quantity: 1.5, origin: "inventory" })
    ).rejects.toThrow(/cantidad/i);
    expect(log).toHaveLength(0);
  });
});

describe("setCartQuantity y removeFromCart — verifican las filas afectadas", () => {
  it("fija la cantidad del renglón pedido y de ningún otro", async () => {
    const { client, rows } = createCartFake([ROW, { ...ROW, id: "cart-2", product_id: "prod-2", quantity: 1 }]);

    await setCartQuantity(client, "cart-1", 7);

    expect(rows.find((r) => r.id === "cart-1")?.quantity).toBe(7);
    expect(rows.find((r) => r.id === "cart-2")?.quantity).toBe(1);
  });

  it("redondea y no baja de una unidad", async () => {
    const { client } = createCartFake([ROW]);

    await expect(setCartQuantity(client, "cart-1", 0)).rejects.toThrow(/cantidad/i);
    await expect(setCartQuantity(client, "cart-1", -2)).rejects.toThrow(/cantidad/i);
  });

  it("si el renglón ya no existe (otro asesor lo quitó) lanza en vez de dar el guardado por bueno", async () => {
    const { client } = createCartFake([]);

    await expect(setCartQuantity(client, "cart-1", 3)).rejects.toThrow(/ya no está/i);
  });

  it("quitar borra solo el renglón pedido", async () => {
    const { client, rows } = createCartFake([ROW, { ...ROW, id: "cart-2", product_id: "prod-2" }]);

    await removeFromCart(client, "cart-1");

    expect(rows.map((r) => r.id)).toEqual(["cart-2"]);
  });

  it("quitar un renglón que ya no está lanza en vez de dar el borrado por bueno", async () => {
    const { client } = createCartFake([]);

    await expect(removeFromCart(client, "cart-1")).rejects.toThrow(/ya no está/i);
  });

  it("si la base ignora el borrado (0 filas) lanza", async () => {
    const { client } = createCartFake([ROW], { ignoreWrites: true });

    await expect(removeFromCart(client, "cart-1")).rejects.toThrow();
  });
});

function quote(over: Partial<ConversationQuote> = {}): ConversationQuote {
  return {
    id: "q-1",
    productId: "prod-1",
    productName: "Carburador PZ27",
    priceUsd: 18,
    priceBs: 720,
    bcvRate: 40,
    quotedAt: "2026-09-29T12:00:00.000Z",
    ...over,
  };
}

describe("addQuotesToCart — «Agregar cotizaciones de Seba»", () => {
  it("agrega un renglón por producto cotizado, con el vínculo a su cotización más reciente", async () => {
    const { client, rows } = createCartFake();

    // La lista viene de la más reciente a la más vieja: la repetida vieja se ignora.
    const added = await addQuotesToCart(client, "conv-1", [
      quote({ id: "q-nueva", productId: "prod-1", priceUsd: 20 }),
      quote({ id: "q-2", productId: "prod-2", productName: "Kit de arrastre" }),
      quote({ id: "q-vieja", productId: "prod-1", priceUsd: 18 }),
    ]);

    expect(added).toBe(2);
    expect(rows.map((r) => [r.product_id, r.quote_id, r.origin, r.quantity])).toEqual([
      ["prod-1", "q-nueva", "quote", 1],
      ["prod-2", "q-2", "quote", 1],
    ]);
  });

  it("no suma unidades a lo que ya estaba en el carrito: dos toques no duplican la cantidad", async () => {
    const { client, rows } = createCartFake([ROW]);

    const added = await addQuotesToCart(client, "conv-1", [quote({ productId: "prod-1" })]);

    expect(added).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
  });

  it("salta las cotizaciones de un producto que ya no existe (productId null)", async () => {
    const { client, rows } = createCartFake();

    const added = await addQuotesToCart(client, "conv-1", [quote({ productId: null })]);

    expect(added).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("sin cotizaciones no toca la base", async () => {
    const { client, log } = createCartFake();

    expect(await addQuotesToCart(client, "conv-1", [])).toBe(0);
    expect(log).toHaveLength(0);
  });

  it("pide a la base ignorar duplicados en vez de fallar entero si otro asesor ya agregó uno", async () => {
    const { client, log } = createCartFake();

    await addQuotesToCart(client, "conv-1", [quote()]);

    const upsert = log.find((l) => l.op === "upsert");
    expect(upsert?.options).toMatchObject({ onConflict: "conversation_id,product_id", ignoreDuplicates: true });
  });
});
