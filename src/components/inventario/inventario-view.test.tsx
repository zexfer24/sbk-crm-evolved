/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, Product } from "@/lib/types";
import type { InventoryView } from "@/lib/inventory";
import { InventarioView } from "@/components/inventario/inventario-view";

/**
 * El inventario se cargó el 24 de agosto de 2026 y no se volvió a tocar. La
 * sincronización vive en una aplicación aparte del dueño y todavía no corre —
 * pero esta pantalla mostraba 5.438 repuestos igual que si se hubieran cargado
 * esa mañana. El dueño se enteró consultando la base de datos.
 *
 * Es lo mismo que ya pasó con la tasa del BCV, y por eso la tarjeta nueva se
 * parece a aquella: el número grande y, pegada, la antigüedad.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

// Lo que se prueba acá es la tarjeta de antigüedad y el cableado de la vista; los vecinos no pintan nada.
vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));
vi.mock("@/components/url-search-box", () => ({ UrlSearchBox: () => null }));

// 30/10/2026 (T5a): fila, tarjeta y ficha se sustituyen por dobles que dejan ver QUÉ props les llega y permiten
// "tocar la foto" sin montar el Drawer ni la calculadora. Lo suyo propio lo prueban sus archivos.
vi.mock("@/components/inventario/producto-fila", () => ({
  ProductoFila: (props: {
    product: { id: string };
    soloLectura?: boolean;
    puedeEditarFotos?: boolean;
    onAbrirFicha?: (id: string) => void;
  }) => (
    <li
      data-testid="fila"
      data-puede-fotos={String(Boolean(props.puedeEditarFotos))}
      data-solo-lectura={String(Boolean(props.soloLectura))}
    >
      <button type="button" onClick={() => props.onAbrirFicha?.(props.product.id)}>
        foto de {props.product.id}
      </button>
    </li>
  ),
}));
vi.mock("@/components/inventario/producto-tarjeta", () => ({
  ProductoTarjeta: (props: {
    product: { id: string };
    puedeEditarFotos?: boolean;
    onAbrirFicha: (id: string) => void;
  }) => (
    <li data-testid="tarjeta" data-puede-fotos={String(Boolean(props.puedeEditarFotos))}>
      <button type="button" onClick={() => props.onAbrirFicha(props.product.id)}>
        foto de {props.product.id}
      </button>
    </li>
  ),
}));
const fichaProps = vi.fn();
vi.mock("@/components/inventario/producto-ficha", () => ({
  ProductoFicha: (props: {
    product: { id: string } | null;
    isOpen: boolean;
    puedeEditarFotos?: boolean;
    soloLectura?: boolean;
  }) => {
    fichaProps(props);
    return <div data-testid="ficha" data-open={String(props.isOpen)} data-producto={props.product?.id ?? ""} />;
  },
}));
// El panel «Presupuestos guardados» lee de la base al montar (21/10/2026, T5): aquí llega vacío.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/presupuestos-data", () => ({
  fetchPresupuestos: vi.fn().mockResolvedValue([]),
  borrarPresupuesto: vi.fn(),
  borrarMisPresupuestos: vi.fn(),
}));

const ASESOR: Agent = {
  id: "agent-1",
  displayName: "Rosa",
  fullName: "Rosa Pérez",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

const CATALOGO = {
  engineFamilies: 12,
  commercialModels: 40,
  modelEngineLinks: 60,
  compatibilityRules: 900,
  searchSynonyms: 30,
};

function haceDias(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function pintar(updatedAt: string | null, withoutWeight = 0) {
  render(
    <InventarioView
      currentAgent={ASESOR}
      products={[]}
      total={0}
      totals={{ productos: 5438, activos: 5435, agotados: 2474, bajos: 300, withoutWeight, conFoto: 0, updatedAt }}
      catalog={CATALOGO}
      params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
      bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
    />
  );

  return screen.getByText("Actualizado").closest(".cli-stat");
}

function ui() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

/** Abre la caja «Ordenar por» (las opciones no se montan mientras está cerrada). */
async function abrirOrden() {
  await ui().click(screen.getByRole("button", { name: "Ordenar por" }));
}

