// El paquete real `server-only` revienta si se importa fuera de un Server
// Component de Next.js. En tests corremos código de servidor directamente
// (sin el runtime de Next.js detrás), así que lo sustituimos por un no-op.
export {};
