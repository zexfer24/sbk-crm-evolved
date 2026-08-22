import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empaqueta en .next/standalone solo lo que el servidor necesita para
  // correr, dependencias incluidas. Es lo que permite que la imagen de
  // Docker no arrastre node_modules entero (ver Dockerfile).
  output: "standalone",
};

export default nextConfig;
