import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage() {
  const supabase = await createClient();
  // La sesión de la cookie alcanza: acá solo se decide si mostrar el
  // formulario o mandar a alguien que ya entró de vuelta al CRM, y eso es
  // navegación, no autorización. Ver `lib/supabase/middleware.ts`.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    redirect("/");
  }

  return <LoginForm />;
}
