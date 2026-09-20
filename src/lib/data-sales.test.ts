import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSales } from "@/lib/data";

// ---------------------------------------------------------------------------
// T3-b (plan "El resguardo antes del push", 20/9/2026). `mapSale` (data.ts,
// privada) no tenía ningún test que la ejercitara directamente ni a través de
// `fetchSales`: la sección Ventas confiaba en `sales-day.test.ts` (que solo
// prueba el corte de día, no el mapeo) y en los tests de componentes de
// `src/components/sales/`, que mockean `@/lib/data` entero y nunca ejecutan
// el mapeo real. `saintInvoiceNumber` es el campo con más riesgo de la fila
// (D9, plan "Nada sin leer…", 18/9/2026): sale de `order.saint_invoice_number`,
// y una orden inexistente (`order: null`, venta sin `orders` asociada, caso
// legítimo para ventas viejas) tiene que mapear a `null`, no lanzar ni
// confundirse con el correlativo interno `invoices.number`.
// ---------------------------------------------------------------------------

interface FakeRawSale {
  id: string;
  deal_status: string;
  deal_closed_at: string | null;
  deal_payment_proof_url: string | null;
  deal_verified: boolean;
  deal_verified_at: string | null;
  deal_payment_method: string | null;
  created_at: string;
  order: { total_amount: number; currency: string; saint_invoice_number: string | null } | null;
  contact: {
    id: string;
    phone_number: string;
    display_name: string | null;
    profile_name: string | null;
    avatar_url: string | null;
    cedula_type: string | null;
    cedula_number: string | null;
    state: string | null;
    city: string | null;
    address: string | null;
    contact_tags: null;
  };
  deal_verified_by: { id: string; display_name: string } | null;
  deal_closed_by: { id: string; display_name: string } | null;
}

function contactRow(id: string): FakeRawSale["contact"] {
  return {
    id,
    phone_number: "+58412000000",
    display_name: "Cliente Demo",
    profile_name: null,
    avatar_url: null,
    cedula_type: null,
    cedula_number: null,
    state: null,
    city: null,
    address: null,
    contact_tags: null,
  };
}

function saleRow(overrides: Partial<FakeRawSale> = {}): FakeRawSale {
  return {
    id: "sale-1",
    deal_status: "won",
    deal_closed_at: "2026-09-19T12:00:00Z",
    deal_payment_proof_url: null,
    deal_verified: false,
    deal_verified_at: null,
    deal_payment_method: "pago_movil",
    created_at: "2026-09-19T10:00:00Z",
    order: { total_amount: 25, currency: "USD", saint_invoice_number: "00123" },
    contact: contactRow("c-1"),
    deal_verified_by: null,
    deal_closed_by: null,
    ...overrides,
  };
}

function createFakeSupabase(pages: FakeRawSale[][]) {
  let call = 0;
  const selects: string[] = [];
  const client = {
    from(table: string) {
      if (table !== "conversations") throw new Error(`tabla inesperada: ${table}`);
      return {
        select(columns: string) {
          selects.push(columns);
          return {
            in() {
              return {
                order() {
                  return {
                    range() {
                      const page = pages[call] ?? [];
                      call += 1;
                      return Promise.resolve({ data: page, error: null });
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

  return { client: client as unknown as SupabaseClient, selects };
}

describe("fetchSales — mapSale", () => {
  it("con orden asociada, trae el número de factura Saint tal cual", async () => {
    const { client } = createFakeSupabase([[saleRow()], []]);

    const [sale] = await fetchSales(client);

    expect(sale.saintInvoiceNumber).toBe("00123");
    expect(sale.dealAmount).toBe(25);
    expect(sale.dealCurrency).toBe("USD");
  });

  it("con order: null (venta sin orden asociada, previa a D9), saintInvoiceNumber/dealAmount/dealCurrency quedan en null, no lanza", async () => {
    const { client } = createFakeSupabase([[saleRow({ id: "sale-vieja", order: null })], []]);

    const [sale] = await fetchSales(client);

    expect(sale.saintInvoiceNumber).toBeNull();
    expect(sale.dealAmount).toBeNull();
    expect(sale.dealCurrency).toBeNull();
  });

  it("con orden asociada pero SIN número de factura Saint (venta previa a D9), saintInvoiceNumber es null", async () => {
    const { client } = createFakeSupabase([
      [saleRow({ order: { total_amount: 10, currency: "USD", saint_invoice_number: null } })],
      [],
    ]);

    const [sale] = await fetchSales(client);

    expect(sale.saintInvoiceNumber).toBeNull();
    expect(sale.dealAmount).toBe(10);
  });

  // T3-b: la mutación "quitar saint_invoice_number del select" no la nota
  // ningún test de MAPEO —el fake de arriba ignora las columnas pedidas y
  // siempre devuelve la fila entera—, así que hace falta afirmar el texto
  // real del `.select(...)` que arma `fetchSales` (`SALE_SELECT`, data.ts).
  it("el select de la consulta pide saint_invoice_number dentro de la relación order", async () => {
    const { client, selects } = createFakeSupabase([[saleRow()], []]);

    await fetchSales(client);

    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("saint_invoice_number");
  });
});
