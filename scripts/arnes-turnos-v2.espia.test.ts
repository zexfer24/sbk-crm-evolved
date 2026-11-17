import { describe, expect, it } from "vitest";
import {
  EscrituraProhibidaError,
  RPC_DE_SOLO_LECTURA,
  conTasaFija,
  crearEspiaDeSoloLectura,
} from "./arnes-turnos-v2.espia";

/** Un eslabón de la cadena de consultas, sin tipos: lo que importa aquí es qué llega a la base. */
type Encadenable = { [metodo: string]: (...args: unknown[]) => Encadenable };

/**
 * Un cliente falso con la forma que importa: `from(tabla)` devuelve un constructor encadenable que es
 * además «thenable» (como el de PostgREST), `rpc` devuelve una promesa, y `storage.from` un objeto con
 * lecturas y escrituras. Cada llamada real queda anotada: así se ve qué LLEGÓ a la base.
 */
function clienteFalso() {
  const llamadas: string[] = [];
  const constructor = (tabla: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => b,
      insert: () => (llamadas.push(`insert ${tabla}`), b),
      update: () => (llamadas.push(`update ${tabla}`), b),
      upsert: () => (llamadas.push(`upsert ${tabla}`), b),
      delete: () => (llamadas.push(`delete ${tabla}`), b),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ tabla }], error: null }).then(ok),
    };
    return b;
  };
  return {
    llamadas,
    from: (tabla: string) => {
      llamadas.push(`from ${tabla}`);
      return constructor(tabla);
    },
    rpc: (nombre: string) => {
      llamadas.push(`rpc ${nombre}`);
      return Promise.resolve({ data: [], error: null });
    },
    storage: {
      from: () => ({
        upload: () => (llamadas.push("upload"), Promise.resolve()),
        remove: () => (llamadas.push("remove"), Promise.resolve()),
        getPublicUrl: () => ({ data: { publicUrl: "https://x/y.jpg" } }),
      }),
    },
    auth: { marca: "auth" },
  };
}

describe("crearEspiaDeSoloLectura", () => {
  it("deja pasar select (y toda la cadena de lectura) y devuelve lo que devolvió la base", async () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const consulta = espia.cliente.from("products") as unknown as Encadenable;
    const resultado = await consulta.select("id").eq("id", 1).order("id").limit(1);
    expect(resultado).toEqual({ data: [{ tabla: "products" }], error: null });
    expect(falso.llamadas).toEqual(["from products"]);
    expect(espia.intentosDeEscritura()).toBe(0);
  });

  it.each(["insert", "update", "upsert", "delete"] as const)("%s lanza, no llega a la base y se cuenta", (metodo) => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const tabla = espia.cliente.from("messages") as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => tabla[metodo]({ x: 1 })).toThrow(EscrituraProhibidaError);
    expect(falso.llamadas).toEqual(["from messages"]);
    expect(espia.intentosDeEscritura()).toBe(1);
    expect(espia.detalleDeIntentos()).toEqual([`${metodo} en messages`]);
  });

  it("una escritura encadenada después de un select también lanza (el constructor se envuelve en cada eslabón)", () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const cadena = (espia.cliente.from("products") as unknown as Encadenable).select("id");
    expect(() => cadena.update({ price: 1 })).toThrow(EscrituraProhibidaError);
    expect(espia.intentosDeEscritura()).toBe(1);
  });

  it("rpc: deja pasar las de solo lectura y lanza con cualquier otra", async () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    for (const nombre of RPC_DE_SOLO_LECTURA) {
      expect(await (espia.cliente as unknown as { rpc: (n: string) => Promise<unknown> }).rpc(nombre)).toEqual({ data: [], error: null });
    }
    expect(espia.intentosDeEscritura()).toBe(0);

    const rpc = (espia.cliente as unknown as { rpc: (n: string) => unknown }).rpc;
    expect(() => rpc("record_handoff")).toThrow(/rpc record_handoff/);
    expect(() => rpc("ai_turn_lock_acquire")).toThrow(EscrituraProhibidaError);
    expect(falso.llamadas.filter((l) => l.startsWith("rpc ")).sort()).toEqual([...RPC_DE_SOLO_LECTURA].map((n) => `rpc ${n}`).sort());
    expect(espia.intentosDeEscritura()).toBe(2);
  });

  it("la lista de RPC permitidas es exactamente la de la búsqueda del catálogo", () => {
    expect([...RPC_DE_SOLO_LECTURA].sort()).toEqual(["buscar_productos", "corregir_terminos", "diagnosticar_terminos"]);
  });

  it("storage: lanza al subir o borrar y deja pasar las lecturas", () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const bucket = (espia.cliente as unknown as { storage: { from: (b: string) => Record<string, (...a: unknown[]) => unknown> } }).storage.from("product-photos");
    expect(bucket.getPublicUrl("a.jpg")).toEqual({ data: { publicUrl: "https://x/y.jpg" } });
    expect(() => bucket.upload("a.jpg", {})).toThrow(EscrituraProhibidaError);
    expect(() => bucket.remove(["a.jpg"])).toThrow(EscrituraProhibidaError);
    expect(falso.llamadas).toEqual([]);
    expect(espia.intentosDeEscritura()).toBe(2);
  });

  it("lo demás del cliente pasa tal cual", () => {
    const espia = crearEspiaDeSoloLectura(clienteFalso());
    expect((espia.cliente as unknown as { auth: { marca: string } }).auth).toEqual({ marca: "auth" });
  });

  it("un intento sigue contando aunque el código del turno se trague la excepción", () => {
    const espia = crearEspiaDeSoloLectura(clienteFalso());
    try {
      (espia.cliente.from("x") as unknown as { insert: () => void }).insert();
    } catch {
      /* el turno real hace esto: atrapa y sigue */
    }
    expect(espia.intentosDeEscritura()).toBe(1);
  });

  it("acepta una lista de RPC propia", () => {
    const espia = crearEspiaDeSoloLectura(clienteFalso(), { rpcPermitidas: ["otra"] });
    const rpc = (espia.cliente as unknown as { rpc: (n: string) => unknown }).rpc;
    expect(() => rpc("buscar_productos")).toThrow(EscrituraProhibidaError);
    expect(() => rpc("otra")).not.toThrow();
  });
});

