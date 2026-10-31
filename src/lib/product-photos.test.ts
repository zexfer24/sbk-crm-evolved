import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductPhoto } from "@/lib/types";
import { PRODUCT_PHOTOS_BUCKET, fotoPrincipal, ordenarFotos, productPhotoUrl } from "@/lib/product-photos";

function foto(over: Partial<ProductPhoto> = {}): ProductPhoto {
  return { id: "f1", storagePath: "p1/f1.jpg", url: "https://x/f1.jpg", isPrimary: false, position: 0, ...over };
}

describe("productPhotoUrl", () => {
  it("pide la URL pública al bucket «product-photos» con la ruta tal cual", () => {
    const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://sb.test/public/${path}` } }));
    const from = vi.fn(() => ({ getPublicUrl }));
    const supabase = { storage: { from } } as unknown as SupabaseClient;

    const url = productPhotoUrl(supabase, "p1/abc.jpg");

    expect(from).toHaveBeenCalledWith("product-photos");
    expect(getPublicUrl).toHaveBeenCalledWith("p1/abc.jpg");
    expect(url).toBe("https://sb.test/public/p1/abc.jpg");
  });

  it("el bucket se llama product-photos (literal: lo fija la migración, no este símbolo)", () => {
    expect(PRODUCT_PHOTOS_BUCKET).toBe("product-photos");
  });
});

describe("ordenarFotos", () => {
  it("la principal va primero aunque su position sea mayor", () => {
    const orden = ordenarFotos([
      foto({ id: "a", position: 0 }),
      foto({ id: "b", position: 5, isPrimary: true }),
      foto({ id: "c", position: 1 }),
    ]);
    expect(orden.map((f) => f.id)).toEqual(["b", "a", "c"]);
  });

  it("el resto va por position ascendente y el empate se rompe por id", () => {
    const orden = ordenarFotos([
      foto({ id: "z", position: 2 }),
      foto({ id: "m", position: 1 }),
      foto({ id: "b", position: 1 }),
    ]);
    expect(orden.map((f) => f.id)).toEqual(["b", "m", "z"]);
  });

  it("no muta el arreglo recibido", () => {
    const original = [foto({ id: "b", position: 2 }), foto({ id: "a", position: 1 })];
    ordenarFotos(original);
    expect(original.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("vacío devuelve vacío", () => {
    expect(ordenarFotos([])).toEqual([]);
  });
});

describe("fotoPrincipal", () => {
  it("devuelve la primera de la lista (que ya viene ordenada)", () => {
    const fotos = [foto({ id: "a", isPrimary: true }), foto({ id: "b" })];
    expect(fotoPrincipal({ fotos })?.id).toBe("a");
  });

  it("null si el repuesto no tiene fotos", () => {
    expect(fotoPrincipal({ fotos: [] })).toBeNull();
  });
});
