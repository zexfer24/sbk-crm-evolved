import "server-only";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Conexión compartida a Redis.
//
// Una sola por proceso: cada instancia de ioredis abre su propio socket y
// mantiene su propio reconectador, así que crear una por llamada dejaría
// conexiones colgando en cada mensaje que entra.
// ---------------------------------------------------------------------------

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    // Sin Redis no hay cola, y sin cola el agente no atiende a nadie. Es
    // mejor fallar acá, con el nombre de la variable que falta, que
    // descubrirlo cuando un cliente se quedó sin respuesta.
    throw new Error("Falta REDIS_URL: la cola de turnos del agente no puede funcionar sin Redis.");
  }

  client = new Redis(url, {
    // El webhook responde a Meta antes de tocar la cola, así que un Redis
    // lento no debe dejar la petición colgada: falla y el cron recoge.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  return client;
}
