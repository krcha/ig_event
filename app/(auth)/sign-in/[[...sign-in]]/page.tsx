import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-center text-sm text-muted-foreground">
        Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to enable sign in.
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <SignIn />
    </div>
  );
}
