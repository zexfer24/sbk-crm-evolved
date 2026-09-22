import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Caracterización de `/api/media/[...path]`: el único portón del bucket
 * privado `whatsapp-media`. Sin sesión no hay firma (401, y ni se instancia
 * el cliente admin); con sesión pero sin fila en `agents` tampoco (403,
 * fallando cerrado incluso si la consulta trae error); con las dos cosas,
 * el path que llega en `context.params` (una PROMESA en Next 16) se une con
 * "/" y se firma tal cual contra Supabase Storage, y la ruta responde con
 * una redirección 307 a esa URL firmada.
 *
 * Estos tests no arreglan defectos, los dejan por escrito — ver el caso de
 * `..` al final.
 */

type MaybeSingleResult = { data: { id: string } | null; error: { message: string } | null };
type SignedUrlResult = { data: { signedUrl: string } | null; error: { message: string } | null };

let sessionValue: { user: { id: string } } | null;
let agentQueryResult: MaybeSingleResult;
/** Argumentos con los que se llamó `.eq(...)` sobre `agents`. */
const agentEqCalls: Array<[string, unknown]> = [];
/** T7 (22/9/2026): simula un corte real de `getSession()`, no una sesión ausente. */
let getSessionShouldThrow = false;

function createFakeServerClient() {
  return {
    auth: {
      getSession: async () => {
        if (getSessionShouldThrow) throw new Error("conexión con Supabase Auth caída");
        return { data: { session: sessionValue } };
      },
    },
    from(table: string) {
      if (table !== "agents") throw new Error(`Tabla inesperada en el test: ${table}`);
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              agentEqCalls.push([column, value]);
              return {
                maybeSingle: async () => agentQueryResult,
              };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => createFakeServerClient()),
}));

let signedUrlResult: SignedUrlResult;
/** `[bucket]` de cada llamada a `storage.from(...)`. */
const storageFromCalls: string[] = [];
/** `[objectPath, ttlSeconds]` de cada llamada a `createSignedUrl(...)`. */
const createSignedUrlCalls: Array<[string, number]> = [];

const createAdminClientMock = vi.fn(() => ({
  storage: {
    from(bucket: string) {
      storageFromCalls.push(bucket);
      return {
        createSignedUrl: async (objectPath: string, ttlSeconds: number) => {
          createSignedUrlCalls.push([objectPath, ttlSeconds]);
          return signedUrlResult;
        },
      };
    },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

/** Eventos registrados por cada llamada a `log.warn`/`log.error` en el test. */
const logCalls: Array<{ level: "warn" | "error"; event: string; context?: Record<string, unknown> }> = [];

vi.mock("@/lib/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log")>();
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "warn", event, context });
      },
      error: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "error", event, context });
      },
    },
  };
});

import { GET } from "./route";

/** `_request` no lo lee la ruta: todo sale de `context.params`, que en Next 16 es una promesa. */
function callGet(path: string[]) {
  return GET(new Request("http://localhost/api/media/x"), { params: Promise.resolve({ path }) });
}

beforeEach(() => {
  sessionValue = { user: { id: "agent-1" } };
  agentQueryResult = { data: { id: "agent-1" }, error: null };
  signedUrlResult = {
    data: {
      signedUrl:
        "https://supabase.example/storage/v1/object/sign/whatsapp-media/conv-1/wamid.abc.jpg?token=firmado",
    },
    error: null,
  };
  agentEqCalls.length = 0;
  storageFromCalls.length = 0;
  createSignedUrlCalls.length = 0;
  createAdminClientMock.mockClear();
  logCalls.length = 0;
  getSessionShouldThrow = false;
});

