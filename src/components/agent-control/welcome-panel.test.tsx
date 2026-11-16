/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomePanel } from "@/components/agent-control/welcome-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";

// Mismo patrón que payment-methods-panel.test.tsx: el toast real no aporta; el
// resto de HeroUI queda intacto para escribir como lo haría una persona.
const toastDanger = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: {
      success: (...a: unknown[]) => toastSuccess(...a),
      danger: (...a: unknown[]) => toastDanger(...a),
    },
  };
});

const CONFIG = {
  welcomeText: "Hola, bienvenido a *SBK Motors*. Atendemos de lunes a viernes.",
  welcomeFollowups: ["¿En qué te puedo ayudar?", "¿Qué repuesto buscas?"],
};

const onSave = vi.fn(async () => {});

function renderPanel(props: Partial<React.ComponentProps<typeof WelcomePanel>> = {}) {
  return render(<WelcomePanel config={CONFIG} canEdit onSave={onSave} {...props} />);
}

const setup = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

beforeEach(() => {
  for (const fn of [toastDanger, toastSuccess, onSave]) fn.mockClear();
});

describe("WelcomePanel — carga", () => {
  it("carga el texto y las frases; el contador dice n/1000 y la vista previa pinta la negrita", () => {
    renderPanel();

    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue(CONFIG.welcomeText);
    expect(screen.getByLabelText("Frase 1")).toHaveValue("¿En qué te puedo ayudar?");
    expect(screen.getByLabelText("Frase 2")).toHaveValue("¿Qué repuesto buscas?");
    expect(screen.getByText(`${CONFIG.welcomeText.length}/1000`)).toBeInTheDocument();

    const vista = screen.getByLabelText("Vista previa de la bienvenida");
    expect(vista.querySelector("strong")).toHaveTextContent("SBK Motors");
  });
});

describe("WelcomePanel — guardar", () => {
  it("guarda el borrador NORMALIZADO (sin espacios en los bordes) y las frases en orden", async () => {
    const user = setup();
    renderPanel();

    const texto = screen.getByLabelText("Texto de bienvenida");
    await user.clear(texto);
    await user.type(texto, "   Hola a todos   ");
    await user.type(screen.getByLabelText("Frase 2"), "  ");
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        welcomeText: "Hola a todos",
        followups: ["¿En qué te puedo ayudar?", "¿Qué repuesto buscas?"],
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith("Bienvenida guardada.");
  });

  it("Guardar está deshabilitado mientras no haya cambios respecto de lo cargado", async () => {
    const user = setup();
    renderPanel();

    const guardar = screen.getByRole("button", { name: "Guardar bienvenida" });
    expect(guardar).toBeDisabled();

    await user.type(screen.getByLabelText("Texto de bienvenida"), "!");
    expect(guardar).toBeEnabled();
  });
});

describe("WelcomePanel — frases", () => {
  it("agregar una frase, escribirla y guardar la incluye; Quitar la saca", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Agregar frase" }));
    await user.type(screen.getByLabelText("Frase 3"), "¿Buscas algo en especial?");
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        welcomeText: CONFIG.welcomeText,
        followups: ["¿En qué te puedo ayudar?", "¿Qué repuesto buscas?", "¿Buscas algo en especial?"],
      })
    );

    // Con tres frases ya se puede quitar una.
    await user.click(screen.getByRole("button", { name: "Quitar frase 1" }));
    expect(screen.getByLabelText("Frase 1")).toHaveValue("¿Qué repuesto buscas?");
    expect(screen.queryByLabelText("Frase 3")).not.toBeInTheDocument();
  });

  it("con 2 frases los botones Quitar están deshabilitados", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Quitar frase 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar frase 2" })).toBeDisabled();
  });

  it("con 8 frases Agregar frase está deshabilitado", () => {
    const frases = Array.from({ length: 8 }, (_, i) => `Frase número ${i + 1}`);
    renderPanel({ config: { ...CONFIG, welcomeFollowups: frases } });
    expect(screen.getByRole("button", { name: "Agregar frase" })).toBeDisabled();
  });
});

