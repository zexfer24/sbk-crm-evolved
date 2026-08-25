import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * El portón de las páginas, y lo que cuesta abrirlo.
 *
 * Preguntarle a GoTrue por el usuario en cada petición costaba ~841 ms
 * medidos, y se hacía también para las rutas /api/*, donde no se decide
 * nada: el healthcheck cada 30 s, cada mensaje entrante de WhatsApp y cada
 * vuelta del cron pagaban esa llamada para nada.
 */

const getSessionMock = vi.fn(async () => ({ data: { session: null as unknown } }));
const getUserMock = vi.fn(async () => ({ data: { user: null as unknown } }));
const createServerClientMock = vi.fn(() => ({
  auth: { getSession: getSessionMock, getUser: getUserMock },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...(args as [])),
}));

const { updateSession } = await import("@/lib/supabase/middleware");

function pedir(path: string) {
  return updateSession(new NextRequest(new URL(`https://crm.example${path}`)));
}

const conSesion = { data: { session: { user: { id: "agent-1" } } } };

beforeEach(() => {
  createServerClientMock.mockClear();
  getSessionMock.mockClear();
  getUserMock.mockClear();
  getSessionMock.mockResolvedValue({ data: { session: null } });
});

describe("updateSession — las rutas de API no pasan por acá", () => {
  it("no mira la sesión en /api: cada ruta se autentica sola", async () => {
    const response = await pedir("/api/health");

    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
    // Sigue de largo: nada de redirigir el webhook de Meta a /login.
    expect(response.status).toBe(200);
  });

  it("tampoco en el webhook, que no tiene sesión de usuario", async () => {
    await pedir("/api/webhooks/whatsapp");
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});

describe("updateSession — el portón de las páginas sigue cerrado", () => {
  it("sin sesión, una página manda a /login", async () => {
    const response = await pedir("/inbox");

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("con sesión, la página se sirve", async () => {
    getSessionMock.mockResolvedValue(conSesion);

    const response = await pedir("/inbox");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("sin sesión, /login se muestra en vez de redirigir a sí misma", async () => {
    const response = await pedir("/login");
    expect(response.status).toBe(200);
  });

  it("con sesión, /login devuelve al CRM", async () => {
    getSessionMock.mockResolvedValue(conSesion);

    const response = await pedir("/login");

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  });

  /**
   * `getSession()` renueva el token cuando venció y escribe la cookie nueva;
   * `getUser()` además le preguntaba a GoTrue por el usuario en cada
   * petición, que es la llamada de 841 ms que se quitó.
   */
  it("no le pregunta a GoTrue por el usuario", async () => {
    getSessionMock.mockResolvedValue(conSesion);

    await pedir("/inbox");

    expect(getUserMock).not.toHaveBeenCalled();
  });
});
