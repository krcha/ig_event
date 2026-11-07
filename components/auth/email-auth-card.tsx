"use client";

import { useSignIn, useSignUp } from "@clerk/nextjs";
import type { SignInResource } from "@clerk/types";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { getEmailSignInError, getEmailSignInStep } from "@/lib/auth/email-sign-in";
import { getSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { useLocale } from "@/i18n/client";
import { localizeHref, LOCALE_LANGUAGE_TAGS } from "@/i18n/config";
import { accountText } from "@/lib/i18n/account-messages";

const AUTH_COMPLETE_REDIRECT_PATH = "/";

type AuthMode = "sign-in" | "sign-up";
type SignInView = "password" | "verification-code" | "reset-code" | "reset-email" | "reset-password";

type EmailAuthCardProps = {
  mode: AuthMode;
};

const copyByMode: Record<
  AuthMode,
  {
    title: string;
    description: string;
    alternateHref: string;
    alternateLabel: string;
    alternateCta: string;
  }
> = {
  "sign-in": {
    title: "Prijavi se",
    description: "Sinhronizuj sačuvane događaje i omiljena mesta na svojim uređajima.",
    alternateHref: "/sign-up",
    alternateLabel: "Nemaš nalog?",
    alternateCta: "Napravi nalog",
  },
  "sign-up": {
    title: "Napravi nalog",
    description: "Čuvaj događaje i omiljena mesta i pristupaj im sa drugih uređaja.",
    alternateHref: "/sign-in",
    alternateLabel: "Već imaš nalog?",
    alternateCta: "Prijavi se",
  },
};

export function EmailAuthCard({ mode }: EmailAuthCardProps) {
  const locale = useLocale();
  const t = (key: Parameters<typeof accountText>[1], values?: Record<string, string | number>) => accountText(locale, key, values);
  const { isLoaded: isSignInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: isSignUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSignInSubmitting, setIsSignInSubmitting] = useState(false);
  const [signInView, setSignInView] = useState("password" as SignInView);
  const [signInCode, setSignInCode] = useState("");
  const [signInEmailFactor, setSignInEmailFactor] = useState<{ emailAddressId: string; destination: string } | null>(null);
  const [signInCodeSent, setSignInCodeSent] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
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
  const [authCompleteRedirectPath, setAuthCompleteRedirectPath] = useState(localizeHref(AUTH_COMPLETE_REDIRECT_PATH, locale));

  const copy = {
    ...copyByMode[mode],
    title: t(mode === "sign-in" ? "auth.signIn" : "auth.signUp"),
    description: t(mode === "sign-in" ? "auth.signInDescription" : "auth.signUpDescription"),
    alternateLabel: t(mode === "sign-in" ? "auth.noAccount" : "auth.existingAccount"),
    alternateCta: t(mode === "sign-in" ? "auth.signUp" : "auth.signIn"),
  };
  const viewCopy = mode === "sign-up"
    ? isManualSignUpVerifying
      ? { title: t("auth.verifyEmail"), description: t("auth.codeSent", { email: manualSignUpEmail }) }
      : copy
    : {
        password: copy,
        "verification-code": { title: t("auth.verifySignIn"), description: t("auth.extraVerification") },
        "reset-email": { title: t("auth.forgotPassword"), description: t("auth.resetDescription") },
        "reset-code": { title: t("auth.enterCode"), description: t("auth.enterCodeDescription") },
        "reset-password": { title: t("auth.newPassword"), description: t("auth.newPasswordDescription") },
      }[signInView];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedRedirectPath = getSafeRedirectPath(params.get("redirect_url"), locale);
    if (requestedRedirectPath) {
      setAuthCompleteRedirectPath(requestedRedirectPath);
    }
  }, [locale]);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timeout = setTimeout(() => setResendCountdown((current) => Math.max(0, current - 1)), 1000);
    return () => clearTimeout(timeout);
  }, [resendCountdown]);

  async function finishOrVerifySignIn(result: SignInResource) {
    const step = getEmailSignInStep(result);
    if (step.kind === "complete") {
      if (!setSignInActive) throw new Error(t("auth.loading"));
      await setSignInActive({ session: step.sessionId });
      window.location.assign(authCompleteRedirectPath);
      return;
    }
    if (step.kind === "new-password") {
      setSignInPassword("");
      setSignInView("reset-password");
      return;
    }
    setSignInEmailFactor(step);
    setSignInCode("");
    setSignInPassword("");
    setSignInCodeSent(false);
    setSignInView("verification-code");
    // Preserve the password-verified attempt; do not create another sign-in.
    await result.prepareSecondFactor({ strategy: "email_code", emailAddressId: step.emailAddressId });
    setSignInCodeSent(true);
    setResendCountdown(30);
  }

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

      await finishOrVerifySignIn(result);
    } catch (caughtError) {
      setSignInError(getEmailSignInError(caughtError, t("auth.errorSignIn"), locale));
    } finally {
      setIsSignInSubmitting(false);
    }
  }

  async function verifySignInCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isSignInLoaded || !signIn || !setSignInActive || !signInEmailFactor) return;
    setIsSignInSubmitting(true);
    setSignInError(null);
    try {
      const result = await signIn.attemptSecondFactor({ strategy: "email_code", code: signInCode.trim() });
      if (result.status !== "complete" || !result.createdSessionId) {
        throw new Error(t("auth.errorVerify"));
      }
      await finishOrVerifySignIn(result);
    } catch (caughtError) {
      setSignInError(getEmailSignInError(caughtError, t("auth.errorVerify"), locale));
    } finally {
      setIsSignInSubmitting(false);
    }
  }

  async function resendSignInCode() {
    if (!isSignInLoaded || !signIn || !signInEmailFactor || resendCountdown > 0 || isSignInSubmitting) return;
    setIsSignInSubmitting(true);
    setSignInError(null);
    try {
      await signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId: signInEmailFactor.emailAddressId });
      setSignInCode("");
      setSignInCodeSent(true);
      setResendCountdown(30);
    } catch (caughtError) {
      setSignInError(getEmailSignInError(caughtError, t("auth.errorNewCode"), locale));
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

      setSignInError(t("auth.errorReset"));
    } catch (caughtError) {
      setSignInError(
        getEmailSignInError(caughtError, t("auth.errorResetCode"), locale),
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

      setSignInError(t("auth.errorVerify"));
    } catch (caughtError) {
      setSignInError(
        getEmailSignInError(caughtError, t("auth.errorVerify"), locale),
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
      setSignInError(t("auth.passwordMismatch"));
      return;
    }

    setIsSignInSubmitting(true);
    setSignInError(null);

    try {
      const result = await signIn.resetPassword({
        password: passwordResetPassword,
        signOutOfOtherSessions: true,
      });

      await finishOrVerifySignIn(result);
    } catch (caughtError) {
      setSignInError(getEmailSignInError(caughtError, t("auth.errorPasswordChange"), locale));
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
        getEmailSignInError(caughtError, t("auth.errorSignUp"), locale),
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

      setManualSignUpError(t("auth.errorVerify"));
    } catch (caughtError) {
      setManualSignUpError(
        getEmailSignInError(caughtError, t("auth.errorVerify"), locale),
      );
    } finally {
      setIsManualSignUpSubmitting(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-5" lang={LOCALE_LANGUAGE_TAGS[locale]}>
      <section className="glass-panel border border-primary/20 bg-card/95 p-6 shadow-[0_24px_80px_-48px_rgba(14,116,144,0.55)]">
        <div className="flex flex-col gap-4 text-center">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{viewCopy.title}</h1>
            <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{viewCopy.description}</p>
          </div>

          {mode === "sign-in" ? (
            <div className="flex flex-col gap-3">
              {signInView === "password" ? (
                <form className="flex flex-col gap-3" onSubmit={startManualSignIn}>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    {t("auth.email")}<input
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
                    {t("auth.password")}<input
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
                    {isSignInSubmitting ? t("auth.signingIn") : t("auth.signIn")}
                  </button>
                  <button
                    className="min-h-11 text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    onClick={() => {
                      setSignInError(null);
                      setSignInView("reset-email");
                    }}
                    type="button"
                  >
                    {t("auth.forgotPassword")}</button>
                </form>
              ) : signInView === "verification-code" ? (
                <form className="flex flex-col gap-3" onSubmit={verifySignInCode}>
                  <p className="break-words text-sm leading-6 text-muted-foreground" role="status">
                    {signInCodeSent
                      ? t("auth.codeSent", { email: signInEmailFactor?.destination || t("auth.accountEmail") })
                      : t("auth.codeRequired")}
                  </p>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    {t("auth.verificationCode")}<input
                      autoComplete="one-time-code"
                      className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                      disabled={!isSignInLoaded || isSignInSubmitting}
                      inputMode="numeric"
                      name="sign-in-code"
                      onChange={(event) => setSignInCode(event.target.value)}
                      required
                      type="text"
                      value={signInCode}
                    />
                  </label>
                  <button
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting}
                    type="submit"
                  >
                    {isSignInSubmitting ? t("auth.verifying") : t("auth.confirmSignIn")}
                  </button>
                  <button
                    className="min-h-11 text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isSignInLoaded || isSignInSubmitting || resendCountdown > 0}
                    onClick={resendSignInCode}
                    type="button"
                  >
                    {resendCountdown > 0 ? t("auth.resendIn", { seconds: resendCountdown }) : signInCodeSent ? t("auth.resendCode") : t("auth.sendVerificationCode")}
                  </button>
                  <button
                    className="min-h-11 text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSignInSubmitting}
                    onClick={() => {
                      setSignInError(null);
                      setSignInCode("");
                      setSignInEmailFactor(null);
                      setSignInCodeSent(false);
                      setResendCountdown(0);
                      setSignInView("password");
                    }}
                    type="button"
                  >
                    {t("auth.backToSignIn")}</button>
                </form>
              ) : signInView === "reset-email" ? (
                <form className="flex flex-col gap-3" onSubmit={startPasswordReset}>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    {t("auth.email")}<input
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
                    {isSignInSubmitting ? t("auth.sending") : t("auth.sendCode")}
                  </button>
                  <button
                    className="min-h-11 text-sm font-semibold text-primary hover:text-primary/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSignInSubmitting}
                    onClick={() => {
                      setSignInError(null);
                      setSignInView("password");
                    }}
                    type="button"
                  >
                    {t("auth.backToSignIn")}</button>
                </form>
              ) : signInView === "reset-code" ? (
                <form className="flex flex-col gap-3" onSubmit={verifyPasswordResetCode}>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    {t("auth.emailCode")}<input
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
                    {isSignInSubmitting ? t("auth.verifying") : t("auth.confirmCode")}
                  </button>
                </form>
              ) : (
                <form className="flex flex-col gap-3" onSubmit={completePasswordReset}>
                  <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
                    {t("auth.newPassword")}<input
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
                    {t("auth.confirmPassword")}<input
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
                    {isSignInSubmitting ? t("auth.saving") : t("auth.savePassword")}
                  </button>
                </form>
              )}
              {signInError ? (
                <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {signInError}
                </p>
              ) : null}
            </div>
        ) : isManualSignUpVerifying ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={verifyManualSignUp}>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              {t("auth.emailCode")}<input
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
              {isManualSignUpSubmitting ? t("auth.verifying") : t("auth.verifyEmail")}
            </button>
            {manualSignUpError ? (
              <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {manualSignUpError}
              </p>
            ) : null}
          </form>
        ) : (
          <form className="mt-4 flex flex-col gap-3" onSubmit={startManualSignUp}>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              {t("auth.email")}<input
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
              {t("auth.username")}<input
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
              {t("auth.password")}<input
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
              {isManualSignUpSubmitting ? t("auth.creatingAccount") : t("auth.signUp")}
            </button>
            {manualSignUpError ? (
              <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {manualSignUpError}
              </p>
            ) : null}
          </form>
        )}

          <p className="text-sm text-muted-foreground">
            {copy.alternateLabel}{" "}
            <Link
              className="font-semibold text-primary hover:text-primary/85"
              href={`${localizeHref(copy.alternateHref, locale)}?redirect_url=${encodeURIComponent(authCompleteRedirectPath)}`}
            >
              {copy.alternateCta}
            </Link>
          </p>
        </div>
      </section>
      <Link
        className="inline-flex min-h-11 items-center justify-center text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        href={localizeHref("/", locale)}
      >
        {t("install.backEvents")}</Link>
    </div>
  );
}
