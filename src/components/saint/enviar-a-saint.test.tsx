/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnviarASaint } from "@/components/saint/enviar-a-saint";
import type { BorradorSaint, DatosClienteSaint } from "@/lib/saint-borradores";
import { textoConfirmacionReenvio } from "@/lib/saint-borradores";

/**
 * 25/10/2026, plan "Enviar a SAINT", T3: el botón con su confirmación de
 * reenvío, el modal de datos del cliente y la línea de estado. Las reglas
 * (qué se exige, qué texto sale) ya las prueba `saint-borradores.test.ts`;
 * acá se prueba que la interfaz las use y no las duplique.
 */

const toastSuccess = vi.fn();
const toastDanger = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      danger: (...args: unknown[]) => toastDanger(...args),
      warning: vi.fn(),
    },
  };
});

const enviarBorradorSaint = vi.fn();
vi.mock("@/lib/saint-borradores-data", () => ({
  enviarBorradorSaint: (...args: unknown[]) => enviarBorradorSaint(...args),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({ marca: "cliente" })) }));

const AHORA = new Date("2026-10-25T14:00:30.000Z");

const PRODUCTO = { name: "Carburador PZ27", saintCode: "A-100", isActive: true };

const INICIAL: DatosClienteSaint = {
  cedulaTipo: "V",
  cedulaNumero: "12345678",
  nombre: "María",
  apellido: "Pérez",
  telefono: "04141234567",
};

function borrador(over: Partial<BorradorSaint> = {}): BorradorSaint {
  return {
    id: "b-1",
    origen: "presupuesto",
    origenId: "pr-1",
    creadoPor: "agente-1",
    cedulaTipo: "V",
    cedulaNumero: "11111111",
    nombre: "María",
    apellido: "Pérez",
    telefono: "04249998877",
    estado: "pendiente",
    numeroSaint: null,
    codclie: null,
    clienteCreado: null,
    error: null,
    createdAt: "2026-10-25T14:00:00.000Z",
    procesadoAt: null,
    ...over,
  };
}

type Props = React.ComponentProps<typeof EnviarASaint>;

function montar(over: Partial<Props> = {}) {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  const onEnviado = vi.fn();
  const props: Props = {
    origen: "presupuesto",
    origenId: "pr-1",
    productos: [PRODUCTO],
    inicial: INICIAL,
    ultimo: null,
    ahora: AHORA,
    onEnviado,
    ...over,
  };
  const vista = render(<EnviarASaint {...props} />);
  return { user, onEnviado, props, ...vista };
}

const boton = () => screen.getByRole("button", { name: /enviar a saint/i });

