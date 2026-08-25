"use client";

import { useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { SbkMark } from "@/components/sbk-logo";
import "@/components/auth/login.css";

/**
 * A dónde cae un usuario con sesión abierta al que le apagaron el acceso.
 *
 * No puede ser /login: el middleware devuelve a los autenticados de /login a
 * la portada, y la portada devuelve a los desactivados acá — mandarlo a
 * /login sería un rebote infinito. Esta pantalla corta el nudo: cierra la
 * sesión ella misma y explica por qué, en vez de dejar al usuario dando
 * vueltas entre redirects sin ninguna explicación.
 */
export function AccesoDesactivado() {
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.signOut().catch(() => {
      // Sin red no se puede cerrar la sesión, pero las páginas igual no lo
      // dejan pasar: el guardado de acceso corre en el servidor.
    });
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card lm-panel">
        <div className="login-mark" aria-hidden="true">
          <SbkMark size={56} />
        </div>
        <h1 className="login-title lm-display">Acceso desactivado</h1>
        <p className="login-subtitle">
          Un supervisor desactivó tu usuario: no puedes entrar al CRM ni recibir chats de la IA.
          Si crees que es un error, habla con tu supervisor para que te reactive desde Control de IA.
        </p>
        <p className="login-subtitle">
          <Link href="/login" className="font-medium underline underline-offset-2">
            Volver al inicio de sesión
          </Link>
        </p>
      </div>
    </div>
  );
}
