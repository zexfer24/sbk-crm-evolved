import type { NextConfig } from "next";
import { deploymentIdDesde } from "./src/lib/deployment-id";

// Identificador de ESTE build, para la protección contra desfase de versiones
// (13/10/2026). Tras cada despliegue, una pestaña abierta con el JavaScript
// viejo llamaba Server Actions con ids de la versión anterior y producción
// registraba `Server Reference ID did not match`. Con un `deploymentId` Next
// pone `?dpl=<id>` a los assets, manda `x-deployment-id` en cada navegación y,
// si el id del cliente no es el del servidor, recarga la página completa
// (docs: 01-app/03-api-reference/05-config/01-next-config-js/deploymentId.md).
//
// Build y servidor tienen que compartir el MISMO id, y con `output:
// "standalone"` lo comparten solo: `next build` serializa la configuración ya
// evaluada dentro de `.next/standalone/server.js` (`nextConfig = {...}`) y el
// servidor la lee tal cual (`__NEXT_PRIVATE_STANDALONE_CONFIG`) sin volver a
// ejecutar este archivo, así que un timestamp de respaldo NO se recalcula al
// arrancar. Lo que sí podía romperse es que el propio build evalúe este
// archivo más de una vez (workers) y saque dos timestamps distintos; por eso el
// id resuelto se escribe en `NEXT_DEPLOYMENT_ID`: toda evaluación posterior,
// en este proceso o en los hijos que heredan el entorno, reutiliza el mismo.
//
// Solo en producción: en `next dev` un id de timestamp no aporta nada.
const deploymentId =
  process.env.NODE_ENV === "production"
    ? deploymentIdDesde(process.env, new Date())
    : undefined;
if (deploymentId) process.env.NEXT_DEPLOYMENT_ID = deploymentId;

// Las mismas cabeceras que ponía el Caddyfile. Detrás del Traefik de Dokploy
// no hay Caddy que las añada, y Traefik no las pone por su cuenta: puestas
// acá viajan igual sea cual sea el proxy que haya delante.
const cabecerasDeSeguridad = [
  // El CRM no se muestra dentro de un iframe ajeno.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// HSTS: un año, subdominios incluidos. Solo en producción, porque el
// navegador lo recuerda: emitirla desde un túnel de demo deja ese dominio
// forzado a HTTPS durante un año, y eso no se deshace desde el servidor.
const hsts = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};

const nextConfig: NextConfig = {
  // Empaqueta en .next/standalone solo lo que el servidor necesita para
  // correr, dependencias incluidas. Es lo que permite que la imagen de
  // Docker no arrastre node_modules entero (ver Dockerfile).
  output: "standalone",

  // Ver arriba: protección contra desfase de versiones entre pestañas viejas
  // y el servidor recién desplegado.
  deploymentId,

  // `X-Powered-By: Next.js` delata el framework sin darle nada al usuario.
  poweredByHeader: false,

  experimental: {
    // Cuánto vale lo que ya se trajo del servidor antes de volver a pedirlo.
    //
    // Todas las rutas del CRM son dinámicas, y ahí el valor por defecto es 0:
    // saltar a Clientes y volver a Bandeja rearma la bandeja entera desde
    // cero, aunque hayan pasado tres segundos. Con 30s ese ida y vuelta es
    // inmediato, que es como el asesor usa el CRM de verdad — salta entre
    // secciones todo el tiempo.
    //
    // 30s y no más porque la bandeja es un dato vivo. Aun así no se queda
    // vieja: mientras está montada, las suscripciones de realtime la
    // mantienen al día, así que esto solo cubre el hueco de la navegación.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers:
          process.env.NODE_ENV === "production"
            ? [...cabecerasDeSeguridad, hsts]
            : cabecerasDeSeguridad,
      },
    ];
  },

  // Dominios desde los que se permite cargar los recursos de desarrollo
  // (/_next/static, HMR). Next los bloquea por defecto para cualquier origen
  // que no sea localhost: sin esto, una demo por túnel sirve el HTML pero no
  // el JavaScript, así que la página carga y el formulario no hace nada.
  //
  // Solo afecta a `next dev`. En producción no se usa, y por eso vive detrás
  // de una variable: la lista de túneles cambia en cada demo y no tiene por
  // qué quedar escrita en el repositorio.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",").map((h) => h.trim()) ?? [],
};

export default nextConfig;
