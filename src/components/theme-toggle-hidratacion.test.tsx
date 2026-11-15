/** @vitest-environment jsdom */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * El botón de tema tras HIDRATAR (15/11/2026). Bug visto en el navegador del
 * operador: con el sistema en oscuro y `liminal-theme = "dark"` la página cargaba
 * oscura (la fija el script del <head>) pero el botón decía «Cambiar a modo
 * oscuro» y `aria-pressed` = false para siempre. El servidor no tiene
 * `matchMedia`, así que renderiza «modo oscuro»; en la hidratación el cliente
 * calculaba el tema resuelto con `matchMedia` real (oscuro), el atributo
 * discrepaba, `suppressHydrationWarning` lo callaba y React dejaba el del
 * servidor; el render posterior daba lo mismo que el de la hidratación y no
 * volvía a tocar el DOM. Ahora el render de hidratación calcula EXACTAMENTE lo
 * del servidor ("light") y el siguiente sí parchea el DOM.
 */

let sistemaOscuro = false;

function simularMatchMedia() {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: consulta.includes("prefers-color-scheme: dark") ? sistemaOscuro : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/** El HTML que entregaría el servidor: sin `matchMedia` ni `localStorage`. */
function htmlDelServidor(): string {
  const matchMedia = globalThis.matchMedia;
  // @ts-expect-error simula Node sin matchMedia
  delete globalThis.matchMedia;
  try {
    return renderToString(<ThemeToggle />);
  } finally {
    globalThis.matchMedia = matchMedia;
  }
}

async function hidratar(html: string) {
  const contenedor = document.createElement("div");
  contenedor.innerHTML = html;
  document.body.appendChild(contenedor);
  await act(async () => {
    hydrateRoot(contenedor, <ThemeToggle />);
  });
  return contenedor;
}

let errores: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sistemaOscuro = false;
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.classList.remove("dark");
  errores = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errores.mockRestore();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ThemeToggle tras la hidratación", () => {
  it("el servidor pinta «modo oscuro» (no sabe el tema): es el punto de partida del bug", () => {
    const html = htmlDelServidor();
    expect(html).toContain("Cambiar a modo oscuro");
    expect(html).toContain('aria-pressed="false"');
  });

  it("sistema oscuro y preferencia oscura: tras hidratar dice «modo claro» y aria-pressed = true", async () => {
    const html = htmlDelServidor();
    sistemaOscuro = true;
    simularMatchMedia();
    localStorage.setItem("liminal-theme", "dark");
    document.documentElement.dataset.theme = "dark";

    await hidratar(html);

    const boton = screen.getByRole("button");
    expect(boton.getAttribute("aria-label")).toBe("Cambiar a modo claro");
    expect(boton.getAttribute("title")).toBe("Cambiar a modo claro");
    expect(boton.getAttribute("aria-pressed")).toBe("true");
  });

  it("sistema claro y preferencia oscura: también dice «modo claro»", async () => {
    const html = htmlDelServidor();
    sistemaOscuro = false;
    simularMatchMedia();
    localStorage.setItem("liminal-theme", "dark");
    document.documentElement.dataset.theme = "dark";

    await hidratar(html);

    const boton = screen.getByRole("button");
    expect(boton.getAttribute("aria-label")).toBe("Cambiar a modo claro");
    expect(boton.getAttribute("aria-pressed")).toBe("true");
  });

  it("sistema oscuro sin preferencia guardada (sigue al sistema): dice «modo claro»", async () => {
    const html = htmlDelServidor();
    sistemaOscuro = true;
    simularMatchMedia();
    document.documentElement.dataset.theme = "dark";

    await hidratar(html);

    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Cambiar a modo claro");
  });

  it("tema claro: el botón sigue diciendo «modo oscuro» y aria-pressed = false", async () => {
    const html = htmlDelServidor();
    simularMatchMedia();

    await hidratar(html);

    const boton = screen.getByRole("button");
    expect(boton.getAttribute("aria-label")).toBe("Cambiar a modo oscuro");
    expect(boton.getAttribute("aria-pressed")).toBe("false");
  });

  it("la hidratación no produce avisos de desajuste en consola (sin suppressHydrationWarning)", async () => {
    const html = htmlDelServidor();
    sistemaOscuro = true;
    simularMatchMedia();
    localStorage.setItem("liminal-theme", "dark");

    await hidratar(html);

    expect(errores).not.toHaveBeenCalled();
  });

  it("un clic después de hidratar pasa a claro y la etiqueta se actualiza", async () => {
    const html = htmlDelServidor();
    sistemaOscuro = true;
    simularMatchMedia();
    localStorage.setItem("liminal-theme", "dark");
    document.documentElement.dataset.theme = "dark";
    await hidratar(html);

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(localStorage.getItem("liminal-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    const boton = screen.getByRole("button");
    expect(boton.getAttribute("aria-label")).toBe("Cambiar a modo oscuro");
    expect(boton.getAttribute("aria-pressed")).toBe("false");
  });
});
