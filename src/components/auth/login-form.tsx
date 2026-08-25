"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@heroui/react";
import { createClient } from "@/lib/supabase/client";
import { SbkMark } from "@/components/sbk-logo";
import "@/components/auth/login.css";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setIsLoading(false);

    if (signInError) {
      setError("Correo o contraseña incorrectos.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="login-screen">
      <div className="login-card lm-panel">
        <div className="login-mark" aria-hidden="true">
          <SbkMark size={56} />
        </div>
        <h1 className="login-title lm-display">SBK Motorcycles CRM</h1>
        <p className="login-subtitle">Inicia sesión para entrar a la bandeja de entrada</p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <Label htmlFor="email">Correo</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="nombre@sbk.motorcycles"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              fullWidth
            />
          </div>
          <div className="login-field">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              fullWidth
            />
          </div>

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" fullWidth isDisabled={isLoading}>
            {isLoading && <span className="login-spinner" aria-hidden="true" />}
            {isLoading ? "Entrando..." : "Entrar"}
          </Button>
        </form>

        {/* Acá vivían las credenciales de demo. Se quitaron: publicarlas en
            la puerta de entrada del CRM entregaba tres cuentas válidas a
            cualquiera que abriera la página.

            No alcanzó con esconderlas tras `NODE_ENV !== "production"` —
            comprobado buscándolas en el bundle compilado, seguían ahí. Un
            literal que está en el código puede terminar en el navegador,
            así que la única garantía es que no esté.

            Las de desarrollo están en el README. */}
      </div>
    </div>
  );
}