function producto(id: string, over: Partial<Product> = {}): Product {
  return {
    id,
    name: `Repuesto ${id}`,
    brand: null,
    price: 10,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-10-30T10:00:00Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    ...over,
  };
}

function pintarConProductos(
  products: Product[],
  { vista, role = "supervisor" }: { vista?: InventoryView; role?: Agent["role"] } = {}
) {
  return render(
    <InventarioView
      currentAgent={{ ...ASESOR, role }}
      products={products}
      total={products.length}
      totals={{ productos: 6440, activos: 6435, agotados: 3, bajos: 4, withoutWeight: 5, conFoto: 412, updatedAt: haceDias(0) }}
      catalog={CATALOGO}
      params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
      bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
      vista={vista}
    />
  );
}

describe("InventarioView — la antigüedad del inventario se ve", () => {
  it("muestra cuántos días lleva el catálogo sin cambios", () => {
    const tarjeta = pintar(haceDias(4));

    expect(tarjeta).toHaveTextContent("4 días");
    expect(tarjeta).toHaveTextContent(/La IA sigue cotizando con esto/i);
  });

  /** El mismo tratamiento visual que la tasa vieja: si no se distingue, no sirve de nada. */
  it("marca la tarjeta como vieja para que se vea distinta", () => {
    expect(pintar(haceDias(4))).toHaveAttribute("data-stale", "true");
  });

  it("con el inventario de hoy no alarma", () => {
    const tarjeta = pintar(haceDias(0));

    expect(tarjeta).toHaveTextContent("Hoy");
    expect(tarjeta).not.toHaveAttribute("data-stale");
  });

  it("sin fecha lo dice, en vez de mostrar un cero", () => {
    const tarjeta = pintar(null);

    expect(tarjeta).toHaveTextContent("—");
    expect(tarjeta).toHaveTextContent(/no se sabe/i);
  });
});

/** T4, "Seis frentes del buzón" (8/9/2026): el hueco de peso que Cashea exige para el envío gratis. */
describe("InventarioView — Sin peso", () => {
  it("la tarjeta de resumen muestra el conteo y por qué importa", () => {
    pintar(haceDias(0), 37);

    // "Sin peso" aparece como etiqueta de la tarjeta y, con la caja «Ordenar por»
    // abierta, como filtro; cerrada solo está la tarjeta, que es la del conteo grande.
    const tarjeta = screen.getAllByText("Sin peso").map((el) => el.closest(".cli-stat")).find(Boolean);
    expect(tarjeta).toHaveTextContent("37");
    expect(tarjeta).toHaveTextContent(/Cashea/i);
  });

  it("el filtro «Sin peso» está en la sección «Mostrar» de la caja «Ordenar por»", async () => {
    pintar(haceDias(0));
    await abrirOrden();

    expect(within(screen.getByRole("group", { name: "Mostrar" })).getByRole("link", { name: "Sin peso" })).toBeInTheDocument();
  });
});

/**
 * T3 del plan "El inventario llega de Saint y no se toca a mano" (25/9/2026):
 * la pantalla deja de hablar de "copia ni sincronización en el medio" (era
 * falso desde que `saint.sync_products()` corre cada minuto) y el filtro que
 * antes se llamaba "Desactivados" pasa a nombrar la razón real —Saint dio de
 * baja el repuesto, no un asesor desde acá.
 */
