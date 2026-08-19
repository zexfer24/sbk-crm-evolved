"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@heroui/react";
import { MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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
          <MessageCircle size={22} />
        </div>
        <h1 className="login-title lm-display">Liminal CRM</h1>
        <p className="login-subtitle">Inicia sesión para entrar a la bandeja de entrada</p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <Label htmlFor="email">Correo</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="jose@liminal.test"
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
            {isLoading ? "Entrando..." : "Entrar"}
          </Button>
        </form>

        <p className="login-demo">
          Demo local: jose@liminal.test · maria@liminal.test · carlos@liminal.test
          <br />
          Contraseña: Liminal123!
        </p>
      </div>
    </div>
  );
}