describe("conTasaFija", () => {
  const tasa = { usdAVes: 41.5, fecha: "2026-11-16" };
  const AHORA = new Date("2026-11-17T15:00:00.000Z");

  function consulta(cliente: ReturnType<typeof clienteFalso>, columnas: string) {
    const c = cliente as unknown as { from: (t: string) => { select: (c: string) => { order: (...a: unknown[]) => { limit: (n: number) => { maybeSingle: () => Promise<unknown> } } } } };
    return c.from("exchange_rates").select(columnas).order("x").limit(1).maybeSingle();
  }

  it("contesta las dos lecturas de getBcvRate sin tocar la base, con fetched_at de ahora", async () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const cliente = conTasaFija(espia.cliente, tasa, () => AHORA);
    expect(await consulta(cliente as never, "rate_date, usd_to_ves")).toEqual({
      data: { rate_date: "2026-11-16", usd_to_ves: 41.5 },
      error: null,
    });
    expect(await consulta(cliente as never, "fetched_at")).toEqual({ data: { fetched_at: AHORA.toISOString() }, error: null });
    expect(falso.llamadas.filter((l) => l.includes("exchange_rates"))).toEqual(["from exchange_rates", "from exchange_rates"]);
  });

  it("un upsert en exchange_rates (lo que haría getBcvRate tras leer el BCV) lanza y se cuenta", () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const cliente = conTasaFija(espia.cliente, tasa) as unknown as { from: (t: string) => { upsert: (v: unknown) => unknown } };
    expect(() => cliente.from("exchange_rates").upsert({ usd_to_ves: 99 })).toThrow(EscrituraProhibidaError);
    expect(espia.intentosDeEscritura()).toBe(1);
  });

  it("las demás tablas y las rpc siguen pasando por el espía", () => {
    const falso = clienteFalso();
    const espia = crearEspiaDeSoloLectura(falso);
    const cliente = conTasaFija(espia.cliente, tasa) as unknown as {
      from: (t: string) => { insert: (v: unknown) => unknown };
      rpc: (n: string) => unknown;
    };
    expect(() => cliente.from("conversation_quotes").insert({})).toThrow(EscrituraProhibidaError);
    expect(() => cliente.rpc("record_handoff")).toThrow(EscrituraProhibidaError);
    expect(() => cliente.rpc("buscar_productos")).not.toThrow();
    expect(espia.intentosDeEscritura()).toBe(2);
  });
});
