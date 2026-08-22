import { describe, expect, it } from "vitest";
import { mediaUrlFor, storagePathFromUrl } from "@/lib/storage";

describe("mediaUrlFor", () => {
  it("apunta a la ruta propia del CRM, no al bucket", () => {
    expect(mediaUrlFor("conv-1/wamid.abc.jpg")).toBe("/api/media/conv-1/wamid.abc.jpg");
  });

  it("codifica cada segmento sin escapar las barras que separan carpetas", () => {
    expect(mediaUrlFor("conv 1/foto (1).jpg")).toBe("/api/media/conv%201/foto%20(1).jpg");
  });
});

describe("storagePathFromUrl", () => {
  it("recupera el path de una URL de la ruta propia", () => {
    expect(storagePathFromUrl("/api/media/conv-1/wamid.abc.jpg")).toBe("conv-1/wamid.abc.jpg");
  });

  it("deshace la codificación de los segmentos", () => {
    expect(storagePathFromUrl("/api/media/conv%201/foto%20(1).jpg")).toBe("conv 1/foto (1).jpg");
  });

  /** Los mensajes guardados mientras el bucket era público siguen viéndose. */
  it("recupera el path de una URL pública vieja del bucket", () => {
    const url = "http://127.0.0.1:54321/storage/v1/object/public/whatsapp-media/conv-1/wamid.abc.jpg";
    expect(storagePathFromUrl(url)).toBe("conv-1/wamid.abc.jpg");
  });

  /**
   * Sin esto, una URL guardada por un tercero haría que el servidor firmara
   * y sirviera un archivo que no es suyo.
   */
  it("devuelve null si la URL apunta a otro lado", () => {
    expect(storagePathFromUrl("https://ajeno.example/secreto.pdf")).toBeNull();
    expect(storagePathFromUrl("http://127.0.0.1:54321/storage/v1/object/public/otro-bucket/x.jpg")).toBeNull();
  });
});
