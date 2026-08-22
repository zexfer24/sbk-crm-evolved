import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empaqueta en .next/standalone solo lo que el servidor necesita para
  // correr, dependencias incluidas. Es lo que permite que la imagen de
  // Docker no arrastre node_modules entero (ver Dockerfile).
  output: "standalone",

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
