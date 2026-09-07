/**
 * Redis en memoria, sólo para pruebas.
 *
 * La cola se prueba contra un Redis de verdad (queue.test.ts, redis-queue.test.ts)
 * y así tiene que seguir siendo: la atomicidad de los scripts Lua es la
 * garantía que sostiene "una conversación la atiende un solo proceso", y eso
 * sólo se comprueba contra el intérprete real.
 *
 * Pero esos archivos se saltan enteros donde no hay Redis —`if (!disponible)
 * return`—, y eso deja un hueco: en una máquina sin Redis la suite pasa verde
 * sin haber ejercitado nada de la cola. Es exactamente cómo se coló la carrera
 * del `limit`, que no es de Redis sino de JavaScript: los trabajadores decidían
 * si quedaba presupuesto mirando contadores que sólo suben después del turno.
 *
 * Este doble existe para eso: la lógica de reparto de `processQueuedTurns`, que
 * es JS puro y no necesita Redis para nada más que entregar ids distintos.
 *
 * Los tres scripts se reconocen por su contenido y se reimplementan en JS. Es
 * un doble de la SEMÁNTICA, no del intérprete: si algún día un script cambia
 * de forma, esto deja de reconocerlo y hay que actualizarlo a mano. Por eso
 * no sustituye a las pruebas contra Redis real, las acompaña.
 *
 * 7/9/2026 ("La respuesta llega en siete segundos", T0): el script de
 * reclamo (CLAIM_SCRIPT) ya no devuelve solo el id — devuelve `[id,
 * vencimiento]`, leyendo y sembrando una clave de vencimiento aparte
 * (`liminal:agent:vencimiento:{id}`) para que sobreviva a los reintentos de
 * `defer`. Este doble espeja esa semántica con `strings` (la misma tabla que
 * ya usaba `set`/`incr`), no con un mecanismo nuevo.
 */

function escapeRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Miembro {
  member: string;
  score: number;
}

export class FakeRedis {
  private zsets = new Map<string, Miembro[]>();
  private strings = new Map<string, string>();

  private zset(key: string): Miembro[] {
    let actual = this.zsets.get(key);
    if (!actual) {
      actual = [];
      this.zsets.set(key, actual);
    }
    return actual;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.zset(key);
    const existente = set.find((m) => m.member === member);
    if (existente) {
      existente.score = score;
      return 0;
    }
    set.push({ member, score });
    return 1;
  }

  async zcard(key: string): Promise<number> {
    return this.zset(key).length;
  }

  async zrem(key: string, member: string): Promise<number> {
    const set = this.zset(key);
    const i = set.findIndex((m) => m.member === member);
    if (i === -1) return 0;
    set.splice(i, 1);
    return 1;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    const desde = min === "-inf" ? -Infinity : Number(min);
    const hasta = max === "+inf" ? Infinity : Number(max);
    const set = this.zset(key);
    const antes = set.length;
    this.zsets.set(
      key,
      set.filter((m) => m.score < desde || m.score > hasta)
    );
    return antes - this.zset(key).length;
  }

  async del(key: string): Promise<number> {
    const habia = this.zsets.has(key) || this.strings.has(key);
    this.zsets.delete(key);
    this.strings.delete(key);
    return habia ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const siguiente = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(siguiente));
    return siguiente;
  }

  async expire(): Promise<number> {
    // Los vencimientos no se simulan: ninguna prueba de reparto depende de
    // que algo caduque, y fingir el paso del tiempo daría una falsa sensación
    // de cobertura.
    return 1;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    const soloSiNoExiste = args.includes("NX");
    if (soloSiNoExiste && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const encontrado = this.zset(key).find((m) => m.member === member);
    return encontrado ? String(encontrado.score) : null;
  }

  /**
   * Solo lo necesita `purge` (redis-queue.ts), para barrer las claves de
   * vencimiento (`liminal:agent:vencimiento:*`). Sin paginar de verdad —los
   * dobles de prueba no tienen tantas claves como para que haga falta— pero
   * con la misma forma [cursor, claves] que el cliente real, devolviendo
   * todo en una sola vuelta (cursor final "0").
   */
  async scan(_cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    const matchIdx = args.findIndex((a) => String(a).toUpperCase() === "MATCH");
    const patron = matchIdx !== -1 ? String(args[matchIdx + 1]) : "*";
    const regex = new RegExp(`^${patron.split("*").map(escapeRegExp).join(".*")}$`);
    const claves = [...this.strings.keys(), ...this.zsets.keys()].filter((k) => regex.test(k));
    return ["0", claves];
  }

  /**
   * Reimplementa los scripts de redis-queue.ts, reconocidos por su contenido.
   *
   * Corren de una sola pieza igual que en Redis: como JavaScript no interrumpe
   * una función sin `await`, la atomicidad sale gratis y por el mismo motivo
   * por el que sale en Redis, que es de un solo hilo.
   */
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);

    // CLAIM_SCRIPT: saca el vencido que lleva más tiempo esperando y trae su
    // vencimiento — el guardado de un reintento previo, si lo hay, o si no el
    // score crudo (que además se siembra para el próximo reclamo, ver
    // redis-queue.ts).
    if (script.includes("ZRANGEBYSCORE")) {
      const limite = Number(args[1]);
      const prefijo = String(args[2]);
      const vencidos = this.zset(key)
        .filter((m) => m.score <= limite)
        .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
      if (vencidos.length === 0) return false;
      const elegido = vencidos[0];
      await this.zrem(key, elegido.member);

      const vencKey = `${prefijo}${elegido.member}`;
      const original = await this.get(vencKey);
      if (original !== null) {
        await this.del(vencKey);
        return [elegido.member, original];
      }
      await this.set(vencKey, String(elegido.score));
      return [elegido.member, String(elegido.score)];
    }

    // ACQUIRE_SLOT_SCRIPT y CONSUME_PACE_SCRIPT: limpiar, contar, añadir si cabe.
    if (script.includes("ZREMRANGEBYSCORE")) {
      const [, corte, tope, score, member] = args;
      await this.zremrangebyscore(key, "-inf", Number(corte));
      if (this.zset(key).length >= Number(tope)) return false;
      await this.zadd(key, Number(score), String(member));
      return String(member);
    }

    throw new Error(`FakeRedis: script no reconocido:\n${script}`);
  }
}
