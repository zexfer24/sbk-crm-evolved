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

const { updateSession, rutaPermitidaParaCaja } = await import("@/lib/supabase/middleware");

function pedir(path: string, opciones: { cookieSupabase?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opciones.cookieSupabase) headers.cookie = "sb-crm-auth-token=abc";
  return updateSession(new NextRequest(new URL(`https://crm.example${path}`), { headers }));
}

const conSesion = { data: { session: { user: { id: "agent-1" } } } };
// La cuenta de caja (13/10/2026) viaja con `app_metadata.role = 'caja'` en el JWT.
const conSesionCaja = { data: { session: { user: { id: "caja-1", app_metadata: { role: "caja" } } } } };

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

describe("updateSession — el rol caja solo ve el Inventario", () => {
  it("caja en /inbox: redirige a /inventario", async () => {
    getSessionMock.mockResolvedValue(conSesionCaja);

    const response = await pedir("/inbox");

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/inventario");
  });

  it("caja en la raíz (Recorrido): redirige a /inventario", async () => {
    getSessionMock.mockResolvedValue(conSesionCaja);

    const response = await pedir("/");

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/inventario");
  });

  it("caja en /inventario?page=3: pasa, sin redirigir", async () => {
    getSessionMock.mockResolvedValue(conSesionCaja);

    const response = await pedir("/inventario?page=3");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("caja en /login con sesión: la manda a /inventario, no a /", async () => {
    getSessionMock.mockResolvedValue(conSesionCaja);

    const response = await pedir("/login");

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/inventario");
  });

  it("un asesor sigue entrando a /inbox", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "a1", app_metadata: { role: "agent" } } } },
    });

    const response = await pedir("/inbox");

    expect(response.status).toBe(200);
  });

  it("un asesor en /login sigue yendo a /", async () => {
    getSessionMock.mockResolvedValue(conSesion);

    const response = await pedir("/login");

    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  });
});

describe("updateSession — /api con y sin cookie de Supabase", () => {
  it("sin cookie sb-: pasa sin leer la sesión (webhook, cron, healthcheck)", async () => {
    const response = await pedir("/api/conversations/x");

    expect(response.status).toBe(200);
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("con cookie sb- y una cookie ajena: sin cookie de Supabase NO cuenta", async () => {
    const response = await updateSession(
      new NextRequest(new URL("https://crm.example/api/x"), { headers: { cookie: "otra=1" } })
    );

    expect(response.status).toBe(200);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("con cookie y sesión de caja: 403 en JSON", async () => {
    getSessionMock.mockResolvedValue(conSesionCaja);

    const response = await pedir("/api/messages/send", { cookieSupabase: true });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Sin permiso" });
  });

  it("con cookie y sesión de asesor: pasa", async () => {
    getSessionMock.mockResolvedValue(conSesion);

    const response = await pedir("/api/messages/send", { cookieSupabase: true });

    expect(response.status).toBe(200);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("con cookie pero sin sesión válida: pasa (cada ruta responde su propio 401)", async () => {
    const response = await pedir("/api/messages/send", { cookieSupabase: true });

    expect(response.status).toBe(200);
  });
});

describe("rutaPermitidaParaCaja", () => {
  const casos: [string, boolean][] = [
    ["/inventario", true],
    ["/inventario/", true],
    ["/inventario/alguna-subruta", true],
    ["/login", true],
    ["/_next/static/chunks/a.js", true],
    ["/favicon.ico", true],
    ["/manifest.webmanifest", true],
    ["/icon.png", true],
    ["/apple-icon.png", true],
    ["/", false],
    ["/inbox", false],
    ["/clientes", false],
    ["/casos", false],
    ["/ventas", false],
    ["/agent-control", false],
    // Un prefijo parecido NO es la sección.
    ["/inventarioX", false],
    ["/inventario-otro", false],
    ["/loginx", false],
    ["/api/health", false],
  ];

  it.each(casos)("%s -> %s", (ruta, esperado) => {
    expect(rutaPermitidaParaCaja(ruta)).toBe(esperado);
  });
});
