import { describe, expect, it, vi, afterEach } from "vitest";
import {
  QUICK_REPLY_MAX_PHOTO_BYTES,
  QUICK_REPLY_MAX_PHOTOS,
  QUICK_REPLY_PHOTO_TYPES,
  isQuickReplyPath,
  quickReplyPhotoPath,
  validateQuickReplyPhotos,
} from "@/lib/quick-reply-media";

// Las fotos de una respuesta rápida viajan a Meta como `image`: solo JPEG/PNG
// y hasta 5 MB. Los topes se fijan acá con su literal (no con el símbolo que se
// prueba) para que cambiar el número en el código ponga algo en rojo.

const foto = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: "casco.jpg",
  type: "image/jpeg",
  size: 1000,
  ...over,
});

describe("topes de las fotos de una respuesta rápida", () => {
  it("son 10 fotos de hasta 5 MB, JPEG o PNG", () => {
    expect(QUICK_REPLY_MAX_PHOTOS).toBe(10);
    expect(QUICK_REPLY_MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024);
    expect([...QUICK_REPLY_PHOTO_TYPES]).toEqual(["image/jpeg", "image/png"]);
  });
});

describe("validateQuickReplyPhotos", () => {
  it("acepta JPG y PNG dentro de los topes", () => {
    expect(validateQuickReplyPhotos(0, [foto(), foto({ type: "image/png", name: "a.png" })])).toBeNull();
  });

  it("acepta una foto que pesa EXACTAMENTE 5 MB", () => {
    expect(validateQuickReplyPhotos(0, [foto({ size: 5 * 1024 * 1024 })])).toBeNull();
  });

  it("rechaza una foto de 5 MB + 1 byte con el nombre en el mensaje", () => {
    expect(validateQuickReplyPhotos(0, [foto({ name: "grande.jpg", size: 5 * 1024 * 1024 + 1 })])).toBe(
      "La foto «grande.jpg» pesa más de 5 MB."
    );
  });

  it("rechaza lo que no es JPG ni PNG (webp, gif, pdf)", () => {
    for (const type of ["image/webp", "image/gif", "application/pdf", ""]) {
      expect(validateQuickReplyPhotos(0, [foto({ type })])).toBe("Solo fotos JPG o PNG.");
    }
  });

  it("rechaza pasarse de 10 contando las que ya tiene la respuesta", () => {
    expect(validateQuickReplyPhotos(10, [foto()])).toBe("Máximo 10 fotos por respuesta rápida.");
    expect(validateQuickReplyPhotos(8, [foto(), foto(), foto()])).toBe("Máximo 10 fotos por respuesta rápida.");
  });

  it("deja llegar justo a 10", () => {
    expect(validateQuickReplyPhotos(8, [foto(), foto()])).toBeNull();
    expect(validateQuickReplyPhotos(0, Array.from({ length: 10 }, () => foto()))).toBeNull();
  });

  it("una lista vacía no es un error", () => {
    expect(validateQuickReplyPhotos(3, [])).toBeNull();
  });

  it("devuelve el error del primer archivo malo de un lote mixto", () => {
    expect(
      validateQuickReplyPhotos(0, [foto(), foto({ type: "image/gif" }), foto({ name: "x.jpg", size: 6 * 1024 * 1024 })])
    ).toBe("Solo fotos JPG o PNG.");
  });
});

describe("quickReplyPhotoPath", () => {
  afterEach(() => vi.restoreAllMocks());

  it("arma quick-replies/<uuid>.jpg o .png según el tipo", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-3333-4444-555555555555");
    expect(quickReplyPhotoPath("image/jpeg")).toBe("quick-replies/11111111-2222-3333-4444-555555555555.jpg");
    expect(quickReplyPhotoPath("image/png")).toBe("quick-replies/11111111-2222-3333-4444-555555555555.png");
  });

  it("no inventa una extensión para un tipo no admitido", () => {
    expect(() => quickReplyPhotoPath("image/gif")).toThrow("Solo fotos JPG o PNG.");
  });
});

describe("isQuickReplyPath", () => {
  it("acepta rutas bajo quick-replies/", () => {
    expect(isQuickReplyPath("quick-replies/abc.jpg")).toBe(true);
  });

  it("rechaza otros prefijos, el prefijo solo y los recorridos con ..", () => {
    expect(isQuickReplyPath("outbound/conv-1/abc.jpg")).toBe(false);
    expect(isQuickReplyPath("quick-replies/")).toBe(false);
    expect(isQuickReplyPath("quick-replies/../outbound/x.jpg")).toBe(false);
    expect(isQuickReplyPath("/quick-replies/abc.jpg")).toBe(false);
    expect(isQuickReplyPath("")).toBe(false);
  });
});
