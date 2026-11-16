import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toast } from "@heroui/react";
import "./globals.css";
import { APP_TITLE } from "@/lib/brand";
import { THEME_BOOT_SCRIPT } from "@/lib/use-theme";

// Las tres fuentes se sirven desde `src/app/fuentes/`, no desde Google Fonts.
// Con `next/font/google` el build de producción estuvo roto desde el 8/11/2026:
// según el servidor y el momento, Google responde URLs `/l/font?kit=…&skey=…`
// y el Turbopack de Next 16.3.1 las parte por `&` ("queries have exactly one
// entry"); la caché de `.next` lo escondía. Los woff2 son los mismos bytes que
// precargaba Google (solo el subconjunto latino); fuera del latín, la letra cae
// a la fuente de respaldo (Arial). `weight: "500 700"` en Familjen reproduce las
// caras 500/600/700 de antes (un 400 sigue cayendo a 500). `display` y `preload`
// quedan en su default (swap, true), igual que antes.
const geistSans = localFont({
  variable: "--font-geist-sans",
  src: "./fuentes/geist-latin.woff2",
  weight: "100 900",
  style: "normal",
});

const geistMono = localFont({
  variable: "--font-geist-mono",
  src: "./fuentes/geist-mono-latin.woff2",
  weight: "100 900",
  style: "normal",
});

// Voz de titular del dashboard: se usa solo en itálica y solo para el título
// de la página, para que no compita con la Geist del resto de la interfaz.
const familjenGrotesk = localFont({
  variable: "--font-familjen-grotesk",
  src: "./fuentes/familjen-grotesk-italic-latin.woff2",
  weight: "500 700",
  style: "italic",
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description: "CRM multiagente para ventas por WhatsApp con automatización de IA",
};

// El color de la interfaz del navegador (barra de pestañas en móvil, marco en
// PWA) acompaña al lienzo en vez de quedarse blanco. Sigue al sistema, no al
// interruptor de la app: es lo único que estas media queries saben ver.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e7e9f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c12" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${familjenGrotesk.variable} h-full antialiased`}
    >
      <head>
        {/* Antes de la primera pintura, no después: si el tema se aplicara al
            hidratar, una recarga en modo oscuro mostraría un fogonazo blanco.
            `suppressHydrationWarning` en <html> porque este script le cambia
            los atributos al nodo que React va a hidratar. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full h-full flex flex-col bg-background text-foreground">
        {children}
        <Toast.Provider placement="top end" />
      </body>
    </html>
  );
}
