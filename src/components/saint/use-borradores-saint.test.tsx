/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BorradorSaint, FilaBorradorSaint } from "@/lib/saint-borradores";
import { borradorDesdeFila } from "@/lib/saint-borradores";
import { useBorradoresSaint } from "@/components/saint/use-borradores-saint";

/**
 * 25/10/2026, plan "Enviar a SAINT", T3: el hook que sigue el ÚLTIMO envío de
 * cada origen. El canal de Realtime y la lectura están falsos: lo que se
 * prueba es el filtro EXACTO que se registra, qué evento reemplaza al
 * estado y cuándo se vuelve a leer.
 */

interface CanalFalso {
  nombre: string;
  suscripciones: { evento: string; opciones: Record<string, unknown>; callback: (payload: { new: unknown }) => void }[];
  estado: ((status: string) => void) | null;
  on: (evento: string, opciones: Record<string, unknown>, callback: (payload: { new: unknown }) => void) => CanalFalso;
  subscribe: (callback: (status: string) => void) => CanalFalso;
}

const canales: CanalFalso[] = [];
const removeChannel = vi.fn();
const supabaseFalso = {
  channel: vi.fn((nombre: string) => {
    const canal: CanalFalso = {
      nombre,
      suscripciones: [],
      estado: null,
      on(evento, opciones, callback) {
        canal.suscripciones.push({ evento, opciones, callback });
        return canal;
      },
      subscribe(callback) {
        canal.estado = callback;
        return canal;
      },
    };
    canales.push(canal);
    return canal;
  }),
  removeChannel: (canal: unknown) => removeChannel(canal),
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => supabaseFalso }));

const fetchUltimosBorradores = vi.fn();
vi.mock("@/lib/saint-borradores-data", () => ({
  fetchUltimosBorradores: (...args: unknown[]) => fetchUltimosBorradores(...args),
}));

function fila(over: Partial<FilaBorradorSaint> = {}): FilaBorradorSaint {
  return {
    id: "b-1",
    origen: "presupuesto",
    origen_id: "pr-1",
    creado_por: "agente-1",
    cedula_tipo: "V",
    cedula_numero: "12345678",
    nombre: "María",
    apellido: "Pérez",
    telefono: "04141234567",
    estado: "pendiente",
    numero_saint: null,
    codclie: null,
    cliente_creado: null,
    error: null,
    created_at: "2026-10-25T14:00:00.000Z",
    procesado_at: null,
    ...over,
  };
}

function mapa(...filas: FilaBorradorSaint[]): Map<string, BorradorSaint> {
  return new Map(filas.map((f) => [f.origen_id, borradorDesdeFila(f)]));
}

function evento(canal: CanalFalso, nueva: FilaBorradorSaint) {
  act(() => {
    canal.suscripciones[0].callback({ new: nueva });
  });
}

beforeEach(() => {
  canales.length = 0;
  removeChannel.mockReset();
  supabaseFalso.channel.mockClear();
  fetchUltimosBorradores.mockReset();
  fetchUltimosBorradores.mockResolvedValue(new Map());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBorradoresSaint — carga y canal", () => {
  it("carga los envíos con los ids pedidos y los expone por origen", async () => {
    fetchUltimosBorradores.mockResolvedValue(mapa(fila()));
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));

    await waitFor(() => expect(result.current.porOrigen.get("pr-1")?.estado).toBe("pendiente"));
    expect(fetchUltimosBorradores).toHaveBeenCalledWith(supabaseFalso, ["pr-1"]);
  });

  it("con UN id filtra el canal por origen_id, en el esquema liminal", async () => {
    renderHook(() => useBorradoresSaint("carrito", ["conv-1"]));

    await waitFor(() => expect(canales).toHaveLength(1));
    expect(canales[0].suscripciones).toHaveLength(1);
    expect(canales[0].suscripciones[0].evento).toBe("postgres_changes");
    expect(canales[0].suscripciones[0].opciones).toEqual({
      event: "*",
      schema: "liminal",
      table: "saint_borradores",
      filter: "origen_id=eq.conv-1",
    });
  });

  it("con VARIOS ids filtra por origen=eq.presupuesto", async () => {
    renderHook(() => useBorradoresSaint("presupuesto", ["pr-1", "pr-2"]));

    await waitFor(() => expect(canales).toHaveLength(1));
    expect(canales[0].suscripciones[0].opciones).toEqual({
      event: "*",
      schema: "liminal",
      table: "saint_borradores",
      filter: "origen=eq.presupuesto",
    });
  });

  it("el nombre del canal incluye el origen", async () => {
    renderHook(() => useBorradoresSaint("presupuesto", ["pr-1", "pr-2"]));

    await waitFor(() => expect(canales).toHaveLength(1));
    expect(canales[0].nombre).toMatch(/^saint-borradores-presupuesto-/);
  });

  it("sin ids no lee la base ni abre canal", async () => {
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", []));

    await Promise.resolve();
    expect(fetchUltimosBorradores).not.toHaveBeenCalled();
    expect(supabaseFalso.channel).not.toHaveBeenCalled();
    expect(result.current.porOrigen.size).toBe(0);
  });

  it("una lista de ids con el mismo contenido pero otro arreglo no reabre el canal", async () => {
    const { rerender } = renderHook(({ ids }) => useBorradoresSaint("presupuesto", ids), {
      initialProps: { ids: ["pr-2", "pr-1"] },
    });
    await waitFor(() => expect(canales).toHaveLength(1));

    rerender({ ids: ["pr-1", "pr-2"] });
    await Promise.resolve();

    expect(canales).toHaveLength(1);
    expect(fetchUltimosBorradores).toHaveBeenCalledTimes(1);
    expect(removeChannel).not.toHaveBeenCalled();
  });

  it("si la carga falla deja el mapa vacío y lo registra en consola", async () => {
    fetchUltimosBorradores.mockRejectedValue(new Error("sin red"));
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));

    await waitFor(() => expect(console.error).toHaveBeenCalledWith("saint_borradores_no_cargados", expect.any(Error)));
    expect(result.current.porOrigen.size).toBe(0);
  });

  it("al desmontar quita el canal", async () => {
    const { unmount } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(canales).toHaveLength(1));

    unmount();

    expect(removeChannel).toHaveBeenCalledWith(canales[0]);
  });
});

