// Regenera los íconos de la app a partir del logo original de SBK Motors
// (public/logo-sbk.jpg, el arte con la moto que usa la empresa):
//
//   node scripts/generar-iconos.mjs
//
//   - src/app/icon.png        512x512 con esquinas redondeadas (pestaña/PWA)
//   - src/app/favicon.ico     16+32+48 en PNG empaquetado (Safari y legado)
//   - src/app/apple-icon.png  180x180 a sangre (iOS recorta y redondea él)
//
// El mismo arte lo muestra la interfaz vía src/components/sbk-logo.tsx; si el
// logo cambia, basta reemplazar public/logo-sbk.jpg y volver a correr esto.
//
// sharp no está en package.json: llega como dependencia de Next. Si algún
// día Next lo suelta, este script es el único que lo extraña.
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const logo = join(raiz, "public", "logo-sbk.jpg");
const appDir = join(raiz, "src", "app");

// Máscara de esquinas redondeadas, proporcional al tamaño: el logo original
// es un cuadrado a sangre y en la pestaña del navegador se ve mejor como la
// placa redondeada que usan las apps.
function mascara(size, radio) {
  return Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radio}" fill="#fff"/></svg>`
  );
}

async function redondeado(size) {
  return sharp(logo)
    .resize(size, size)
    .composite([{ input: mascara(size, Math.round(size * 0.22)), blend: "dest-in" }])
    .png()
    .toBuffer();
}

// ICO: cabecera ICONDIR + una ICONDIRENTRY por imagen + los PNG en crudo.
// PNG embebido vale desde Windows Vista; es lo que produce cualquier
// generador de favicons moderno.
function empaquetarIco(pngs) {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0); // reservado
  cabecera.writeUInt16LE(1, 2); // tipo: ícono
  cabecera.writeUInt16LE(pngs.length, 4);

  const entradas = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // sin paleta
    e.writeUInt8(0, 3); // reservado
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por píxel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entradas.push(e);
    offset += buf.length;
  }
  return Buffer.concat([cabecera, ...entradas, ...pngs.map((p) => p.buf)]);
}

const pngs = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, buf: await redondeado(size) }))
);

writeFileSync(join(appDir, "favicon.ico"), empaquetarIco(pngs));
writeFileSync(join(appDir, "icon.png"), await redondeado(512));
// iOS pone su propia máscara: va cuadrado a sangre, sin redondear.
await sharp(logo).resize(180, 180).png().toFile(join(appDir, "apple-icon.png"));

console.log("Regenerados icon.png, favicon.ico y apple-icon.png desde public/logo-sbk.jpg");
