import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInvoice, fetchInvoicesForSale, fetchOrderItems } from "@/lib/invoices-data";

// ---------------------------------------------------------------------------
// Fake mínimo del query builder encadenable de PostgREST que usan las tres
// consultas de este módulo: `.select().eq().order()`, `.select().eq().maybeSingle()`
// y `.select().eq()` sin terminar en un `await` explícito (order_items).
// ---------------------------------------------------------------------------

interface FakeTable {
  data: unknown[];
  error?: { message: string };
}

function createFakeSupabase(tables: Record<string, FakeTable>) {
  const calls: { table: string; eq: [string, unknown][]; order?: string; maybeSingle?: boolean }[] = [];

  function builder(table: string) {
    const eqCalls: [string, unknown][] = [];
    const record = { table, eq: eqCalls, order: undefined as string | undefined, maybeSingle: false };

    function resolveRows() {
      const fake = tables[table];
      if (!fake) throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      return fake;
    }

    const chain = {
      eq(column: string, value: unknown) {
        eqCalls.push([column, value]);
        return chain;
      },
      order(column: string) {
        record.order = column;
        calls.push(record);
        const fake = resolveRows();
        return Promise.resolve({ data: fake.data, error: fake.error ?? null });
      },
      maybeSingle() {
        record.maybeSingle = true;
        calls.push(record);
        const fake = resolveRows();
        const [first] = fake.data;
        return Promise.resolve({ data: fake.error ? null : (first ?? null), error: fake.error ?? null });
      },
      // `fetchOrderItems` no encadena `.order()` ni `.maybeSingle()`: el
      // `.eq()` mismo es un thenable (así funciona el builder real de
      // supabase-js), así que el chain se resuelve también como promesa.
      then(onFulfilled: (value: { data: unknown[]; error: unknown }) => void) {
        calls.push(record);
        const fake = resolveRows();
        return Promise.resolve({ data: fake.data, error: fake.error ?? null }).then(onFulfilled);
      },
    };

    return chain;
  }

  const client = {
    from(table: string) {
      return { select: () => builder(table) };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchInvoicesForSale", () => {
  it("filtra por conversación y ordena de la más reciente a la más vieja", async () => {
    const { client, calls } = createFakeSupabase({
      invoices: {
        data: [
          {
            id: "inv-2",
            number: 2,
            conversation_id: "conv-1",
            order_id: "order-2",
            contact_id: "contact-1",
            customer: { displayName: "Cliente", phoneNumber: "+58", cedulaType: null, cedulaNumber: null, state: null, city: null, address: null },
            items: [],
            subtotal: "10.00",
            tax_rate: "0.0000",
            tax_amount: "0.00",
            total: "10.00",
            currency: "USD",
            bcv_rate: "40.5000",
            status: "draft",
            issued_at: null,
            voided_at: null,
            notes: null,
            created_at: "2026-09-08T12:00:00.000Z",
            updated_at: "2026-09-08T12:00:00.000Z",
            issued_by: null,
          },
        ],
      },
    });

    const invoices = await fetchInvoicesForSale(client, "conv-1");

    expect(calls[0].eq).toEqual([["conversation_id", "conv-1"]]);
    expect(calls[0].order).toBe("created_at");
    expect(invoices).toHaveLength(1);
    // Los numeric de Postgres llegan como string por PostgREST: se convierten a number.
    expect(invoices[0].subtotal).toBe(10);
    expect(invoices[0].bcvRate).toBe(40.5);
    expect(invoices[0].taxRate).toBe(0);
  });
});

describe("fetchInvoice", () => {
  it("devuelve null cuando no existe, sin lanzar", async () => {
    const { client } = createFakeSupabase({ invoices: { data: [] } });

    const invoice = await fetchInvoice(client, "inv-missing");

    expect(invoice).toBeNull();
  });

  it("mapea al agente que emitió cuando la factura viene emitida", async () => {
    const { client } = createFakeSupabase({
      invoices: {
        data: [
          {
            id: "inv-1",
            number: 1,
            conversation_id: "conv-1",
            order_id: "order-1",
            contact_id: "contact-1",
            customer: { displayName: "Cliente", phoneNumber: "+58", cedulaType: null, cedulaNumber: null, state: null, city: null, address: null },
            items: [],
            subtotal: 0,
            tax_rate: 0,
            tax_amount: 0,
            total: 0,
            currency: "USD",
            bcv_rate: null,
            status: "issued",
            issued_at: "2026-09-08T12:00:00.000Z",
            voided_at: null,
            notes: null,
            created_at: "2026-09-08T11:00:00.000Z",
            updated_at: "2026-09-08T12:00:00.000Z",
            issued_by: { id: "agent-1", display_name: "José Riera" },
          },
        ],
      },
    });

    const invoice = await fetchInvoice(client, "inv-1");

    expect(invoice?.issuedBy).toEqual({ id: "agent-1", displayName: "José Riera" });
    expect(invoice?.bcvRate).toBeNull();
  });
});

describe("fetchOrderItems", () => {
  it("filtra por orden y convierte el precio unitario a number", async () => {
    const { client, calls } = createFakeSupabase({
      order_items: {
        data: [
          { description: "Carburador PZ27", quantity: 1, unit_price: "18.00" },
          { description: "Kit de arrastre", quantity: 2, unit_price: "32.50" },
        ],
      },
    });

    const items = await fetchOrderItems(client, "order-1");

    expect(calls[0].eq).toEqual([["order_id", "order-1"]]);
    expect(items).toEqual([
      { description: "Carburador PZ27", quantity: 1, unitPrice: 18 },
      { description: "Kit de arrastre", quantity: 2, unitPrice: 32.5 },
    ]);
  });
});
