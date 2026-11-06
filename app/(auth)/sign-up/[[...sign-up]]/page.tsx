import { EmailAuthCard } from "@/components/auth/email-auth-card";
import Link from "next/link";

export default function SignUpPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 py-10 text-center" lang="sr-Latn">
        <h1 className="text-2xl font-semibold">Registracija trenutno nije dostupna</h1>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">Pokušaj ponovo kasnije. Događaje možeš da pregledaš i bez naloga.</p>
        <Link className="button-secondary min-h-11 px-4" href="/">Nazad na događaje</Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <EmailAuthCard mode="sign-up" />
    </div>
  );
}
