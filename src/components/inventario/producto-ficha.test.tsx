/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Product, ProductPhoto } from "@/lib/types";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import { ProductoFicha } from "@/components/inventario/producto-ficha";
import {
  CarritoContext,
  type InventarioCarritoValue,
} from "@/components/inventario/inventario-carrito-context";

/**
 * Ficha lateral del repuesto (30/10/2026, plan «Cada repuesto con su foto»,
 * T4). Los helpers de precio ya los prueban `inventory.test.ts` y las filas;
 * acá se fija lo propio de la ficha: qué botones de gestión ve cada rol, que
 * cada uno llame a SU mutación con los argumentos correctos, el tope de 6
 * fotos, el hueco sin foto, «Para Cashea» y que NO exista «Enviar foto» (D3).
 * El Drawer y el diálogo de confirmación son los reales de HeroUI (corren en
 * jsdom); solo se sustituye `toast` para afirmar sobre los avisos.
 */

const toastSuccess = vi.fn();
const toastDanger = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...original,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      danger: (...args: unknown[]) => toastDanger(...args),
    },
  };
});

const cliente = { cliente: "falso" };
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => cliente) }));

const uploadProductPhoto = vi.fn();
const replaceProductPhoto = vi.fn();
const deleteProductPhoto = vi.fn();
const setPrimaryProductPhoto = vi.fn();
vi.mock("@/lib/product-photo-mutations", () => ({
  uploadProductPhoto: (...args: unknown[]) => uploadProductPhoto(...args),
  replaceProductPhoto: (...args: unknown[]) => replaceProductPhoto(...args),
  deleteProductPhoto: (...args: unknown[]) => deleteProductPhoto(...args),
  setPrimaryProductPhoto: (...args: unknown[]) => setPrimaryProductPhoto(...args),
}));

// El Modal real de la calculadora no se monta acá: basta saber que la ficha la
// abre con el producto correcto (mismo criterio que producto-tarjeta.test).
vi.mock("@/components/inventario/cashea-calculadora", () => ({
  CasheaCalculadora: ({ isOpen, product }: { isOpen: boolean; product: { name: string } }) =>
    isOpen ? <div data-testid="cashea-abierta">{product.name}</div> : null,
}));

function foto(n: number, over: Partial<ProductPhoto> = {}): ProductPhoto {
  return {
    id: `f${n}`,
    storagePath: `prod-1/f${n}.jpg`,
    url: `https://cdn.test/prod-1/f${n}.jpg`,
    isPrimary: n === 1,
    position: n,
    ...over,
  };
}

function fotos(cuantas: number): ProductPhoto[] {
  return Array.from({ length: cuantas }, (_, i) => foto(i + 1));
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: "Bera",
    price: 25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-09-08T10:00:00Z",
    compatibility: [],
    weightKg: 1.5,
    shippingFeeUsd: 4,
    precioDivisaUsd: 22,
    saintCode: "ABC-123",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: fotos(2),
    ...over,
  };
}

const agregar = vi.fn();

function conCarrito(children: ReactNode) {
  const value = { agregar, cantidadDe: () => 0 } as unknown as InventarioCarritoValue;
  return <CarritoContext.Provider value={value}>{children}</CarritoContext.Provider>;
}

function renderFicha(
  over: Partial<Product> = {},
  props: { soloLectura?: boolean; puedeEditarFotos?: boolean; carrito?: boolean; isOpen?: boolean } = {}
) {
  const { carrito = true, ...resto } = props;
  const onCambio = vi.fn();
  const onOpenChange = vi.fn();
  const ui = (
    <ProductoFicha
      product={product(over)}
      bcvRate={40}
      isOpen
      onOpenChange={onOpenChange}
      onCambio={onCambio}
      {...resto}
    />
  );
  return { onCambio, onOpenChange, ...render(carrito ? conCarrito(ui) : ui) };
}

function archivo(nombre = "foto.jpg", tipo = "image/jpeg") {
  return new File(["x"], nombre, { type: tipo });
}

