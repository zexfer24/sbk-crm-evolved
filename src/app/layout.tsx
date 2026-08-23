import type { Metadata } from "next";
import { Familjen_Grotesk, Geist, Geist_Mono } from "next/font/google";
import { Toast } from "@heroui/react";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/use-theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Voz de titular del dashboard: se usa solo en itálica y solo para el título
// de la página, para que no compita con la Geist del resto de la interfaz.
const familjenGrotesk = Familjen_Grotesk({
  variable: "--font-familjen-grotesk",
  subsets: ["latin"],
  style: ["italic"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Liminal CRM",
  description: "CRM multiagente para ventas por WhatsApp con automatización de IA",
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