beforeEach(() => {
  enviarBorradorSaint.mockReset();
  enviarBorradorSaint.mockResolvedValue("b-nuevo");
  toastSuccess.mockClear();
  toastDanger.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("EnviarASaint — el botón", () => {
  it("devuelve UN solo elemento raíz (un fragmento le desarmaría el grid al padre)", () => {
    const { container } = montar();

    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild).toHaveClass("saint-envio");
  });

  it("(a) un producto sin código SAINT deshabilita el botón y dice cuál", () => {
    montar({ productos: [PRODUCTO, { name: "Bujía NGK", saintCode: null, isActive: true }] });

    expect(boton()).toBeDisabled();
    expect(screen.getByText("Sin código SAINT: Bujía NGK.")).toBeInTheDocument();
  });

  it("un producto dado de baja también bloquea, con su propio texto", () => {
    montar({ productos: [{ name: "Filtro viejo", saintCode: "F-1", isActive: false }] });

    expect(boton()).toBeDisabled();
    expect(screen.getByText("Dados de baja en el inventario: Filtro viejo.")).toBeInTheDocument();
  });

  it("sin productos el botón queda deshabilitado", () => {
    montar({ productos: [] });

    expect(boton()).toBeDisabled();
  });

  it("(b) con un envío pendiente: «Enviando a SAINT…» y el botón deshabilitado", () => {
    montar({ ultimo: borrador({ estado: "pendiente" }) });

    expect(screen.getByRole("status")).toHaveTextContent("Enviando a SAINT…");
    expect(boton()).toBeDisabled();
  });

  it("con un envío procesando también está deshabilitado", () => {
    montar({ ultimo: borrador({ estado: "procesando" }) });

    expect(screen.getByRole("status")).toHaveTextContent("Creando en SAINT…");
    expect(boton()).toBeDisabled();
  });

  it("más de 2 minutos pendiente: dice que SAINT no responde", () => {
    montar({ ultimo: borrador({ estado: "pendiente", createdAt: "2026-10-25T13:50:00.000Z" }) });

    expect(screen.getByRole("status")).toHaveTextContent("SAINT no responde");
  });

  it("creado: muestra el número y el cliente, y el botón sigue disponible", () => {
    montar({ ultimo: borrador({ estado: "creado", numeroSaint: "FAC-77", codclie: "C-9" }) });

    expect(screen.getByRole("status")).toHaveTextContent("En SAINT como FAC-77");
    expect(screen.getByRole("status")).toHaveTextContent("Cliente C-9");
    expect(boton()).toBeEnabled();
  });
});

describe("EnviarASaint — solo el estado", () => {
  it("`soloEstado` pinta la línea de estado sin botón", () => {
    montar({ soloEstado: true, productos: [], ultimo: borrador({ estado: "creado", numeroSaint: "FAC-77" }) });

    expect(screen.getByRole("status")).toHaveTextContent("En SAINT como FAC-77");
    expect(screen.queryByRole("button", { name: /enviar a saint/i })).not.toBeInTheDocument();
  });
});

describe("EnviarASaint — reenvío y modal", () => {
  it("(c) con uno creado pide confirmación con el texto exacto y, al confirmar, abre el modal", async () => {
    const ultimo = borrador({ estado: "creado", numeroSaint: "FAC-77" });
    const { user } = montar({ ultimo });

    await user.click(boton());

    expect(await screen.findByText("¿Enviar de nuevo a SAINT?")).toBeInTheDocument();
    expect(screen.getByText(textoConfirmacionReenvio("presupuesto", "FAC-77", ultimo.createdAt))).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sí, enviar de nuevo" }));

    expect(await screen.findByLabelText("Nombre")).toBeInTheDocument();
  });

  it("cancelar la confirmación no abre el modal", async () => {
    const { user } = montar({ ultimo: borrador({ estado: "creado", numeroSaint: "FAC-77" }) });

    await user.click(boton());
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("¿Enviar de nuevo a SAINT?")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
  });

  it("(d) con un envío en error muestra el error y abre el modal sin confirmación", async () => {
    const { user } = montar({ ultimo: borrador({ estado: "error", error: "SAINT rechazó la cédula." }) });

    expect(screen.getByRole("status")).toHaveTextContent("SAINT rechazó la cédula.");
    await user.click(boton());

    expect(await screen.findByLabelText("Nombre")).toBeInTheDocument();
    expect(screen.queryByText("¿Enviar de nuevo a SAINT?")).not.toBeInTheDocument();
  });

  it("sin envíos abre el modal directo, con el texto de qué se manda", async () => {
    const { user } = montar();

    await user.click(boton());

    expect(await screen.findByText(/Se crea una factura en espera en SAINT/)).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("María");
    expect(screen.getByLabelText("Apellido")).toHaveValue("Pérez");
    expect(screen.getByLabelText("Cédula")).toHaveValue("12345678");
    expect(screen.getByLabelText("Teléfono")).toHaveValue("04141234567");
    expect(screen.getByLabelText("Tipo de cédula")).toHaveValue("V");
  });

  it("(e) la cédula y el teléfono vacíos de `inicial` se completan con los del último envío", async () => {
    const { user } = montar({
      inicial: { cedulaTipo: "", cedulaNumero: "", nombre: "José", apellido: "Núñez", telefono: "" },
      ultimo: borrador({ estado: "error", error: "x", cedulaTipo: "E", cedulaNumero: "87654321", telefono: "04125550000" }),
    });

    await user.click(boton());

    expect(await screen.findByLabelText("Cédula")).toHaveValue("87654321");
    expect(screen.getByLabelText("Tipo de cédula")).toHaveValue("E");
    expect(screen.getByLabelText("Teléfono")).toHaveValue("04125550000");
    // El nombre y el apellido de `inicial` mandan.
    expect(screen.getByLabelText("Nombre")).toHaveValue("José");
    expect(screen.getByLabelText("Apellido")).toHaveValue("Núñez");
  });

  it("lo que `inicial` sí trae NO lo pisa el último envío", async () => {
    const { user } = montar({
      ultimo: borrador({ estado: "error", error: "x", cedulaNumero: "99999999", telefono: "04120000000" }),
    });

    await user.click(boton());

    expect(await screen.findByLabelText("Cédula")).toHaveValue("12345678");
    expect(screen.getByLabelText("Teléfono")).toHaveValue("04141234567");
  });
});

describe("EnviarASaint — validación y envío", () => {
  async function abrirVacio() {
    const vista = montar({
      inicial: { cedulaTipo: "", cedulaNumero: "", nombre: "", apellido: "", telefono: "" },
    });
    await vista.user.click(boton());
    await screen.findByLabelText("Nombre");
    return vista;
  }

  it("(f) un mensaje por campo y no se llama a la base", async () => {
    const { user } = await abrirVacio();

    await user.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("Elige si la cédula es V o E.")).toBeInTheDocument();
    expect(screen.getByText("Falta el nombre.")).toBeInTheDocument();
    expect(screen.getByText("Falta el apellido.")).toBeInTheDocument();
    expect(screen.getByText(/Teléfono inválido/)).toBeInTheDocument();
    expect(enviarBorradorSaint).not.toHaveBeenCalled();
  });

  it("(f) editar un campo borra SOLO su error", async () => {
    const { user } = await abrirVacio();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Falta el nombre.");

    await user.type(screen.getByLabelText("Nombre"), "A");

    expect(screen.queryByText("Falta el nombre.")).not.toBeInTheDocument();
    expect(screen.getByText("Falta el apellido.")).toBeInTheDocument();
    expect(screen.getByText(/Teléfono inválido/)).toBeInTheDocument();
    expect(screen.getByText("Elige si la cédula es V o E.")).toBeInTheDocument();
  });

  it("(g) un envío correcto llama a la base con los argumentos exactos, avisa y avisa al padre", async () => {
    const { user, onEnviado } = montar();
    await user.click(boton());
    await screen.findByLabelText("Nombre");

    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(enviarBorradorSaint).toHaveBeenCalledTimes(1));
    expect(enviarBorradorSaint).toHaveBeenCalledWith(
      { marca: "cliente" },
      { origen: "presupuesto", origenId: "pr-1", datos: INICIAL },
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Enviado a SAINT. Te avisamos aquí cuando quede creado."),
    );
    expect(onEnviado).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument());
  });

  it("(g) manda lo que el asesor editó en el modal", async () => {
    const { user } = montar();
    await user.click(boton());
    const telefono = await screen.findByLabelText("Teléfono");
    await user.clear(telefono);
    await user.type(telefono, "+584121112233");
    await user.selectOptions(screen.getByLabelText("Tipo de cédula"), "E");

    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(enviarBorradorSaint).toHaveBeenCalled());
    expect(enviarBorradorSaint.mock.calls[0][1].datos).toEqual({
      ...INICIAL,
      cedulaTipo: "E",
      telefono: "+584121112233",
    });
  });

  it("(h) el error 23505 sale como «Ya hay un envío en curso.» y el modal sigue abierto", async () => {
    enviarBorradorSaint.mockRejectedValue({ code: "23505", message: "duplicate key" });
    const { user, onEnviado } = montar();
    await user.click(boton());
    await screen.findByLabelText("Nombre");

    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("Ya hay un envío en curso."));
    expect(screen.getByLabelText("Nombre")).toBeInTheDocument();
    expect(onEnviado).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("saint_envio_fallido", expect.anything());
  });

  it("un dato que la base rechaza muestra el texto en español que trae", async () => {
    enviarBorradorSaint.mockRejectedValue({
      code: "22023",
      message: "saint_dato_invalido",
      details: "La cédula ya existe con otro nombre en SAINT.",
    });
    const { user } = montar();
    await user.click(boton());
    await screen.findByLabelText("Nombre");

    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("La cédula ya existe con otro nombre en SAINT."));
  });

  it("al reabrir el modal los errores de la vez anterior no quedan pegados", async () => {
    const { user } = await abrirVacio();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Falta el nombre.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument());

    await user.click(boton());
    await screen.findByLabelText("Nombre");

    expect(screen.queryByText("Falta el nombre.")).not.toBeInTheDocument();
  });
});
