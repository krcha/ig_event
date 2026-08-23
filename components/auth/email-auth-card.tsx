"use client";

import { useSignIn, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

const AUTH_COMPLETE_REDIRECT_PATH = "/";

type AuthMode = "sign-in" | "sign-up";
type SignInView = "password" | "reset-code" | "reset-email" | "reset-password";

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
  const [signInView, setSignInView] = useState("password" as SignInView);
  const [passwordResetCode, setPasswordResetCode] = useState("");
  const [passwordResetPassword, setPasswordResetPassword] = useState("");
  const [passwordResetPasswordConfirmation, setPasswordResetPasswordConfirmation] = useState("");
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

  async function startPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-in" || !isSignInLoaded || !signIn) {
      return;
    }

    setIsSignInSubmitting(true);
    setSignInError(null);

    try {
      const result = await signIn.create({
        identifier: signInEmail.trim(),
        strategy: "reset_password_email_code",
      });

      if (result.status === "needs_first_factor") {
        setSignInView("reset-code");
        return;
      }

      setSignInError("Could not start password recovery. Please try again.");
    } catch (caughtError) {
      setSignInError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not send the password recovery code.",
      );
    } finally {
      setIsSignInSubmitting(false);
    }
  }

  async function verifyPasswordResetCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-in" || !isSignInLoaded || !signIn) {
      return;
    }

    setIsSignInSubmitting(true);
    setSignInError(null);

    try {
      const result = await signIn.attemptFirstFactor({
        code: passwordResetCode.trim(),
        strategy: "reset_password_email_code",
      });

      if (result.status === "needs_new_password") {
        setSignInView("reset-password");
        return;
      }

      setSignInError("Could not verify that recovery code. Please try again.");
    } catch (caughtError) {
      setSignInError(
        caughtError instanceof Error ? caughtError.message : "Could not verify that recovery code.",
      );
    } finally {
      setIsSignInSubmitting(false);
    }
  }

  async function completePasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-in" || !isSignInLoaded || !signIn || !setSignInActive) {
      return;
    }

    if (passwordResetPassword !== passwordResetPasswordConfirmation) {
      setSignInError("The new passwords do not match.");
      return;
    }

    setIsSignInSubmitting(true);
    setSignInError(null);

    try {
      const result = await signIn.resetPassword({
        password: passwordResetPassword,
        signOutOfOtherSessions: true,
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignInActive({ session: result.createdSessionId });
        window.location.assign(authCompleteRedirectPath);
        return;
      }

      setSignInError("Could not complete password recovery. Please try again.");
    } catch (caughtError) {
      setSignInError(
        caughtError instanceof Error ? caughtError.message : "Could not set the new password.",
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
            <div className="flex flex-col gap-3">
              {signInView === "password" ? (
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
                  <button
                    className="text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    onClick={() => {
                      setSignInError(null);
                      setSignInView("reset-email");
                    }}
                    type="button"
                  >
                    Forgot password?
                  </button>
                </form>
              ) : signInView === "reset-email" ? (
                <form className="flex flex-col gap-3" onSubmit={startPasswordReset}>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Enter the account email. Clerk will send a one-time recovery code.
                  </p>
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
                  <button
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    type="submit"
                  >
                    {isSignInSubmitting ? "Sending…" : "Send recovery code"}
                  </button>
                  <button
                    className="text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSignInSubmitting}
                    onClick={() => {
                      setSignInError(null);
                      setSignInView("password");
                    }}
                    type="button"
                  >
                    Back to sign in
                  </button>
                </form>
              ) : signInView === "reset-code" ? (
                <form className="flex flex-col gap-3" onSubmit={verifyPasswordResetCode}>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Enter the recovery code sent to the account email.
                  </p>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    Recovery code
                    <input
                      autoComplete="one-time-code"
                      className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                      disabled={!isSignInLoaded || isSignInSubmitting}
                      inputMode="numeric"
                      name="code"
                      onChange={(event) => setPasswordResetCode(event.target.value)}
                      required
                      type="text"
                      value={passwordResetCode}
                    />
                  </label>
                  <button
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    type="submit"
                  >
                    {isSignInSubmitting ? "Verifying…" : "Verify recovery code"}
                  </button>
                </form>
              ) : (
                <form className="flex flex-col gap-3" onSubmit={completePasswordReset}>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Choose a new, unique password. Other active sessions will be signed out.
                  </p>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    New password
                    <input
                      autoComplete="new-password"
                      className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                      disabled={!isSignInLoaded || isSignInSubmitting}
                      name="new-password"
                      onChange={(event) => setPasswordResetPassword(event.target.value)}
                      required
                      type="password"
                      value={passwordResetPassword}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    Confirm new password
                    <input
                      autoComplete="new-password"
                      className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                      disabled={!isSignInLoaded || isSignInSubmitting}
                      name="confirm-password"
                      onChange={(event) =>
                        setPasswordResetPasswordConfirmation(event.target.value)
                      }
                      required
                      type="password"
                      value={passwordResetPasswordConfirmation}
                    />
                  </label>
                  <button
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    type="submit"
                  >
                    {isSignInSubmitting ? "Updating…" : "Set new password"}
                  </button>
                </form>
              )}
              {signInError ? (
                <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {signInError}
                </p>
              ) : null}
            </div>
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
