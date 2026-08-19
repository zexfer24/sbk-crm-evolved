"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input, Label } from "@heroui/react";
import { MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

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
    <div className="min-h-screen w-full flex items-center justify-center bg-surface-secondary px-4">
      <Card className="w-full max-w-sm">
        <Card.Header className="flex flex-col items-center gap-2 pt-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
            <MessageCircle size={24} />
          </div>
          <Card.Title className="text-xl">Liminal CRM</Card.Title>
          <Card.Description>Inicia sesión para entrar a la bandeja de entrada</Card.Description>
        </Card.Header>
        <Card.Content>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" fullWidth isDisabled={isLoading}>
              {isLoading ? "Entrando..." : "Entrar"}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-muted">
            Demo local: jose@liminal.test · maria@liminal.test · carlos@liminal.test
            <br />
            Contraseña: Liminal123!
          </p>
        </Card.Content>
      </Card>
    </div>
  );
}