describe("InventarioView — textos de Saint", () => {
  it("un supervisor/admin NO tiene subtítulo bajo «Inventario» (decisión del operador, 30/10/2026): el título va solo", () => {
    pintar(haceDias(0));

    expect(screen.getByRole("heading", { level: 1, name: "Inventario" })).toBeInTheDocument();
    expect(document.querySelector(".dash-subtitle")).toBeNull();
    expect(screen.queryByText(/llegan de Saint cada minuto/i)).toBeNull();
  });

  it("el filtro se llama «Fuera de Saint», no «Desactivados»", async () => {
    pintar(haceDias(0));
    await abrirOrden();

    expect(screen.getByRole("link", { name: "Fuera de Saint" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Desactivados" })).not.toBeInTheDocument();
  });
});

/**
 * T5, plan "Carrito de cotización en el Inventario, con Cashea" (12/10/2026) y
 * T3 del plan "Inventario y caja" (13/10/2026): la vista queda envuelta en el
 * provider del carrito y el botón que abre el panel es FLOTANTE (abajo a la
 * derecha), ya no una píldora de la cabecera. `ProductoFila` está mockeada
 * arriba, así que acá no se puede agregar nada: se prueba que el botón existe,
 * arranca en cero, vive fuera de `.dash-header` y de `.dash-frame` y que la
 * vista sigue pintando lo de siempre. Agregar desde una fila se prueba en
 * `producto-fila-carrito.test.tsx`; el globo de unidades, en
 * `carrito-boton.test.tsx`.
 */
describe("InventarioView — botón flotante del carrito", () => {
  it("hay UN solo botón «Abrir carrito», flotante y sin unidades al arrancar", () => {
    pintar(haceDias(0));

    const botones = screen.getAllByRole("button", { name: "Abrir carrito" });
    expect(botones).toHaveLength(1);
    expect(botones[0]).toHaveClass("inv-carrito-flotante");
    expect(botones[0].querySelector(".inv-carrito-globo")).toBeNull();
  });

  it("ya no está en la cabecera: se monta dentro de <main>, fuera del flujo de .dash-content", () => {
    pintar(haceDias(0));

    const boton = screen.getByRole("button", { name: "Abrir carrito" });
    expect(boton.closest(".dash-header")).toBeNull();
    expect(boton.closest("main")).not.toBeNull();
  });

  it("el provider y el botón no agregan hijos directos a .dash ni a .dash-frame (trampa del grid, 9/9/2026)", () => {
    pintar(haceDias(0));

    const frame = document.querySelector(".dash-frame");
    expect(frame).not.toBeNull();
    // `.dash-frame` es un grid de dos columnas: el rail (mockeado a null) y `main`.
    expect(frame!.childElementCount).toBe(1);
    expect(document.querySelector(".dash")?.childElementCount).toBe(1);
    expect(document.querySelector(".dash")?.parentElement?.childElementCount).toBe(1);
  });
});

/**
 * T4 del plan "Inventario y caja" (13/10/2026): bajo «Sin peso» la lista abre
 * por existencia y la nota del panel lo dice, discreta. Ninguna opción de
 * orden queda activa (ninguna es ese orden); un orden explícito apaga la nota.
 * 30/10/2026: las opciones viven en la caja «Ordenar por», que hay que abrir.
 */
describe("InventarioView — orden por defecto de «Sin peso»", () => {
  function pintarOrden(filter: "todos" | "sin-peso", sort: "nombre" | "existencia" | "stock") {
    render(
      <InventarioView
        currentAgent={ASESOR}
        products={[]}
        total={0}
        totals={{ productos: 10, activos: 10, agotados: 0, bajos: 0, withoutWeight: 3, conFoto: 0, updatedAt: haceDias(0) }}
        catalog={CATALOGO}
        params={{ query: "", filter, sort, page: 1 }}
        bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
      />
    );
  }

  it("sin-peso por existencia: la nota lo dice y ninguna opción de orden está activa", async () => {
    pintarOrden("sin-peso", "existencia");

    expect(screen.getByText(/Ordenado por existencia, de mayor a menor/)).toBeInTheDocument();
    await abrirOrden();
    const grupo = screen.getByRole("group", { name: "Ordenar" });
    expect(grupo.querySelector('[aria-current="true"]')).toBeNull();
  });

  it("sin-peso con «Por nombre» explícito: la nota se va y la opción de nombre queda activa", async () => {
    pintarOrden("sin-peso", "nombre");
    await abrirOrden();

    expect(screen.queryByText(/Ordenado por existencia/)).toBeNull();
    expect(screen.getByRole("link", { name: "Por nombre" })).toHaveAttribute("aria-current", "true");
    // Escribe orden=nombre: sin él el clic no cambiaría nada bajo este filtro.
    expect(screen.getByRole("link", { name: "Por nombre" })).toHaveAttribute(
      "href",
      "/inventario?filtro=sin-peso&orden=nombre"
    );
  });

  it("los filtros no arrastran el orden por defecto: «Todos» desde sin-peso va limpio y «Sin peso» desde todos no escribe orden", async () => {
    pintarOrden("sin-peso", "existencia");
    await abrirOrden();
    expect(screen.getByRole("link", { name: "Todos" })).toHaveAttribute("href", "/inventario");
    cleanup();

    pintarOrden("todos", "nombre");
    await abrirOrden();
    expect(screen.getByRole("link", { name: "Sin peso" })).toHaveAttribute("href", "/inventario?filtro=sin-peso");
    expect(screen.queryByText(/Ordenado por existencia/)).toBeNull();
  });
});

/**
 * T5 del plan "Presupuestos y mensajes rápidos" (21/10/2026): «Presupuestos
 * guardados» y la calculadora fija se montan DENTRO de `.dash-content`; ningún
 * hijo directo nuevo en `.dash-frame` (trampa del grid de dos columnas,
 * 9/9/2026). El rail está mockeado a `null`: el marco solo tiene a `<main>`.
 * El caso con el rail real (dos hijos) está en `inventario-view-caja.test.tsx`.
 */
describe("InventarioView — presupuestos y calculadora del mostrador", () => {
  it("las dos piezas viven dentro de .dash-content", () => {
    pintar(haceDias(0));

    const contenido = document.querySelector(".dash-content");
    expect(contenido).not.toBeNull();
    expect(contenido!.querySelector(".inv-presupuestos")).not.toBeNull();
    expect(contenido!.querySelector(".inv-calc")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Presupuestos guardados" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Monto en bolívares" })).toBeInTheDocument();
  });

  it("la calculadora comparte grilla con la lista de repuestos y no cuelga de .dash-frame", () => {
    pintar(haceDias(0));

    const mostrador = document.querySelector(".inv-mostrador");
    expect(mostrador).not.toBeNull();
    expect(mostrador!.parentElement).toHaveClass("dash-content");
    expect(mostrador!.querySelector(".inv-panel-lista")).not.toBeNull();
    expect(mostrador!.querySelector(".inv-calc")).not.toBeNull();
    expect(document.querySelector(".dash-frame")!.childElementCount).toBe(1);
  });
});

/**
 * 30/10/2026, plan «Cada repuesto con su foto», T5a: la vista monta «Ordenar por»
 * en lugar de las dos tiras de píldoras, el interruptor Lista/Cuadrícula, el
 * encabezado de la lista, la tarjeta «Con foto» y UNA ficha del repuesto.
 */
describe("InventarioView — barra: «Ordenar por» y vista", () => {
  it("ya no existen las dos tiras de píldoras: hay una caja «Ordenar por» y el interruptor de vista", () => {
    const { container } = pintarConProductos([producto("a")]);

    // El panel de presupuestos tiene sus propias píldoras: solo importa la barra de la lista.
    expect(container.querySelector(".inv-panel-lista .cli-filters")).toBeNull();
    expect(screen.queryByRole("group", { name: "Filtrar repuestos" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Ordenar repuestos" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ordenar por" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Vista del inventario" })).toBeInTheDocument();
  });

  it("la caja y el interruptor viven en la barra sticky, junto al buscador", () => {
    const { container } = pintarConProductos([producto("a")]);
    const barra = container.querySelector(".inv-panel-lista > .cli-toolbar") as HTMLElement;

    expect(barra).not.toBeNull();
    expect(within(barra).getByRole("button", { name: "Ordenar por" })).toBeInTheDocument();
    expect(within(barra).getByRole("group", { name: "Vista del inventario" })).toBeInTheDocument();
  });

  it("el interruptor marca la vista que llega por props", () => {
    pintarConProductos([producto("a")], { vista: "cuadricula" });
    expect(screen.getByRole("button", { name: "Cuadrícula" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sin `vista` la vista inicial es Lista (D4)", () => {
    pintarConProductos([producto("a")]);
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("InventarioView — lista o cuadrícula", () => {
  const productos = [producto("a"), producto("b")];

  it("«lista»: encabezado único y una fila por repuesto, sin tarjetas", () => {
    const { container } = pintarConProductos(productos, { vista: "lista" });

    expect(screen.getAllByTestId("fila")).toHaveLength(2);
    expect(screen.queryAllByTestId("tarjeta")).toHaveLength(0);
    expect(container.querySelector("ul.inv-grid")).toBeNull();
    expect(container.querySelector("ul.inv-list")).not.toBeNull();
    expect(container.querySelector(".inv-head")).not.toBeNull();
  });

  it("«cuadricula»: tarjetas en una `ul.inv-grid`, sin filas ni encabezado", () => {
    const { container } = pintarConProductos(productos, { vista: "cuadricula" });

    expect(screen.getAllByTestId("tarjeta")).toHaveLength(2);
    expect(screen.queryAllByTestId("fila")).toHaveLength(0);
    expect(container.querySelector("ul.inv-grid")).not.toBeNull();
    expect(container.querySelector("ul.inv-list")).toBeNull();
    expect(container.querySelector(".inv-head")).toBeNull();
  });

  it("el encabezado único: Repuesto, Stock, Promoción, Divisa, Estándar y Peso (kg), decorativo", () => {
    const { container } = pintarConProductos(productos, { vista: "lista" });
    const cabecera = container.querySelector(".inv-head") as HTMLElement;

    expect(cabecera).toHaveAttribute("aria-hidden", "true");
    expect(Array.from(cabecera.children).map((c) => c.textContent)).toEqual([
      "Repuesto",
      "Stock",
      "Promoción",
      "Divisa",
      "Estándar",
      "Peso (kg)",
      "",
    ]);
    // Hermano de la lista, no hijo: la `ul` solo contiene repuestos.
    expect(cabecera.parentElement).toBe(container.querySelector("ul.inv-list")?.parentElement);
    expect(container.querySelector("ul.inv-list")).not.toContainElement(cabecera);
  });

  it("sin repuestos no hay encabezado ni lista: sale el mensaje de vacío", () => {
    const { container } = pintarConProductos([], { vista: "lista" });
    expect(container.querySelector(".inv-head")).toBeNull();
    expect(screen.getByText("El catálogo está vacío")).toBeInTheDocument();
  });

  it("la lista ofrece permiso de fotos solo a supervisor y admin (D1)", () => {
    for (const [role, esperado] of [
      ["supervisor", "true"],
      ["admin", "true"],
      ["agent", "false"],
      ["caja", "false"],
    ] as const) {
      const { unmount } = pintarConProductos([producto("a")], { vista: "lista", role });
      expect(screen.getByTestId("fila"), role).toHaveAttribute("data-puede-fotos", esperado);
      unmount();
    }
  });

  it("la cuadrícula recibe el mismo permiso de fotos", () => {
    pintarConProductos([producto("a")], { vista: "cuadricula", role: "admin" });
    expect(screen.getByTestId("tarjeta")).toHaveAttribute("data-puede-fotos", "true");
    cleanup();
    pintarConProductos([producto("a")], { vista: "cuadricula", role: "agent" });
    expect(screen.getByTestId("tarjeta")).toHaveAttribute("data-puede-fotos", "false");
  });
});

describe("InventarioView — la ficha del repuesto", () => {
  beforeEach(() => {
    fichaProps.mockClear();
    refresh.mockClear();
  });

  it("monta UNA ficha, cerrada y sin repuesto al arrancar", () => {
    pintarConProductos([producto("a"), producto("b")]);

    expect(screen.getAllByTestId("ficha")).toHaveLength(1);
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-producto", "");
  });

  it("tocar la foto de una fila abre la ficha de ESE repuesto", async () => {
    pintarConProductos([producto("a"), producto("b")], { vista: "lista" });

    await ui().click(screen.getByRole("button", { name: "foto de b" }));

    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-producto", "b");
  });

  it("tocar la foto de una tarjeta también abre la ficha", async () => {
    pintarConProductos([producto("a"), producto("b")], { vista: "cuadricula" });

    await ui().click(screen.getByRole("button", { name: "foto de a" }));

    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-producto", "a");
  });

  it("la ficha lleva el permiso de fotos del rol y el solo-lectura de la caja", () => {
    pintarConProductos([producto("a")], { role: "supervisor" });
    expect(fichaProps).toHaveBeenLastCalledWith(expect.objectContaining({ puedeEditarFotos: true, soloLectura: false }));
    cleanup();

    pintarConProductos([producto("a")], { role: "caja" });
    expect(fichaProps).toHaveBeenLastCalledWith(expect.objectContaining({ puedeEditarFotos: false, soloLectura: true }));
  });

  it("al guardar algo en la ficha (onCambio) la vista pide los datos de nuevo con router.refresh", () => {
    pintarConProductos([producto("a")]);
    const { onCambio } = fichaProps.mock.calls.at(-1)![0] as { onCambio: () => void };

    onCambio();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("cerrar la ficha (onOpenChange(false)) la deja cerrada", async () => {
    pintarConProductos([producto("a")]);
    await ui().click(screen.getByRole("button", { name: "foto de a" }));
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "true");

    const { onOpenChange } = fichaProps.mock.calls.at(-1)![0] as { onOpenChange: (abierto: boolean) => void };
    act(() => onOpenChange(false));

    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "false");
  });

  it("si el repuesto abierto ya no está en la página (otro filtro), la ficha no se queda mostrando uno que no es", async () => {
    const { rerender } = pintarConProductos([producto("a"), producto("b")]);
    await ui().click(screen.getByRole("button", { name: "foto de b" }));
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-producto", "b");

    rerender(
      <InventarioView
        currentAgent={ASESOR}
        products={[producto("a")]}
        total={1}
        totals={{ productos: 1, activos: 1, agotados: 0, bajos: 0, withoutWeight: 0, conFoto: 0, updatedAt: haceDias(0) }}
        catalog={CATALOGO}
        params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
        bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
      />
    );

    expect(screen.getByTestId("ficha")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("ficha")).toHaveAttribute("data-producto", "");
  });
});

describe("InventarioView — tarjeta «Con foto» y notas de los totales", () => {
  function tarjeta(nombre: string) {
    return screen.getByText(nombre, { selector: ".lm-eyebrow" }).closest(".cli-stat") as HTMLElement;
  }

  it("«Con foto» muestra el número grande, el total chico, la barra de avance y la nota", () => {
    pintarConProductos([producto("a")]);
    const t = tarjeta("Con foto");

    expect(t.querySelector(".cli-stat-value")).toHaveTextContent("412");
    expect(t.querySelector(".cli-stat-total")).toHaveTextContent("/ 6440");
    // 412 / 6440 = 6,4 %.
    expect(t.querySelector(".cli-stat-bar span")).toHaveStyle({ width: "6.4%" });
    expect(t).toHaveTextContent("Se cargan desde la ficha de cada repuesto.");
    expect(t).toHaveAttribute("data-nuevo", "true");
  });

  it("la barra no se rompe sin repuestos", () => {
    render(
      <InventarioView
        currentAgent={ASESOR}
        products={[]}
        total={0}
        totals={{ productos: 0, activos: 0, agotados: 0, bajos: 0, withoutWeight: 0, conFoto: 0, updatedAt: haceDias(0) }}
        catalog={CATALOGO}
        params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
        bcvRate={null}
      />
    );
    expect(tarjeta("Con foto").querySelector(".cli-stat-bar span")).toHaveStyle({ width: "0%" });
  });

  it("«Bajo stock» ahora dice «De 1 a 5 unidades.»", () => {
    pintarConProductos([producto("a")]);
    expect(tarjeta("Bajo stock")).toHaveTextContent("De 1 a 5 unidades.");
  });

  it("el grid de tarjetas lleva la clase local que deja entrar las siete en una fila", () => {
    const { container } = pintarConProductos([producto("a")]);
    expect(container.querySelector(".cli-stats")).toHaveClass("inv-stats");
    expect(container.querySelectorAll(".cli-stats > .cli-stat")).toHaveLength(7);
  });
});
