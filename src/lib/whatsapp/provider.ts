// Fuente ÚNICA de credenciales de WhatsApp (plan "SBK CRM pasa a 360dialog",
// 8/10/2026, D2). Ningún otro archivo de `src/` vuelve a leer
// `WHATSAPP_ACCESS_TOKEN` ni `D360_API_KEY`: todo pasa por acá.
//
// Las variables se leen en CADA llamada, nunca al cargar el módulo, para que
// los tests puedan cambiarlas con `vi.stubEnv` y para que un valor corregido
// en el entorno no dependa del orden de carga de los módulos.
//
// Nunca importar desde un componente cliente: devuelve llaves de API.
import "server-only";

export type WhatsappProvider = "meta" | "360dialog";

export type WhatsappCredentials =
  | { provider: "meta"; accessToken: string; graphVersion: string }
  | { provider: "360dialog"; apiKey: string; baseUrl: string };

export const D360_DEFAULT_BASE_URL = "https://waba-v2.360dialog.io";

const GRAPH_VERSION_POR_DEFECTO = "v21.0";

/**
 * Proveedor configurado. Sin definir (o vacío) es `meta` (D1): el código se
 * puede desplegar antes que la variable y se comporta como hasta el 8/10/2026.
 * Un valor que no sea `meta` ni `360dialog` es configuración rota y devuelve
 * `null` (no hay credencial; el webhook responde 503 y /api/health lo avisa).
 */
export function whatsappProvider(): WhatsappProvider | null {
  const valor = (process.env.WHATSAPP_PROVIDER ?? "").trim().toLowerCase();
  if (valor === "" || valor === "meta") return "meta";
  if (valor === "360dialog") return "360dialog";
  return null;
}

/** `null` si el proveedor es inválido o falta la credencial de ese proveedor. */
export function whatsappCredentials(): WhatsappCredentials | null {
  const provider = whatsappProvider();
  if (provider === "meta") {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    if (!accessToken) return null;
    const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || GRAPH_VERSION_POR_DEFECTO;
    return { provider, accessToken, graphVersion };
  }
  if (provider === "360dialog") {
    const apiKey = process.env.D360_API_KEY?.trim();
    if (!apiKey) return null;
    const baseUrl = (process.env.D360_BASE_URL?.trim() || D360_DEFAULT_BASE_URL).replace(/\/+$/, "");
    return { provider, apiKey, baseUrl };
  }
  return null;
}

/**
 * Nombre de la variable que falta para poder enviar, o `null` si está todo.
 * Sirve para el mensaje de /api/health y para los logs: dice QUÉ falta sin
 * exponer ningún valor.
 */
export function whatsappCredentialProblem(): string | null {
  const provider = whatsappProvider();
  if (provider === null) return "WHATSAPP_PROVIDER";
  if (whatsappCredentials()) return null;
  return provider === "360dialog" ? "D360_API_KEY" : "WHATSAPP_ACCESS_TOKEN";
}
