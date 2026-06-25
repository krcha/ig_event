"use client";

import { useSignIn, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

const AUTH_COMPLETE_REDIRECT_PATH = "/admin";

type AuthMode = "sign-in" | "sign-up";

type EmailAuthCardProps = {
  mode: AuthMode;
};

const copyByMode: Record<
  AuthMode,
  {
    eyebrow: string;
    title: string;
    description: string;
    alternateHref: string;
    alternateLabel: string;
    alternateCta: string;
    fallbackSummary: string;
  }
> = {
  "sign-in": {
    eyebrow: "Admin access",
    title: "Sign in with email",
    description: "Use the email and password attached to your Clerk account.",
    alternateHref: "/sign-up",
    alternateLabel: "Need access?",
    alternateCta: "Sign up",
    fallbackSummary: "Email sign-in",
  },
  "sign-up": {
    eyebrow: "Create access",
    title: "Sign up with email",
    description: "Create a Clerk account with email verification and password sign-in.",
    alternateHref: "/sign-in",
    alternateLabel: "Already have access?",
    alternateCta: "Sign in",
    fallbackSummary: "Email sign-up",
  },
};

function getSafeRedirectPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  if (value.startsWith("/sign-in") || value.startsWith("/sign-up") || value.startsWith("/sso-callback")) {
    return null;
  }

  return value;
}

