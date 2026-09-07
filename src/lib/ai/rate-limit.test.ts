import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { rateLimitMiddleware, resetRitmoParaPruebas } from "@/lib/ai/rate-limit";
import { log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El control de ritmo es lo único que hay entre un pico de mensajes y el 429
// en cadena, así que conviene que sus dos frenos estén probados por separado.
//
// Los topes se ponen bajos a propósito: hacen visible el límite sin que la
// prueba tarde un minuto real.
// ---------------------------------------------------------------------------

type Generar = () => PromiseLike<unknown>;

/** Llama al middleware como lo llama el SDK cuando el modelo genera. */
function generarCon(middleware: ReturnType<typeof rateLimitMiddleware>, doGenerate: Generar) {
  return middleware.wrapGenerate!({
    doGenerate,
    doStream: (() => {
      throw new Error("no se usa");
    }) as never,
    params: {} as never,
    model: {} as never,
  } as never);
}

function rateLimit(retryAfter?: string): APICallError {
  return new APICallError({
    message: "Rate limit exceeded: new-account-rpm/openai/gpt-5.6-luna-20260709.",
    url: "https://ejemplo/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });
}

beforeEach(() => {
  resetRitmoParaPruebas();
  delete process.env.AI_MAX_CONCURRENT_REQUESTS;
  delete process.env.AI_MAX_REQUESTS_PER_MINUTE;
});

afterEach(() => {
  resetRitmoParaPruebas();
  delete process.env.AI_MAX_CONCURRENT_REQUESTS;
  delete process.env.AI_MAX_REQUESTS_PER_MINUTE;
});

describe("freno de concurrencia", () => {
  /**
   * Sin esto, un pico de mensajes se convierte en tantas peticiones
   * simultáneas como turnos haya abiertos. El tope de turnos no alcanzaba: un
   * turno solo puede tener siete peticiones en vuelo a lo largo de su vida.
   */
  it("no deja más peticiones en vuelo que el tope", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "2";
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let enVuelo = 0;
    let pico = 0;
    const generar = async () => {
      enVuelo++;
      pico = Math.max(pico, enVuelo);
      await new Promise((r) => setTimeout(r, 20));
      enVuelo--;
      return "listo";
    };

    await Promise.all(Array.from({ length: 6 }, () => generarCon(middleware, generar)));

    expect(pico).toBeLessThanOrEqual(2);
  });

  /** Un fallo no puede dejarse el cupo puesto: a los pocos errores el sistema se cerraría. */
  it("devuelve el cupo aunque la petición reviente", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "1";
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    await expect(
      generarCon(middleware, async () => {
        throw new Error("se cayó el proveedor");
      })
    ).rejects.toThrow("se cayó el proveedor");

    // Si el cupo hubiera quedado retenido, esta segunda llamada no volvería.
    await expect(generarCon(middleware, async () => "listo")).resolves.toBe("listo");
  });
});

describe("freno de ritmo", () => {
  /**
   * El tope por minuto es el que de verdad evita el 429: es la unidad en la
   * que el proveedor cuenta. La quinta petición con tope de cuatro tiene que
   * quedarse esperando, no salir.
   */
  it("frena la petición que se pasa del tope por minuto", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "10";
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "4";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let emitidas = 0;
    const generar = async () => {
      emitidas++;
      return "listo";
    };

    const enCurso = Promise.all(Array.from({ length: 6 }, () => generarCon(middleware, generar)));

    // Se le da margen de sobra para que salga todo lo que puede salir.
    await new Promise((r) => setTimeout(r, 100));
    expect(emitidas).toBe(4);

    // Las dos frenadas siguen vivas, esperando a que se abra la ventana.
    void enCurso;
  });
});

describe("los topes salen del entorno", () => {
  /**
   * 7/9/2026: el "15 contra 20" viejo era el techo de la cuenta gratuita de
   * OpenRouter, que ya no aplica a producción (`is_free_tier: false`,
   * `limit: null`). Los dos frenos siguen leyéndose del entorno, solo cambia
   * a qué valor caen sin variable — eso lo prueba el describe de más abajo.
   */
  it("AI_MAX_CONCURRENT_REQUESTS de uno deja pasar una petición a la vez", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "1";
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let enVuelo = 0;
    let pico = 0;
    const generar = async () => {
      enVuelo++;
      pico = Math.max(pico, enVuelo);
      await new Promise((r) => setTimeout(r, 20));
      enVuelo--;
      return "listo";
    };

    await Promise.all(Array.from({ length: 4 }, () => generarCon(middleware, generar)));

    expect(pico).toBe(1);
  });

  /**
   * Con AI_MAX_REQUESTS_PER_MINUTE=2 la tercera petición no puede salir
   * dentro de la ventana: se queda dormida en reservarHueco y avisa
   * `ia_ritmo_al_tope`. No se espera el minuto real —el test solo confirma
   * que la promesa sigue viva a los pocos ms y que el warn ya salió—, mismo
   * patrón que "frena la petición que se pasa del tope por minuto" de arriba.
   */
  it("AI_MAX_REQUESTS_PER_MINUTE de dos frena la tercera y avisa ia_ritmo_al_tope", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "10";
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "2";
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let emitidas = 0;
    const generar = async () => {
      emitidas++;
      return "listo";
    };

    const enCurso = Promise.all(Array.from({ length: 3 }, () => generarCon(middleware, generar)));

    await new Promise((r) => setTimeout(r, 50));
    expect(emitidas).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith("ia_ritmo_al_tope", expect.objectContaining({ tope: 2 }));

    // La tercera sigue viva, esperando a que se abra la ventana.
    void enCurso;
    warnSpy.mockRestore();
  });
});

