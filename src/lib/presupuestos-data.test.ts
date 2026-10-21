import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import {
  borrarMisPresupuestos,
  borrarPresupuesto,
  fetchPresupuestos,
  guardarPresupuesto,
  PRESUPUESTO_AJENO_MESSAGE,
  PRESUPUESTO_NO_ENCONTRADO_MESSAGE,
  type GuardarPresupuestoInput,
} from "@/lib/presupuestos-data";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3). Un fake de Supabase que
// REGISTRA operador + columna + valor (y el argumento real de order/limit/rpc),
// no solo "se llamó a delete": un fake que se traga el operador dejaría pasar
// un `.neq` donde va un `.eq` (ver CLAUDE.md, trampa del fake de Supabase).

interface Llamada {
  op: string;
  args: unknown[];
}

interface Resultado {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

function crearFake(resultados: { tabla?: Resultado; rpc?: Resultado } = {}) {
  const llamadas: Llamada[] = [];
  let tablaUsada: string | null = null;
  let rpcUsada: { nombre: string; args: unknown } | null = null;

  function builder(resultado: Resultado) {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "neq", "order", "limit", "delete", "in"]) {
      b[op] = (...args: unknown[]) => {
        llamadas.push({ op, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: resultado.data ?? null, error: resultado.error ?? null }).then(resolve, reject);
    return b;
  }

  const supabase = {
    from(tabla: string) {
      tablaUsada = tabla;
      return builder(resultados.tabla ?? {});
    },
    rpc(nombre: string, args: unknown) {
      rpcUsada = { nombre, args };
      const r = resultados.rpc ?? {};
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };

  return {
    supabase: supabase as unknown as SupabaseClient,
    llamadas,
    tabla: () => tablaUsada,
    rpc: () => rpcUsada,
  };
}

function filaProducto(id: string) {
  return {
    id,
    name: `Producto ${id}`,
    brand: null,
    price: "25.5",
    currency: "USD",
    stock_quantity: 4,
    description: null,
    is_active: true,
    updated_at: "2026-10-21T10:00:00.000Z",
    weight_kg: "1.250",
    tarifa_envio_usd: "2.5",
    saint_code: "S-1",
    saint_added_at: null,
    saint_removed_at: null,
    product_compatibility: [],
  };
}

function filaPresupuesto(over: Record<string, unknown> = {}) {
  return {
    id: "pres-1",
    cliente_nombre: "María",
    cliente_apellido: "Pérez",
    contact_id: "contacto-1",
    conversation_id: null,
    origen: "inventario",
    nota: "Para el sábado",
    total_cotizado_usd: "84.90",
    created_by: "agente-1",
    created_at: "2026-10-21T10:00:00.000Z",
    updated_at: "2026-10-21T11:00:00.000Z",
    creador: { full_name: "Ana Gómez", display_name: "Ana" },
    items: [
      {
        id: "i-b",
        product_id: "p2",
        quantity: 2,
        price_kind: "estandar",
        precio_cotizado_usd: "28.00",
        created_at: "2026-10-21T10:00:00.000Z",
        product: filaProducto("p2"),
      },
      {
        id: "i-a",
        product_id: "p1",
        quantity: 1,
        price_kind: "promocion",
        precio_cotizado_usd: null,
        created_at: "2026-10-21T10:00:00.000Z",
        product: filaProducto("p1"),
      },
      {
        id: "i-0",
        product_id: "p0",
        quantity: 3,
        price_kind: "raro",
        precio_cotizado_usd: "1",
        created_at: "2026-10-21T09:00:00.000Z",
        product: filaProducto("p0"),
      },
    ],
    ...over,
  };
}

describe("fetchPresupuestos", () => {
  it("lee presupuestos con renglones, producto y autor; más reciente primero, tope 200", async () => {
    const fake = crearFake({ tabla: { data: [] } });
    await fetchPresupuestos(fake.supabase);

    expect(fake.tabla()).toBe("presupuestos");
    const seleccion = String(fake.llamadas.find((l) => l.op === "select")?.args[0]);
    expect(seleccion).toContain("items:presupuesto_items(");
    expect(seleccion).toContain("precio_cotizado_usd");
    expect(seleccion).toContain("product:products(");
    expect(seleccion).toContain("presupuestos_created_by_fkey");
    expect(seleccion).toContain("full_name");
    expect(fake.llamadas.find((l) => l.op === "order")?.args).toEqual(["updated_at", { ascending: false }]);
    expect(fake.llamadas.find((l) => l.op === "limit")?.args).toEqual([200]);
    expect(fake.llamadas.some((l) => l.op === "eq")).toBe(false);
  });

  it("con contactId filtra por contact_id con .eq", async () => {
    const fake = crearFake({ tabla: { data: [] } });
    await fetchPresupuestos(fake.supabase, { contactId: "contacto-9" });
    expect(fake.llamadas.filter((l) => l.op === "eq")).toEqual([{ op: "eq", args: ["contact_id", "contacto-9"] }]);
  });

  it("mapea a camelCase, convierte los numeric a Number y ordena los renglones por created_at con id de desempate", async () => {
    const fake = crearFake({ tabla: { data: [filaPresupuesto()] } });
    const [p] = await fetchPresupuestos(fake.supabase);

    expect(p).toMatchObject({
      id: "pres-1",
      clienteNombre: "María",
      clienteApellido: "Pérez",
      contactId: "contacto-1",
      conversationId: null,
      origen: "inventario",
      nota: "Para el sábado",
      totalCotizadoUsd: 84.9,
      createdBy: "agente-1",
      creadoPorNombre: "Ana Gómez",
      createdAt: "2026-10-21T10:00:00.000Z",
      updatedAt: "2026-10-21T11:00:00.000Z",
    });
    expect(p.items.map((i) => i.id)).toEqual(["i-0", "i-a", "i-b"]);
    const b = p.items[2];
    expect(b.precioCotizadoUsd).toBe(28);
    expect(typeof b.precioCotizadoUsd).toBe("number");
    expect(b.quantity).toBe(2);
    expect(b.priceKind).toBe("estandar");
    expect(b.productId).toBe("p2");
    expect(b.product.price).toBe(25.5);
    expect(b.product.shippingFeeUsd).toBe(2.5);
    expect(b.product.weightKg).toBe(1.25);
    expect(p.items[1].precioCotizadoUsd).toBeNull();
  });

  it("un price_kind desconocido se lee como promoción (solo «estandar» cobra el envío)", async () => {
    const fake = crearFake({ tabla: { data: [filaPresupuesto()] } });
    const [p] = await fetchPresupuestos(fake.supabase);
    expect(p.items[0].priceKind).toBe("promocion");
  });

  it("sin autor o sin nombre completo usa el display_name, y si no hay creador, null", async () => {
    const fake = crearFake({
      tabla: {
        data: [
          filaPresupuesto({ id: "a", creador: { full_name: null, display_name: "Ana" } }),
          filaPresupuesto({ id: "b", creador: null, created_by: null, total_cotizado_usd: null }),
        ],
      },
    });
    const lista = await fetchPresupuestos(fake.supabase);
    expect(lista[0].creadoPorNombre).toBe("Ana");
    expect(lista[1].creadoPorNombre).toBeNull();
    expect(lista[1].createdBy).toBeNull();
    expect(lista[1].totalCotizadoUsd).toBeNull();
  });

  it("un origen desconocido cae a «inventario»", async () => {
    const fake = crearFake({ tabla: { data: [filaPresupuesto({ origen: "otro" })] } });
    expect((await fetchPresupuestos(fake.supabase))[0].origen).toBe("inventario");
  });

  it("si la base responde con error, lanza", async () => {
    const fake = crearFake({ tabla: { error: { message: "boom" } } });
    await expect(fetchPresupuestos(fake.supabase)).rejects.toMatchObject({ message: "boom" });
  });

  it("sin datos devuelve una lista vacía", async () => {
    const fake = crearFake({ tabla: { data: null } });
    expect(await fetchPresupuestos(fake.supabase)).toEqual([]);
  });
});

describe("guardarPresupuesto", () => {
  const input: GuardarPresupuestoInput = {
    id: null,
    clienteNombre: "  María ",
    clienteApellido: "Pérez",
    contactId: "contacto-1",
    conversationId: "conv-1",
    origen: "chat",
    nota: "Para el sábado",
    items: [{ product_id: "p1", quantity: 2, price_kind: "promocion", precio_cotizado_usd: 20 }],
  };

  it("llama a la RPC guardar_presupuesto con los ocho argumentos y devuelve el id", async () => {
    const fake = crearFake({ rpc: { data: "pres-nuevo" } });
    const id = await guardarPresupuesto(fake.supabase, input);

    expect(id).toBe("pres-nuevo");
    expect(fake.rpc()).toEqual({
      nombre: "guardar_presupuesto",
      args: {
        p_id: null,
        p_cliente_nombre: "María",
        p_cliente_apellido: "Pérez",
        p_contact_id: "contacto-1",
        p_conversation_id: "conv-1",
        p_origen: "chat",
        p_nota: "Para el sábado",
        p_items: input.items,
      },
    });
  });

  it("manda el id al reemplazar un presupuesto existente", async () => {
    const fake = crearFake({ rpc: { data: "pres-7" } });
    await guardarPresupuesto(fake.supabase, { ...input, id: "pres-7" });
    expect((fake.rpc()?.args as { p_id: string }).p_id).toBe("pres-7");
  });

  it("valida antes de llamar: nombre vacío lanza el primer mensaje y no toca la base", async () => {
    const fake = crearFake();
    await expect(guardarPresupuesto(fake.supabase, { ...input, clienteNombre: "  " })).rejects.toThrow(
      "Escribe el nombre del cliente.",
    );
    await expect(guardarPresupuesto(fake.supabase, { ...input, clienteApellido: "" })).rejects.toThrow(
      "Escribe el apellido del cliente.",
    );
    await expect(guardarPresupuesto(fake.supabase, { ...input, nota: "n".repeat(281) })).rejects.toThrow(
      "La nota admite hasta 280 caracteres.",
    );
    expect(fake.rpc()).toBeNull();
  });

  it("exige al menos un renglón", async () => {
    const fake = crearFake();
    await expect(guardarPresupuesto(fake.supabase, { ...input, items: [] })).rejects.toThrow(
      "El presupuesto no tiene artículos.",
    );
    expect(fake.rpc()).toBeNull();
  });

  it("el error 42501 (presupuesto ajeno) se traduce al mensaje propio", async () => {
    const fake = crearFake({ rpc: { error: { code: "42501", message: "presupuesto_ajeno_o_inexistente" } } });
    await expect(guardarPresupuesto(fake.supabase, { ...input, id: "pres-7" })).rejects.toThrow(
      PRESUPUESTO_AJENO_MESSAGE,
    );
  });

  it("cualquier otro error de la RPC se relanza tal cual", async () => {
    const error = { code: "23503", message: "violates foreign key" };
    const fake = crearFake({ rpc: { error } });
    await expect(guardarPresupuesto(fake.supabase, input)).rejects.toBe(error);
  });

  it("una nota vacía o solo espacios viaja como null", async () => {
    const fake = crearFake({ rpc: { data: "x" } });
    await guardarPresupuesto(fake.supabase, { ...input, nota: "   " });
    expect((fake.rpc()?.args as { p_nota: string | null }).p_nota).toBeNull();
  });
});

describe("borrarPresupuesto", () => {
  it("borra por id y pide las filas afectadas", async () => {
    const fake = crearFake({ tabla: { data: [{ id: "pres-1" }] } });
    await borrarPresupuesto(fake.supabase, "pres-1");

    expect(fake.tabla()).toBe("presupuestos");
    expect(fake.llamadas.map((l) => l.op)).toEqual(["delete", "eq", "select"]);
    expect(fake.llamadas[1].args).toEqual(["id", "pres-1"]);
    expect(fake.llamadas[2].args).toEqual(["id"]);
  });

  it("con 0 filas (la RLS lo ignoró o ya no existe) lanza el mensaje propio", async () => {
    const fake = crearFake({ tabla: { data: [] } });
    const intento = borrarPresupuesto(fake.supabase, "pres-1");
    await expect(intento).rejects.toBeInstanceOf(ConfigWriteDeniedError);
    await expect(intento).rejects.toThrow(PRESUPUESTO_NO_ENCONTRADO_MESSAGE);
  });

  it("un error de la base se relanza", async () => {
    const fake = crearFake({ tabla: { error: { message: "boom" } } });
    await expect(borrarPresupuesto(fake.supabase, "pres-1")).rejects.toMatchObject({ message: "boom" });
  });
});

describe("borrarMisPresupuestos", () => {
  it("borra solo los del asesor: .eq(created_by, agentId), nunca otro operador ni otra columna", async () => {
    const fake = crearFake({ tabla: { data: [{ id: "a" }, { id: "b" }, { id: "c" }] } });
    const borrados = await borrarMisPresupuestos(fake.supabase, "agente-1");

    expect(borrados).toBe(3);
    expect(fake.tabla()).toBe("presupuestos");
    expect(fake.llamadas.map((l) => l.op)).toEqual(["delete", "eq", "select"]);
    expect(fake.llamadas[1]).toEqual({ op: "eq", args: ["created_by", "agente-1"] });
    expect(fake.llamadas.some((l) => l.op === "neq")).toBe(false);
  });

  it("cero filas es válido (no tenía ninguno): devuelve 0 y no lanza", async () => {
    const fake = crearFake({ tabla: { data: [] } });
    expect(await borrarMisPresupuestos(fake.supabase, "agente-1")).toBe(0);
    const sinDatos = crearFake({ tabla: { data: null } });
    expect(await borrarMisPresupuestos(sinDatos.supabase, "agente-1")).toBe(0);
  });

  it("un error de la base se relanza", async () => {
    const fake = crearFake({ tabla: { error: { message: "boom" } } });
    await expect(borrarMisPresupuestos(fake.supabase, "agente-1")).rejects.toMatchObject({ message: "boom" });
  });
});