describe("useBorradoresSaint — eventos", () => {
  it("un INSERT/UPDATE de un origen pedido reemplaza al actual si es más nuevo o igual", async () => {
    fetchUltimosBorradores.mockResolvedValue(mapa(fila()));
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(result.current.porOrigen.size).toBe(1));

    // Mismo envío que avanza de estado (misma created_at): reemplaza.
    evento(canales[0], fila({ estado: "creado", numero_saint: "FAC-77", procesado_at: "2026-10-25T14:01:00.000Z" }));
    expect(result.current.porOrigen.get("pr-1")?.estado).toBe("creado");
    expect(result.current.porOrigen.get("pr-1")?.numeroSaint).toBe("FAC-77");

    // Un reenvío posterior: reemplaza.
    evento(canales[0], fila({ id: "b-2", created_at: "2026-10-25T15:00:00.000Z", estado: "pendiente" }));
    expect(result.current.porOrigen.get("pr-1")?.id).toBe("b-2");
  });

  it("un evento más VIEJO que el actual no lo reemplaza", async () => {
    fetchUltimosBorradores.mockResolvedValue(mapa(fila({ id: "b-2", created_at: "2026-10-25T15:00:00.000Z" })));
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(result.current.porOrigen.size).toBe(1));

    evento(canales[0], fila({ id: "b-1", created_at: "2026-10-25T14:00:00.000Z", estado: "error", error: "viejo" }));

    expect(result.current.porOrigen.get("pr-1")?.id).toBe("b-2");
  });

  it("un evento de un origen que no se pidió se ignora", async () => {
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1", "pr-2"]));
    await waitFor(() => expect(canales).toHaveLength(1));

    evento(canales[0], fila({ origen_id: "pr-99" }));

    expect(result.current.porOrigen.size).toBe(0);
  });

  it("un evento de OTRO tipo de origen con el mismo id se ignora", async () => {
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["x-1"]));
    await waitFor(() => expect(canales).toHaveLength(1));

    evento(canales[0], fila({ origen: "carrito", origen_id: "x-1" }));

    expect(result.current.porOrigen.size).toBe(0);
  });

  it("sin envío previo, un evento lo agrega", async () => {
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(canales).toHaveLength(1));

    evento(canales[0], fila());

    expect(result.current.porOrigen.get("pr-1")?.estado).toBe("pendiente");
  });
});

describe("useBorradoresSaint — resincronización", () => {
  it("al volver a SUBSCRIBED tras un corte lee de nuevo; la primera conexión no", async () => {
    renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(canales).toHaveLength(1));
    expect(fetchUltimosBorradores).toHaveBeenCalledTimes(1);

    act(() => canales[0].estado?.("SUBSCRIBED"));
    expect(fetchUltimosBorradores).toHaveBeenCalledTimes(1);

    act(() => canales[0].estado?.("CHANNEL_ERROR"));
    act(() => canales[0].estado?.("SUBSCRIBED"));

    await waitFor(() => expect(fetchUltimosBorradores).toHaveBeenCalledTimes(2));
  });

  it("recargar() vuelve a leer", async () => {
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await waitFor(() => expect(fetchUltimosBorradores).toHaveBeenCalledTimes(1));

    act(() => result.current.recargar());

    await waitFor(() => expect(fetchUltimosBorradores).toHaveBeenCalledTimes(2));
  });
});

describe("useBorradoresSaint — el reloj", () => {
  it("con un envío pendiente `ahora` avanza cada 15 s", async () => {
    vi.useFakeTimers();
    fetchUltimosBorradores.mockResolvedValue(mapa(fila()));
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.porOrigen.get("pr-1")?.estado).toBe("pendiente");
    const antes = result.current.ahora.getTime();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current.ahora.getTime()).toBeGreaterThanOrEqual(antes + 15_000);
  });

  it("sin nada pendiente `ahora` no se mueve", async () => {
    vi.useFakeTimers();
    fetchUltimosBorradores.mockResolvedValue(
      mapa(fila({ estado: "creado", numero_saint: "FAC-1", procesado_at: "2026-10-25T14:01:00.000Z" })),
    );
    const { result } = renderHook(() => useBorradoresSaint("presupuesto", ["pr-1"]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.porOrigen.get("pr-1")?.estado).toBe("creado");
    const antes = result.current.ahora.getTime();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.ahora.getTime()).toBe(antes);
  });
});