describe("sin variables en el entorno", () => {
  /**
   * Documenta el cambio del 7/9/2026: los defaults pasan de 3/15 a 12/120.
   * Se afirma con comportamiento (no hay export de solo lectura para esto):
   * con AI_MAX_CONCURRENT_REQUESTS ausente, la petición 12 sale junto con las
   * primeras once y la 13 se queda esperando cupo.
   */
  it("el default de concurrencia es doce", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "1000";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let enVuelo = 0;
    let pico = 0;
    const generar = async () => {
      enVuelo++;
      pico = Math.max(pico, enVuelo);
      await new Promise((r) => setTimeout(r, 30));
      enVuelo--;
      return "listo";
    };

    await Promise.all(Array.from({ length: 20 }, () => generarCon(middleware, generar)));

    expect(pico).toBe(12);
  });

  /**
   * Mismo método que "frena la petición que se pasa del tope por minuto":
   * sin AI_MAX_REQUESTS_PER_MINUTE, la petición 121 tiene que quedarse
   * esperando y las primeras 120 salir.
   */
  it("el default de ritmo es ciento veinte por minuto", async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = "1000";
    const middleware = rateLimitMiddleware({ fase: "prueba" });

    let emitidas = 0;
    const generar = async () => {
      emitidas++;
      return "listo";
    };

    const enCurso = Promise.all(Array.from({ length: 121 }, () => generarCon(middleware, generar)));

    await new Promise((r) => setTimeout(r, 150));
    expect(emitidas).toBe(120);

    void enCurso;
  });
});

describe("reintentos", () => {
  /** Solo la clasificación pide reintentos, y solo ante rate limit. */
  it("reintenta el 429 y devuelve el resultado del intento que pasa", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "clasificar", reintentos: 2 });

    let intentos = 0;
    const generar = async () => {
      intentos++;
      // retry-after 0: la prueba no espera segundos reales, pero el camino
      // que recorre es el mismo.
      if (intentos < 3) throw rateLimit("0");
      return "clasificado";
    };

    await expect(generarCon(middleware, generar)).resolves.toBe("clasificado");
    expect(intentos).toBe(3);
  });

  /**
   * Reintentar la redacción es reintentar el camino que termina en un envío.
   * Sin clave de idempotencia eso puede duplicarle el mensaje al cliente, así
   * que el modelo del agente pide cero reintentos y el 429 sube tal cual.
   */
  it("no reintenta cuando no se le pidieron reintentos", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "redactar" });

    let intentos = 0;
    const generar = async () => {
      intentos++;
      throw rateLimit("0");
    };

    await expect(generarCon(middleware, generar)).rejects.toBeInstanceOf(APICallError);
    expect(intentos).toBe(1);
  });

  /** Un error que no es de cuota no se repite: repetirlo solo gasta cuota. */
  it("no reintenta un error que no es rate limit", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "clasificar", reintentos: 3 });

    let intentos = 0;
    const generar = async () => {
      intentos++;
      throw new Error("el prompt no es válido");
    };

    await expect(generarCon(middleware, generar)).rejects.toThrow("el prompt no es válido");
    expect(intentos).toBe(1);
  });

  /**
   * El proveedor sabe cuándo se le abre la ventana; nosotros solo lo
   * estimamos. Si lo dice, se le hace caso — y si pide más de lo que
   * esperaríamos, la espera crece, no se recorta.
   */
  it("espera lo que pide Retry-After en vez de su propio backoff", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "clasificar", reintentos: 1 });

    let intentos = 0;
    const generar = async () => {
      intentos++;
      if (intentos === 1) throw rateLimit("0.2");
      return "clasificado";
    };

    const arranque = Date.now();
    await expect(generarCon(middleware, generar)).resolves.toBe("clasificado");
    const transcurrido = Date.now() - arranque;

    // 0,2 s de Retry-After. El backoff propio habría sido 5 s.
    expect(transcurrido).toBeGreaterThanOrEqual(180);
    expect(transcurrido).toBeLessThan(4000);
  });

  /** Un 429 sin Retry-After cae al backoff propio, que se mide en segundos. */
  it("usa su backoff en segundos cuando el proveedor no dice nada", async () => {
    process.env.AI_MAX_REQUESTS_PER_MINUTE = "100";
    const middleware = rateLimitMiddleware({ fase: "clasificar", reintentos: 1 });

    vi.useFakeTimers();
    try {
      let intentos = 0;
      const generar = async () => {
        intentos++;
        if (intentos === 1) throw rateLimit();
        return "clasificado";
      };

      const enCurso = generarCon(middleware, generar);

      // Cuatro segundos no alcanzan: la primera espera arranca en cinco.
      await vi.advanceTimersByTimeAsync(4000);
      expect(intentos).toBe(1);

      // Ocho cubren los cinco de base más el desorden que se le suma.
      await vi.advanceTimersByTimeAsync(8000);
      await expect(enCurso).resolves.toBe("clasificado");
      expect(intentos).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
