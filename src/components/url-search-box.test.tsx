import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { UrlSearchBox } from "@/components/url-search-box";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  replace.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderBox(props: Partial<React.ComponentProps<typeof UrlSearchBox>> = {}) {
  return render(
    <UrlSearchBox
      basePath="/clientes"
      query=""
      keep={{}}
      placeholder="Buscar"
      label="Buscar clientes"
      {...props}
    />
  );
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Buscar clientes"), { target: { value } });
}

function flush() {
  act(() => {
    vi.runAllTimers();
  });
}

describe("UrlSearchBox", () => {
  it("no navega hasta que pasa el debounce", () => {
    renderBox();
    type("pedro");
    expect(replace).not.toHaveBeenCalled();

    flush();
    expect(replace).toHaveBeenCalledWith("/clientes?q=pedro");
  });

  // Sin esto, escribir "pedro" dispararía cinco navegaciones y cinco
  // consultas al servidor, una por tecla.
  it("agrupa varias teclas seguidas en una sola navegación, con el último valor", () => {
    renderBox();
    type("p");
    type("pe");
    type("ped");
    flush();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/clientes?q=ped");
  });

  it("conserva los parámetros que se le piden conservar", () => {
    renderBox({ keep: { filtro: "compradores", orden: "nombre" } });
    type("ana");
    flush();

    expect(replace).toHaveBeenCalledWith("/clientes?q=ana&filtro=compradores&orden=nombre");
  });

  // Se vuelve siempre a la primera página: la página 7 de la lista anterior
  // no significa nada en la lista nueva.
  it("nunca arrastra la página en la URL nueva", () => {
    renderBox({ keep: { filtro: "compradores" } });
    type("ana");
    flush();

    expect(replace).toHaveBeenCalledWith(expect.not.stringContaining("page="));
  });

  it("al vaciar la búsqueda vuelve a la ruta limpia", () => {
    renderBox({ query: "pedro" });
    type("");
    flush();

    expect(replace).toHaveBeenCalledWith("/clientes");
  });

  it("recorta los espacios de la búsqueda", () => {
    renderBox();
    type("  bera  ");
    flush();

    expect(replace).toHaveBeenCalledWith("/clientes?q=bera");
  });

  it("codifica lo que el usuario escriba", () => {
    renderBox();
    type("kit & arrastre");
    flush();

    expect(replace).toHaveBeenCalledWith("/clientes?q=kit+%26+arrastre");
  });

  // Al pulsar atrás en el navegador, o al tocar un filtro, la URL cambia sin
  // que nadie teclee: el cuadro tiene que reflejar lo que se está buscando.
  it("se sincroniza cuando la búsqueda cambia desde fuera", () => {
    const { rerender } = renderBox({ query: "pedro" });
    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("pedro");

    rerender(
      <UrlSearchBox basePath="/clientes" query="ana" keep={{}} placeholder="Buscar" label="Buscar clientes" />
    );

    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("ana");
  });

  it("el botón de limpiar solo aparece cuando hay texto", () => {
    renderBox();
    expect(screen.queryByLabelText("Limpiar búsqueda")).toBeNull();

    type("algo");
    expect(screen.getByLabelText("Limpiar búsqueda")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Limpiar búsqueda"));
    flush();
    expect(replace).toHaveBeenCalledWith("/clientes");
  });
});