describe("GET /api/media/[...path] — el único portón del bucket privado", () => {
  it("sin sesión responde 401 y no instancia el cliente admin: nada se firma", async () => {
    sessionValue = null;

    const res = await callGet(["conv-1", "wamid.abc.jpg"]);

    expect(res.status).toBe(401);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("con sesión pero sin fila en agents responde 403 sin firmar", async () => {
    agentQueryResult = { data: null, error: null };

    const res = await callGet(["conv-1", "wamid.abc.jpg"]);

    expect(res.status).toBe(403);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("si la consulta a agents trae error, falla cerrado con 403 sin firmar", async () => {
    agentQueryResult = { data: null, error: { message: "conexión rota" } };

    const res = await callGet(["conv-1", "wamid.abc.jpg"]);

    expect(res.status).toBe(403);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("consulta agents por el id de la sesión, no por uno elegido por quien pide", async () => {
    await callGet(["conv-1", "wamid.abc.jpg"]);

    expect(agentEqCalls).toContainEqual(["id", "agent-1"]);
  });

  it("camino feliz: 307 con Location = la URL firmada, firmada sobre whatsapp-media con TTL 60", async () => {
    const res = await callGet(["conv-1", "wamid.abc.jpg"]);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(signedUrlResult.data!.signedUrl);
    expect(storageFromCalls).toContain("whatsapp-media");
    expect(createSignedUrlCalls).toContainEqual(["conv-1/wamid.abc.jpg", 60]);
  });

  it("un path de varios segmentos se une con '/' en el orden recibido", async () => {
    await callGet(["conv-1", "sub", "wamid.abc.jpg"]);

    expect(createSignedUrlCalls).toContainEqual(["conv-1/sub/wamid.abc.jpg", 60]);
  });

  it("archivo inexistente (storage sin datos y con error) responde 404 sin redirección", async () => {
    signedUrlResult = { data: null, error: { message: "Object not found" } };

    const res = await callGet(["conv-1", "no-existe.jpg"]);

    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  // DEFECTO CONOCIDO (D5): la ruta no sanea el path; la contención real es Supabase Storage + la sesión.
  it("un path con '..' viaja tal cual a createSignedUrl, sin sanear", async () => {
    await callGet(["..", "otro-bucket", "archivo"]);

    expect(createSignedUrlCalls).toContainEqual(["../otro-bucket/archivo", 60]);
  });

  /**
   * T7, plan "Nada se pierde en un corte ni en un deploy" (22/9/2026): antes
   * ninguna rama de esta ruta dejaba rastro — un 401/403/404/500 real
   * contra un asesor no aparecía en ningún log filtrable por evento.
   */
  describe("cada rama deja su evento en el log", () => {
    it("sin sesión registra media.sin_sesion (warn)", async () => {
      sessionValue = null;

      await callGet(["conv-1", "wamid.abc.jpg"]);

      expect(logCalls).toContainEqual({ level: "warn", event: "media.sin_sesion", context: undefined });
    });

    it("sin fila en agents registra media.sin_acceso (warn) con el userId de la sesión", async () => {
      agentQueryResult = { data: null, error: null };

      await callGet(["conv-1", "wamid.abc.jpg"]);

      expect(logCalls).toContainEqual({
        level: "warn",
        event: "media.sin_acceso",
        context: { userId: "agent-1" },
      });
    });

    it("un error de Storage al firmar registra media.no_firmado (error) con el path y el detalle", async () => {
      signedUrlResult = { data: null, error: { message: "Object not found" } };

      await callGet(["conv-1", "no-existe.jpg"]);

      expect(logCalls).toContainEqual({
        level: "error",
        event: "media.no_firmado",
        context: { path: "conv-1/no-existe.jpg", detail: "Object not found" },
      });
    });

    it("una excepción en getSession responde 500 y registra media.fallo (error)", async () => {
      getSessionShouldThrow = true;

      const res = await callGet(["conv-1", "wamid.abc.jpg"]);

      expect(res.status).toBe(500);
      expect(createAdminClientMock).not.toHaveBeenCalled();
      expect(logCalls).toContainEqual({
        level: "error",
        event: "media.fallo",
        context: { path: undefined, detail: "conexión con Supabase Auth caída" },
      });
    });
  });
});
