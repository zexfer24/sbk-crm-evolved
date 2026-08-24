import type { NextConfig } from "next";

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