export function EmailAuthCard({ mode }: EmailAuthCardProps) {
  const { isLoaded: isSignInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: isSignUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSignInSubmitting, setIsSignInSubmitting] = useState(false);
  const [manualSignUpEmail, setManualSignUpEmail] = useState("");
  const [manualSignUpUsername, setManualSignUpUsername] = useState("");
  const [manualSignUpPassword, setManualSignUpPassword] = useState("");
  const [manualSignUpCode, setManualSignUpCode] = useState("");
  const [manualSignUpError, setManualSignUpError] = useState<string | null>(null);
  const [isManualSignUpSubmitting, setIsManualSignUpSubmitting] = useState(false);
  const [isManualSignUpVerifying, setIsManualSignUpVerifying] = useState(false);
  const [authCompleteRedirectPath, setAuthCompleteRedirectPath] = useState(AUTH_COMPLETE_REDIRECT_PATH);

  const copy = copyByMode[mode];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedRedirectPath = getSafeRedirectPath(params.get("redirect_url"));
    if (requestedRedirectPath) {
      setAuthCompleteRedirectPath(requestedRedirectPath);
    }
  }, []);

  async function startManualSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-in" || !isSignInLoaded || !signIn || !setSignInActive) {
      return;
    }

    setIsSignInSubmitting(true);
    setSignInError(null);

    try {
      const result = await signIn.create({
        identifier: signInEmail.trim(),
        password: signInPassword,
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignInActive({ session: result.createdSessionId });
        window.location.assign(authCompleteRedirectPath);
        return;
      }

      setSignInError("Could not complete sign in. Please try again.");
    } catch (caughtError) {
      setSignInError(
        caughtError instanceof Error ? caughtError.message : "Could not sign in with those credentials.",
      );
    } finally {
      setIsSignInSubmitting(false);
    }
  }

  async function startManualSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-up" || !isSignUpLoaded || !signUp || !setSignUpActive) {
      return;
    }

    setIsManualSignUpSubmitting(true);
    setManualSignUpError(null);

    try {
      const result = await signUp.create({
        emailAddress: manualSignUpEmail.trim(),
        password: manualSignUpPassword,
        username: manualSignUpUsername.trim(),
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignUpActive({ session: result.createdSessionId });
        window.location.assign(authCompleteRedirectPath);
        return;
      }

      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setIsManualSignUpVerifying(true);
    } catch (caughtError) {
      setManualSignUpError(
        caughtError instanceof Error ? caughtError.message : "Could not create that account.",
      );
    } finally {
      setIsManualSignUpSubmitting(false);
    }
  }

  async function verifyManualSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-up" || !isSignUpLoaded || !signUp || !setSignUpActive) {
      return;
    }

    setIsManualSignUpSubmitting(true);
    setManualSignUpError(null);

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: manualSignUpCode.trim(),
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignUpActive({ session: result.createdSessionId });
        window.location.assign(authCompleteRedirectPath);
        return;
      }

      setManualSignUpError("Could not verify that code. Please try again.");
    } catch (caughtError) {
      setManualSignUpError(
        caughtError instanceof Error ? caughtError.message : "Could not verify that code.",
      );
    } finally {
      setIsManualSignUpSubmitting(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-5">
      <section className="glass-panel border border-primary/20 bg-card/95 p-6 shadow-[0_24px_80px_-48px_rgba(14,116,144,0.55)]">
        <div className="flex flex-col gap-4 text-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-primary">
              {copy.eyebrow}
            </p>
            <h1 className="mt-3 text-2xl font-semibold text-foreground">{copy.title}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.description}</p>
          </div>

          {mode === "sign-in" ? (
            <form className="flex flex-col gap-3" onSubmit={startManualSignIn}>
              <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                Email
                <input
                  autoComplete="email"
                  className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                  disabled={!isSignInLoaded || isSignInSubmitting}
                  name="email"
                  onChange={(event) => setSignInEmail(event.target.value)}
                  required
                  type="email"
                  value={signInEmail}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                Password
                <input
                  autoComplete="current-password"
                  className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                  disabled={!isSignInLoaded || isSignInSubmitting}
                  name="password"
                  onChange={(event) => setSignInPassword(event.target.value)}
                  required
                  type="password"
                  value={signInPassword}
                />
              </label>
              <button
                className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!isSignInLoaded || isSignInSubmitting}
                type="submit"
              >
                {isSignInSubmitting ? "Signing in…" : "Sign in"}
              </button>
              {signInError ? (
                <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {signInError}
                </p>
              ) : null}
            </form>
        ) : isManualSignUpVerifying ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={verifyManualSignUp}>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Email code
              <input
                autoComplete="one-time-code"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignUpLoaded || isManualSignUpSubmitting}
                inputMode="numeric"
                name="code"
                onChange={(event) => setManualSignUpCode(event.target.value)}
                required
                type="text"
                value={manualSignUpCode}
              />
            </label>
            <button
              className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!isSignUpLoaded || isManualSignUpSubmitting}
              type="submit"
            >
              {isManualSignUpSubmitting ? "Verifying…" : "Verify email"}
            </button>
            {manualSignUpError ? (
              <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {manualSignUpError}
              </p>
            ) : null}
          </form>
        ) : (
          <form className="mt-4 flex flex-col gap-3" onSubmit={startManualSignUp}>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Email
              <input
                autoComplete="email"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignUpLoaded || isManualSignUpSubmitting}
                name="email"
                onChange={(event) => setManualSignUpEmail(event.target.value)}
                required
                type="email"
                value={manualSignUpEmail}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Username
              <input
                autoComplete="username"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignUpLoaded || isManualSignUpSubmitting}
                name="username"
                onChange={(event) => setManualSignUpUsername(event.target.value)}
                required
                type="text"
                value={manualSignUpUsername}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Password
              <input
                autoComplete="new-password"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignUpLoaded || isManualSignUpSubmitting}
                name="password"
                onChange={(event) => setManualSignUpPassword(event.target.value)}
                required
                type="password"
                value={manualSignUpPassword}
              />
            </label>
            <button
              className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!isSignUpLoaded || isManualSignUpSubmitting}
              type="submit"
            >
              {isManualSignUpSubmitting ? "Creating account…" : "Sign up"}
            </button>
            {manualSignUpError ? (
              <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {manualSignUpError}
              </p>
            ) : null}
          </form>
        )}

          <p className="text-sm text-muted-foreground">
            {copy.alternateLabel}{" "}
            <Link className="font-semibold text-primary hover:text-primary/85" href={copy.alternateHref}>
              {copy.alternateCta}
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
