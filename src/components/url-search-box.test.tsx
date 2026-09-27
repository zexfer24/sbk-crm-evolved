/** @vitest-environment jsdom */
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

  // Reporte del dueño y los asesores, 27/9/2026: "el cuadro me devuelve
  // letras que ya borré". Causa (a): se empujó "tubo esc" a la URL, el
  // asesor sigue borrando hasta "tub" ANTES de que vuelva la respuesta del
  // servidor para "tubo esc" — esa respuesta atrasada no puede resucitar un
  // texto que el propio cuadro ya dejó atrás.
  it("no revive una letra borrada cuando la propia navegación llega tarde", () => {
    const { rerender } = renderBox();
    type("tubo esc");
    flush(); // dispara el push real: la URL queda en "tubo esc"
    type("tub"); // el asesor ya borró; el push de "tub" todavía no se disparó

    rerender(
      <UrlSearchBox basePath="/clientes" query="tubo esc" keep={{}} placeholder="Buscar" label="Buscar clientes" />
    );

    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("tub");
  });

  // Corrección del orquestador, 27/9/2026: recordar solo el ÚLTIMO empuje no
  // alcanza con un servidor lento. Si el asesor sigue escribiendo/borrando
  // más rápido de lo que el servidor responde, puede haber DOS (o más)
  // navegaciones en vuelo a la vez — "tubo esc" y, encima, "tub" — y las dos
  // respuestas pueden llegar, en cualquier orden, después de que el asesor
  // ya escribió otra cosa. Ninguna de las dos puede pisar el borrador.
  it("no revive una letra borrada aunque el servidor tarde dos empujes en responder", () => {
    const { rerender } = renderBox();
    type("tubo esc");
    flush(); // primer push real: la URL queda en "tubo esc"
    type("tub");
    flush(); // segundo push real: la URL queda en "tub" (el eco de "tubo esc" todavía no volvió)

    rerender(
      <UrlSearchBox basePath="/clientes" query="tubo esc" keep={{}} placeholder="Buscar" label="Buscar clientes" />
    );
    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("tub");

    rerender(
      <UrlSearchBox basePath="/clientes" query="tub" keep={{}} placeholder="Buscar" label="Buscar clientes" />
    );
    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("tub");
  });

  // Causa (b): `parseInventoryParams` (y el de Clientes) recortan la
  // búsqueda con `trim()`, así que escribir "tubo " con el espacio final
  // empuja "tubo" a la URL — la respuesta, sin el espacio, no puede borrar
  // el espacio que el asesor todavía está escribiendo.
  it("conserva el espacio final que el asesor sigue escribiendo", () => {
    const { rerender } = renderBox();
    type("tubo ");

    rerender(
      <UrlSearchBox basePath="/clientes" query="tubo" keep={{}} placeholder="Buscar" label="Buscar clientes" />
    );

    expect(screen.getByLabelText<HTMLInputElement>("Buscar clientes").value).toBe("tubo ");
  });

  // Una navegación que el cuadro NUNCA produjo (atrás/adelante del
  // navegador, o un filtro que dispara otra búsqueda) sigue reemplazando el
  // borrador — la regla nueva no debe volver el cuadro sordo a lo externo.
  it("una navegación externa que el cuadro nunca empujó sí reemplaza el borrador", () => {
    const { rerender } = renderBox({ query: "pedro" });
    type("pe"); // el asesor empieza a escribir otra cosa, sin llegar a empujarla

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