describe("WelcomePanel — validación", () => {
  it("con el texto vacío avisa bajo el área y no llama; al escribir, ese error desaparece", async () => {
    const user = setup();
    renderPanel();

    await user.clear(screen.getByLabelText("Texto de bienvenida"));
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    expect(await screen.findByText("Escribe el mensaje de bienvenida.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Texto de bienvenida"), "Hola");
    expect(screen.queryByText("Escribe el mensaje de bienvenida.")).not.toBeInTheDocument();
  });

  it("una frase de 161 caracteres avisa bajo ESA frase, y solo ahí", async () => {
    const user = setup();
    renderPanel({ config: { ...CONFIG, welcomeFollowups: ["x".repeat(161), "Frase corta"] } });

    // Hace falta un cambio para habilitar Guardar.
    await user.type(screen.getByLabelText("Frase 2"), "!");
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    const error = await screen.findByText("La frase no puede pasar de 160 caracteres.");
    expect(error).toHaveAttribute("role", "alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(error.closest(".ac-sv-followup")).toContainElement(screen.getByLabelText("Frase 1"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("una frase vacía pide escribirla o quitarla", async () => {
    const user = setup();
    renderPanel();

    await user.clear(screen.getByLabelText("Frase 2"));
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    expect(await screen.findByText("Escribe la frase o quítala.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Frase 2"), "Hola");
    expect(screen.queryByText("Escribe la frase o quítala.")).not.toBeInTheDocument();
  });
});

describe("WelcomePanel — errores al guardar", () => {
  it("un fallo de permiso muestra ESE texto y uno de red el genérico", async () => {
    const user = setup();
    onSave.mockRejectedValueOnce(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    renderPanel();

    await user.type(screen.getByLabelText("Texto de bienvenida"), "!");
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
    expect(toastSuccess).not.toHaveBeenCalled();

    onSave.mockRejectedValueOnce(new Error("fetch failed"));
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));

    await waitFor(() => expect(toastDanger).toHaveBeenLastCalledWith("No se pudo guardar la bienvenida."));
    // Lo escrito se conserva.
    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue(`${CONFIG.welcomeText}!`);
  });
});

describe("WelcomePanel — solo lectura y no disponible", () => {
  it("sin canEdit: campos deshabilitados, sin Guardar/Agregar/Quitar y con la nota", () => {
    renderPanel({ canEdit: false });

    expect(screen.getByLabelText("Texto de bienvenida")).toBeDisabled();
    expect(screen.getByLabelText("Frase 1")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar bienvenida" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agregar frase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Quitar frase/ })).not.toBeInTheDocument();
    expect(screen.getByText("Solo un supervisor o admin puede cambiar la bienvenida.")).toBeInTheDocument();
    // Todo se sigue viendo.
    expect(screen.getByLabelText("Vista previa de la bienvenida")).toBeInTheDocument();
  });

  it("con config=null dice «No disponible» y no pinta ningún campo", () => {
    renderPanel({ config: null });

    expect(screen.getByText(/No disponible/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Texto de bienvenida")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Frase 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar bienvenida" })).not.toBeInTheDocument();
  });
});

describe("WelcomePanel — datos nuevos del padre", () => {
  it("sin cambios sin guardar el borrador se actualiza; con cambios se respeta lo escrito", async () => {
    const user = setup();
    const { rerender } = renderPanel();

    rerender(
      <WelcomePanel
        config={{ welcomeText: "Texto nuevo", welcomeFollowups: ["Uno", "Dos", "Tres"] }}
        canEdit
        onSave={onSave}
      />
    );
    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue("Texto nuevo");
    expect(screen.getByLabelText("Frase 3")).toHaveValue("Tres");

    await user.type(screen.getByLabelText("Texto de bienvenida"), " más");
    rerender(
      <WelcomePanel
        config={{ welcomeText: "Otro texto", welcomeFollowups: ["Uno", "Dos", "Tres"] }}
        canEdit
        onSave={onSave}
      />
    );
    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue("Texto nuevo más");
  });

  it("tras guardar con espacios en los bordes, el borrador queda igual a lo guardado y un refresco posterior sí lo actualiza (R1/C1, 16/11/2026)", async () => {
    const user = setup();
    const { rerender } = renderPanel();

    const texto = screen.getByLabelText("Texto de bienvenida");
    await user.clear(texto);
    await user.type(texto, "Hola ");
    await user.click(screen.getByRole("button", { name: "Guardar bienvenida" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    // El padre vuelve a pasar lo guardado (normalizado, sin el espacio final).
    rerender(<WelcomePanel config={{ ...CONFIG, welcomeText: "Hola" }} canEdit onSave={onSave} />);
    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue("Hola");
    expect(screen.getByRole("button", { name: "Guardar bienvenida" })).toBeDisabled();

    // Y sin cambios sin guardar, un texto nuevo del servidor sí entra.
    rerender(<WelcomePanel config={{ ...CONFIG, welcomeText: "Texto del servidor" }} canEdit onSave={onSave} />);
    expect(screen.getByLabelText("Texto de bienvenida")).toHaveValue("Texto del servidor");
  });
});
