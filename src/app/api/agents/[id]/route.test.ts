import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * T6, "Ronda del cliente" (30/9/2026): un ADMIN cambia el nombre visible y la
 * contraseña de cualquier cuenta del CRM. La ruta corre en dos capas de
 * cliente Supabase, igual que `conversations/[id]/close`: la sesión normal
 * solo para saber quién pide, y el cliente admin (service_role) para escribir
 * — que salta la RLS y el trigger `enforce_agents_role_guard`, así que la
 * guarda de admin la hace la ruta y el cliente admin NO puede crearse antes.
 */

interface FakeAgent {
  id: string;
  displayName: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
}

const PASSWORD = "Clave-Secreta-8765";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";

let currentAgent: FakeAgent | null;

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => currentAgent),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));

/** Estado del cliente admin falso: qué existe, qué falla, qué se escribió. */
const admin = {
  exists: true,
  readError: null as { message: string } | null,
  nameRows: 1,
  nameError: null as { message: string } | null,
  metadataError: null as { message: string } | null,
  passwordError: null as { message: string; code?: string; status?: number } | null,
  nameUpdates: [] as { id: string; patch: Record<string, unknown> }[],
  authUpdates: [] as { id: string; attrs: Record<string, unknown> }[],
};

const createAdminClientMock = vi.fn(() => ({
  from(table: string) {
    if (table !== "agents") throw new Error(`Tabla inesperada en el test: ${table}`);
    return {
      select(columns: string) {
        return {
          eq(column: string, value: string) {
            return {
              maybeSingle: async () => {
                expect(columns).toBe("id");
                expect(column).toBe("id");
                if (admin.readError) return { data: null, error: admin.readError };
                return { data: admin.exists ? { id: value } : null, error: null };
              },
            };
          },
        };
      },
      update(patch: Record<string, unknown>) {
        return {
          eq(column: string, value: string) {
            return {
              select: async (columns: string) => {
                expect(column).toBe("id");
                expect(columns).toBe("id");
                admin.nameUpdates.push({ id: value, patch });
                if (admin.nameError) return { data: null, error: admin.nameError };
                return { data: Array.from({ length: admin.nameRows }, () => ({ id: value })), error: null };
              },
            };
          },
        };
      },
    };
  },
  auth: {
    admin: {
      updateUserById: async (id: string, attrs: Record<string, unknown>) => {
        admin.authUpdates.push({ id, attrs });
        if ("password" in attrs && admin.passwordError) return { data: { user: null }, error: admin.passwordError };
        if ("user_metadata" in attrs && admin.metadataError) return { data: { user: null }, error: admin.metadataError };
        return { data: { user: { id } }, error: null };
      },
    },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const logCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/lib/log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/log")>();
  const spy = (level: string) => (...args: unknown[]) => {
    logCalls.push([level, ...args]);
  };
  return { ...real, log: { info: spy("info"), warn: spy("warn"), error: spy("error") } };
});

import { PATCH } from "./route";

function fakeRequest(body: unknown): Request {
  return new Request(`http://crm.example/api/agents/${TARGET_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(id = TARGET_ID) {
  return { params: Promise.resolve({ id }) };
}

async function call(body: unknown, id = TARGET_ID) {
  const res = await PATCH(fakeRequest(body), ctx(id));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

function adminAgent(): FakeAgent {
  return { id: "admin-1", displayName: "Dueña", fullName: null, avatarUrl: null, role: "admin", isActive: true };
}

beforeEach(() => {
  currentAgent = adminAgent();
  admin.exists = true;
  admin.readError = null;
  admin.nameRows = 1;
  admin.nameError = null;
  admin.metadataError = null;
  admin.passwordError = null;
  admin.nameUpdates.length = 0;
  admin.authUpdates.length = 0;
  createAdminClientMock.mockClear();
  logCalls.length = 0;
});

describe("PATCH /api/agents/[id] — guardas", () => {
  it("sin sesión responde 401 y no crea el cliente admin", async () => {
    currentAgent = null;
    const res = await call({ displayName: "Nuevo" });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "Sin sesión." });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it.each(["supervisor", "agent"])("un %s recibe 403 y el cliente admin nunca se crea", async (role) => {
    currentAgent = { ...adminAgent(), role };
    const res = await call({ displayName: "Nuevo", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "Solo un administrador puede editar cuentas." });
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(admin.nameUpdates).toHaveLength(0);
    expect(admin.authUpdates).toHaveLength(0);
  });

  it("un cuerpo vacío es 400 «Nada que cambiar.»", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "Nada que cambiar." });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("una contraseña de 7 caracteres es 400 y no se repite en la respuesta", async () => {
    const res = await call({ password: "abc1234" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "La contraseña debe tener al menos 8 caracteres." });
    expect(res.text).not.toContain("abc1234");
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("un nombre de solo espacios es 400", async () => {
    const res = await call({ displayName: "   " });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "El nombre visible no puede quedar vacío." });
  });

  it("un cuerpo que no es JSON es 400", async () => {
    const res = await call("{no es json");
    expect(res.status).toBe(400);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("un asesor que no existe es 404", async () => {
    admin.exists = false;
    const res = await call({ displayName: "Nuevo" });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "No existe ese asesor." });
    expect(admin.nameUpdates).toHaveLength(0);
    expect(admin.authUpdates).toHaveLength(0);
  });

  it("un id que no es un UUID es 404 sin consultar la base", async () => {
    const res = await call({ displayName: "Nuevo" }, "no-es-uuid");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "No existe ese asesor." });
    expect(admin.nameUpdates).toHaveLength(0);
  });
});

describe("PATCH /api/agents/[id] — cambios", () => {
  it("solo el nombre: escribe agents.display_name y el metadata de auth", async () => {
    const res = await call({ displayName: "  María José  " });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, nameUpdated: true, passwordUpdated: false });
    expect(admin.nameUpdates).toEqual([{ id: TARGET_ID, patch: { display_name: "María José" } }]);
    expect(admin.authUpdates).toEqual([{ id: TARGET_ID, attrs: { user_metadata: { display_name: "María José" } } }]);
    expect(logCalls).toContainEqual([
      "info",
      "asesor_editado",
      { targetId: TARGET_ID, byId: "admin-1", campos: "nombre" },
    ]);
  });

  it("solo la contraseña: la cambia en auth y no toca agents", async () => {
    const res = await call({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, nameUpdated: false, passwordUpdated: true });
    expect(admin.nameUpdates).toHaveLength(0);
    expect(admin.authUpdates).toEqual([{ id: TARGET_ID, attrs: { password: PASSWORD } }]);
    expect(logCalls).toContainEqual([
      "info",
      "asesor_editado",
      { targetId: TARGET_ID, byId: "admin-1", campos: "contraseña" },
    ]);
  });

  it("los dos a la vez", async () => {
    const res = await call({ displayName: "Pedro", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, nameUpdated: true, passwordUpdated: true });
    expect(logCalls).toContainEqual([
      "info",
      "asesor_editado",
      { targetId: TARGET_ID, byId: "admin-1", campos: "nombre,contraseña" },
    ]);
  });

  it("un admin puede editarse a sí mismo", async () => {
    currentAgent = { ...adminAgent(), id: TARGET_ID };
    const res = await call({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, passwordUpdated: true });
  });

  it("si falla el metadata de auth el nombre sigue valiendo: solo queda un aviso", async () => {
    admin.metadataError = { message: "gotrue caído" };
    const res = await call({ displayName: "Pedro" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, nameUpdated: true, passwordUpdated: false });
    expect(logCalls.some((c) => c[0] === "warn")).toBe(true);
  });

  it("un UPDATE que no afecta filas no se da por guardado", async () => {
    admin.nameRows = 0;
    const res = await call({ displayName: "Pedro" });
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ ok: false, nameUpdated: false, passwordUpdated: false });
    expect(typeof res.json.error).toBe("string");
  });

  it("parcial: el nombre queda y la contraseña falla → 207 que dice qué quedó", async () => {
    admin.passwordError = { message: "Password should be at least 10 characters.", code: "weak_password", status: 422 };
    const res = await call({ displayName: "Pedro", password: PASSWORD });
    expect(res.status).toBe(207);
    expect(res.json).toMatchObject({ ok: false, nameUpdated: true, passwordUpdated: false });
    expect(String(res.json.error)).toMatch(/^No se pudo cambiar la contraseña: /);
    expect(res.text).not.toContain(PASSWORD);
  });

  it("si todo lo pedido falla es 500", async () => {
    admin.passwordError = { message: "boom" };
    const res = await call({ password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ ok: false, nameUpdated: false, passwordUpdated: false });
  });
});

describe("PATCH /api/agents/[id] — la contraseña no sale nunca", () => {
  it("ni en los logs ni en la respuesta, aunque GoTrue la repita en su error", async () => {
    admin.passwordError = { message: `La clave ${PASSWORD} está filtrada`, code: "weak_password", status: 422 };

    const ok = await call({ displayName: "Pedro", password: PASSWORD });
    const corta = await call({ password: PASSWORD.slice(0, 5) });

    for (const res of [ok, corta]) expect(res.text).not.toContain(PASSWORD.slice(0, 5));
    expect(logCalls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(PASSWORD.slice(0, 5));
  });

  it("en el camino feliz tampoco", async () => {
    await call({ displayName: "Pedro", password: PASSWORD });
    expect(JSON.stringify(logCalls)).not.toContain(PASSWORD);
  });
});