function inputArchivo(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("No hay input de archivo");
  return input;
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastDanger.mockClear();
  uploadProductPhoto.mockReset().mockResolvedValue(foto(9));
  replaceProductPhoto.mockReset().mockResolvedValue(foto(1));
  deleteProductPhoto.mockReset().mockResolvedValue(undefined);
  setPrimaryProductPhoto.mockReset().mockResolvedValue(undefined);
  agregar.mockClear();
});

describe("ProductoFicha — cabecera y estructura", () => {
  it("sin producto o cerrada no pinta nada", () => {
    const onCambio = vi.fn();
    const { unmount } = render(
      <ProductoFicha product={null} bcvRate={40} isOpen onOpenChange={vi.fn()} onCambio={onCambio} />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    renderFicha({}, { isOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("muestra nombre, código Saint, marca y el botón Cerrar", async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpenChange } = renderFicha();
    expect(screen.getByRole("heading", { level: 2, name: "Carburador PZ27" })).toBeInTheDocument();
    expect(screen.getByText("ABC-123")).toBeInTheDocument();
    expect(screen.getByText("Bera")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("las insignias salen con las mismas condiciones que la fila", () => {
    renderFicha({ isActive: false, weightKg: null, saintAddedAt: new Date().toISOString() });
    expect(screen.getByText("Oculto a la IA")).toBeInTheDocument();
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
    expect(screen.getByText("Nuevo desde Saint")).toBeInTheDocument();
  });

  it("un repuesto sano no lleva insignias", () => {
    renderFicha();
    expect(screen.queryByText("Oculto a la IA")).not.toBeInTheDocument();
    expect(screen.queryByText("Sin peso")).not.toBeInTheDocument();
    expect(screen.queryByText("Nuevo desde Saint")).not.toBeInTheDocument();
  });
});

describe("ProductoFicha — la galería", () => {
  it("muestra la principal grande con el nombre como alt y las miniaturas", () => {
    renderFicha({ fotos: fotos(3) });
    expect(screen.getByRole("img", { name: "Carburador PZ27" })).toHaveAttribute("src", "https://cdn.test/prod-1/f1.jpg");
    expect(screen.getByText("Principal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Foto 1" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Foto 2" })).toHaveAttribute("aria-current", "false");
    expect(screen.getByRole("button", { name: "Foto 3" })).toBeInTheDocument();
  });

  it("al tocar una miniatura cambia la foto grande y deja de decir «Principal»", async () => {
    const user = userEvent.setup({ delay: null });
    renderFicha({ fotos: fotos(3) });
    await user.click(screen.getByRole("button", { name: "Foto 3" }));
    expect(screen.getByRole("img", { name: "Carburador PZ27" })).toHaveAttribute("src", "https://cdn.test/prod-1/f3.jpg");
    expect(screen.getByRole("button", { name: "Foto 3" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Principal")).not.toBeInTheDocument();
  });

  it("al cambiar de repuesto vuelve a la foto principal", async () => {
    const user = userEvent.setup({ delay: null });
    const base = { bcvRate: 40, isOpen: true, onOpenChange: vi.fn(), onCambio: vi.fn() };
    const { rerender } = render(<ProductoFicha product={product({ fotos: fotos(3) })} {...base} />);
    await user.click(screen.getByRole("button", { name: "Foto 3" }));
    const otro = product({
      id: "prod-2",
      name: "Filtro de aire",
      fotos: [
        { id: "g1", storagePath: "p2/g1.jpg", url: "https://cdn.test/p2/g1.jpg", isPrimary: true, position: 1 },
        { id: "g2", storagePath: "p2/g2.jpg", url: "https://cdn.test/p2/g2.jpg", isPrimary: false, position: 2 },
        { id: "g3", storagePath: "p2/g3.jpg", url: "https://cdn.test/p2/g3.jpg", isPrimary: false, position: 3 },
      ],
    });
    rerender(<ProductoFicha product={otro} {...base} />);
    expect(screen.getByRole("img", { name: "Filtro de aire" })).toHaveAttribute("src", "https://cdn.test/p2/g1.jpg");
    expect(screen.getByRole("button", { name: "Foto 1" })).toHaveAttribute("aria-current", "true");
  });
});

describe("ProductoFicha — gestión por rol", () => {
  it("con permiso aparecen Reemplazar, Eliminar, Marcar como principal y Agregar", async () => {
    const user = userEvent.setup({ delay: null });
    renderFicha({ fotos: fotos(3) }, { puedeEditarFotos: true });
    // La seleccionada es la principal: no se ofrece marcarla.
    expect(screen.queryByRole("button", { name: "Marcar como principal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reemplazar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar otra foto" })).toBeInTheDocument();
    expect(screen.getByText(/Hasta 6 fotos\. JPG, PNG o WebP de hasta 15 MB/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Foto 2" }));
    expect(screen.getByRole("button", { name: "Marcar como principal" })).toBeInTheDocument();
  });

  it("sin permiso no aparece ninguno", () => {
    renderFicha({ fotos: fotos(3) }, { puedeEditarFotos: false });
    for (const nombre of ["Reemplazar", "Eliminar", "Marcar como principal", "Agregar otra foto"]) {
      expect(screen.queryByRole("button", { name: nombre })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/Hasta 6 fotos/)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("con 6 fotos no hay «Agregar otra foto», pero sí Reemplazar y Eliminar", () => {
    renderFicha({ fotos: fotos(6) }, { puedeEditarFotos: true });
    expect(screen.queryByRole("button", { name: "Agregar otra foto" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reemplazar" })).toBeInTheDocument();
  });
});

describe("ProductoFicha — agregar", () => {
  it("elegir un archivo sube la foto al repuesto y avisa con onCambio", async () => {
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    const file = archivo();
    await user.click(screen.getByRole("button", { name: "Agregar otra foto" }));
    await user.upload(inputArchivo(), file);
    await waitFor(() => expect(onCambio).toHaveBeenCalledTimes(1));
    expect(uploadProductPhoto).toHaveBeenCalledWith(cliente, "prod-1", file);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("un error muestra toast.danger y NO llama a onCambio", async () => {
    uploadProductPhoto.mockRejectedValue(new Error("Este repuesto ya tiene 6 fotos."));
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    await user.upload(inputArchivo(), archivo());
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(toastDanger).toHaveBeenCalledWith("No se pudo guardar la foto.");
    expect(onCambio).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("un rechazo de permisos muestra el mensaje claro del error", async () => {
    uploadProductPhoto.mockRejectedValue(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar las fotos."));
    const user = userEvent.setup({ delay: null });
    renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    await user.upload(inputArchivo(), archivo());
    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar las fotos.")
    );
  });

  it("mientras sube, los botones de gestión quedan deshabilitados (un clic = una acción)", async () => {
    let resolver!: (f: ProductPhoto) => void;
    uploadProductPhoto.mockReturnValue(new Promise<ProductPhoto>((r) => (resolver = r)));
    const user = userEvent.setup({ delay: null });
    renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    await user.upload(inputArchivo(), archivo());
    await waitFor(() => expect(screen.getByRole("button", { name: "Eliminar" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reemplazar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Agregar otra foto" })).toBeDisabled();
    resolver(foto(9));
    await waitFor(() => expect(screen.getByRole("button", { name: "Eliminar" })).toBeEnabled());
  });
});

describe("ProductoFicha — eliminar", () => {
  it("pide confirmación; cancelar no elimina", async () => {
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("¿Eliminar esta foto?")).toBeInTheDocument();
    expect(
      screen.getByText("El repuesto deja de mostrarla. Los mensajes que ya se enviaron con ella no cambian.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(deleteProductPhoto).not.toHaveBeenCalled();
    expect(onCambio).not.toHaveBeenCalled();
  });

  it("confirmar elimina la foto seleccionada y avisa con onCambio", async () => {
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(3) }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Foto 2" }));
    await user.click(screen.getByRole("button", { name: "Eliminar" }));
    await user.click(await screen.findByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(onCambio).toHaveBeenCalledTimes(1));
    expect(deleteProductPhoto).toHaveBeenCalledWith(cliente, "f2");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("si falla al eliminar avisa con toast.danger y no llama a onCambio", async () => {
    deleteProductPhoto.mockRejectedValue(new Error("falló"));
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(2) }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Eliminar" }));
    await user.click(await screen.findByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo guardar la foto."));
    expect(onCambio).not.toHaveBeenCalled();
  });
});

describe("ProductoFicha — marcar principal y reemplazar", () => {
  it("«Marcar como principal» usa el id de la foto seleccionada", async () => {
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: fotos(3) }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Foto 3" }));
    await user.click(screen.getByRole("button", { name: "Marcar como principal" }));
    await waitFor(() => expect(onCambio).toHaveBeenCalledTimes(1));
    expect(setPrimaryProductPhoto).toHaveBeenCalledWith(cliente, "f3");
  });

  it("«Reemplazar» sube el archivo sobre la foto seleccionada", async () => {
    const user = userEvent.setup({ delay: null });
    const lista = fotos(3);
    const { onCambio } = renderFicha({ fotos: lista }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Foto 2" }));
    await user.click(screen.getByRole("button", { name: "Reemplazar" }));
    const file = archivo("nueva.png", "image/png");
    await user.upload(inputArchivo(), file);
    await waitFor(() => expect(onCambio).toHaveBeenCalledTimes(1));
    expect(replaceProductPhoto).toHaveBeenCalledWith(cliente, lista[1], "prod-1", file);
    expect(uploadProductPhoto).not.toHaveBeenCalled();
  });
});

describe("ProductoFicha — sin fotos", () => {
  it("con permiso ofrece «Agregar la primera foto» y sube al elegirla", async () => {
    const user = userEvent.setup({ delay: null });
    const { onCambio } = renderFicha({ fotos: [] }, { puedeEditarFotos: true });
    expect(screen.getByRole("button", { name: /Agregar la primera foto/ })).toBeInTheDocument();
    expect(screen.queryByText("Este repuesto todavía no tiene foto")).not.toBeInTheDocument();
    const file = archivo();
    await user.upload(inputArchivo(), file);
    await waitFor(() => expect(onCambio).toHaveBeenCalledTimes(1));
    expect(uploadProductPhoto).toHaveBeenCalledWith(cliente, "prod-1", file);
  });

  it("sin permiso dice que todavía no tiene foto", () => {
    renderFicha({ fotos: [] }, { puedeEditarFotos: false });
    expect(screen.getByText("Este repuesto todavía no tiene foto")).toBeInTheDocument();
    expect(screen.getByText("Un supervisor puede cargarla desde aquí.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agregar la primera foto/ })).not.toBeInTheDocument();
  });
});

describe("ProductoFicha — datos de Saint", () => {
  it("pinta stock con su estado, promoción, divisa, estándar y peso", () => {
    renderFicha();
    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByText("Disponible")).toBeInTheDocument();
    expect(screen.getByText("Precio promoción")).toBeInTheDocument();
    expect(screen.getByText("Bs. 1000.00")).toBeInTheDocument();
    expect(screen.getByText("Precio divisa")).toBeInTheDocument();
    expect(screen.getByText("$ 22.00")).toBeInTheDocument();
    expect(screen.getByText("Precio estándar")).toBeInTheDocument();
    expect(screen.getByText(/incluye envío \$ 4\.00/)).toBeInTheDocument();
    expect(screen.getByText("1.500 kg")).toBeInTheDocument();
  });

  it.each([
    [0, "Agotado", "agotado"],
    [3, "Bajo stock", "bajo"],
    [10, "Disponible", "disponible"],
  ] as const)("con %i de stock dice «%s»", (stockQuantity, texto, nivel) => {
    renderFicha({ stockQuantity });
    expect(screen.getByText(texto)).toBeInTheDocument();
    expect(screen.getByLabelText("Stock de Carburador PZ27")).toHaveAttribute("data-level", nivel);
  });

  it("sin precio divisa lo dice con las palabras de siempre", () => {
    renderFicha({ precioDivisaUsd: null });
    expect(screen.getByText("Sin precio en SAINT")).toBeInTheDocument();
  });

  it("sin peso dice «Falta el peso» y «Sin cargar»", () => {
    renderFicha({ weightKg: null, shippingFeeUsd: null });
    expect(screen.getByText("Falta el peso")).toBeInTheDocument();
    expect(screen.getByText("Sin cargar")).toBeInTheDocument();
  });

  it("soloLectura (caja) no muestra «Precio estándar»", () => {
    renderFicha({}, { soloLectura: true });
    expect(screen.queryByText("Precio estándar")).not.toBeInTheDocument();
    expect(screen.getByText("Precio divisa")).toBeInTheDocument();
  });

  it("no muestra compatibilidad", () => {
    renderFicha({ compatibility: [{ brand: "Bera", model: "SBR", yearFrom: null, yearTo: null }] as never });
    expect(screen.queryByText(/compatib/i)).not.toBeInTheDocument();
  });
});

describe("ProductoFicha — Para Cashea", () => {
  it("un repuesto completo sale «Listo para Cashea» con su nota", () => {
    renderFicha();
    expect(screen.getByText("Para Cashea")).toBeInTheDocument();
    expect(screen.getByText("Listo para Cashea")).toBeInTheDocument();
    expect(screen.queryByText(/Le falta:/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "La sincronización con Cashea todavía no existe: esto solo muestra qué le faltaría a este repuesto el día que exista."
      )
    ).toBeInTheDocument();
  });

  it("sin peso dice «Le falta: peso cargado» y marca ese criterio", () => {
    renderFicha({ weightKg: null, shippingFeeUsd: null });
    expect(screen.getByText("Le falta: peso cargado")).toBeInTheDocument();
    expect(screen.queryByText("Listo para Cashea")).not.toBeInTheDocument();
    expect(screen.getByText("Peso cargado").closest("li")).toHaveAttribute("data-ok", "false");
    expect(screen.getByText("Foto principal").closest("li")).toHaveAttribute("data-ok", "true");
  });

  it("junta varios faltantes con coma", () => {
    renderFicha({ fotos: [], weightKg: null, shippingFeeUsd: null }, { puedeEditarFotos: false });
    expect(screen.getByText("Le falta: foto principal, peso cargado")).toBeInTheDocument();
  });
});

describe("ProductoFicha — el pie", () => {
  it("«Agregar al carrito» agrega este repuesto", async () => {
    const user = userEvent.setup({ delay: null });
    renderFicha();
    await user.click(screen.getByRole("button", { name: /Agregar al carrito/ }));
    expect(agregar).toHaveBeenCalledWith(expect.objectContaining({ id: "prod-1" }));
  });

  it("queda deshabilitado si Saint dio de baja el producto", () => {
    renderFicha({ isActive: false });
    expect(screen.getByRole("button", { name: /Agregar al carrito/ })).toBeDisabled();
  });

  it("sin carrito (fuera del provider) no se ofrece el botón", () => {
    renderFicha({}, { carrito: false });
    expect(screen.queryByRole("button", { name: /Agregar al carrito/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cashea/ })).toBeInTheDocument();
  });

  it("«Cashea» abre la calculadora con este repuesto", async () => {
    const user = userEvent.setup({ delay: null });
    renderFicha();
    await user.click(screen.getByRole("button", { name: /^Cashea$/ }));
    // Por testid y no por rol: el mock cuelga del mismo árbol que el Drawer, que lo oculta a la accesibilidad.
    expect(screen.getByTestId("cashea-abierta")).toHaveTextContent("Carburador PZ27");
  });

  it("no existe ningún «Enviar foto» (D3: la foto se envía desde el chat)", () => {
    renderFicha({}, { puedeEditarFotos: true });
    expect(screen.queryByText(/Enviar foto/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar/i })).not.toBeInTheDocument();
  });
});
