"use client";

import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import type { OAuthStrategy } from "@clerk/types";
import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";

const NATIVE_INSTAGRAM_OAUTH_STRATEGY = "oauth_instagram" as const;
const DEFAULT_CUSTOM_INSTAGRAM_OAUTH_STRATEGY = "oauth_custom_instagram" as const;
const SSO_CALLBACK_PATH = "/sso-callback";
const AUTH_COMPLETE_REDIRECT_PATH = "/admin";
const CONFIGURED_INSTAGRAM_STRATEGY = process.env.NEXT_PUBLIC_CLERK_INSTAGRAM_OAUTH_STRATEGY;
const INSTAGRAM_SSO_NOT_ENABLED_MESSAGE =
  "Instagram sign-in is not enabled for this Clerk instance yet. Enable Instagram in Clerk, or set NEXT_PUBLIC_CLERK_INSTAGRAM_OAUTH_STRATEGY to your custom Instagram OAuth strategy, for example oauth_custom_instagram.";

const INSTAGRAM_STRATEGY_CANDIDATES = [
  CONFIGURED_INSTAGRAM_STRATEGY,
  NATIVE_INSTAGRAM_OAUTH_STRATEGY,
  DEFAULT_CUSTOM_INSTAGRAM_OAUTH_STRATEGY,
].filter(isOAuthStrategy);

type AuthMode = "sign-in" | "sign-up";

type InstagramSsoAuthCardProps = {
  mode: AuthMode;
};

type ClerkWithEnvironment = ReturnType<typeof useClerk> & {
  __unstable__environment?: {
    userSettings?: {
      authenticatableSocialStrategies?: OAuthStrategy[];
    };
  };
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
    title: "Sign in with Instagram",
    description:
      "Use Instagram as the primary login for the Belgrade events admin tools.",
    alternateHref: "/sign-up",
    alternateLabel: "Need access?",
    alternateCta: "Sign up",
    fallbackSummary: "Other sign-in options",
  },
  "sign-up": {
    eyebrow: "Create access",
    title: "Sign up with Instagram",
    description:
      "Connect Instagram first so future event-admin access starts from the same account.",
    alternateHref: "/sign-in",
    alternateLabel: "Already have access?",
    alternateCta: "Sign in",
    fallbackSummary: "Other sign-up options",
  },
};

function isOAuthStrategy(value: string | undefined): value is OAuthStrategy {
  return typeof value === "string" && /^oauth_[a-z0-9_:-]+$/i.test(value);
}

function isInstagramSsoSupported(strategy: OAuthStrategy) {
  return (
    strategy === NATIVE_INSTAGRAM_OAUTH_STRATEGY ||
    strategy === DEFAULT_CUSTOM_INSTAGRAM_OAUTH_STRATEGY ||
    strategy.startsWith("oauth_custom_instagram") ||
    strategy.includes("instagram")
  );
}

function getEnabledInstagramStrategy(clerk: ClerkWithEnvironment): OAuthStrategy | null {
  const userSettings = clerk.__unstable__environment?.userSettings;
  const enabledStrategies = (userSettings?.authenticatableSocialStrategies ?? []).filter(
    isOAuthStrategy,
  );
  const uniqueEnabledStrategies = Array.from(new Set(enabledStrategies));

  const configuredEnabledStrategy = uniqueEnabledStrategies.find((strategy) =>
    INSTAGRAM_STRATEGY_CANDIDATES.includes(strategy),
  );

  if (configuredEnabledStrategy) {
    return configuredEnabledStrategy;
  }

  return uniqueEnabledStrategies.find(isInstagramSsoSupported) ?? null;
}

function getSafeRedirectPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  if (value.startsWith("/sign-in") || value.startsWith("/sign-up") || value.startsWith("/sso-callback")) {
    return null;
  }

  return value;
}

export function InstagramSsoAuthCard({ mode }: InstagramSsoAuthCardProps) {
  const clerk = useClerk() as ClerkWithEnvironment;
  const { isLoaded: isSignInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: isSignUpLoaded, signUp } = useSignUp();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualUsername, setManualUsername] = useState("");
  const [manualPassword, setManualPassword] = useState("");
  const [manualAuthError, setManualAuthError] = useState<string | null>(null);
  const [isManualAuthSubmitting, setIsManualAuthSubmitting] = useState(false);
  const [authCompleteRedirectPath, setAuthCompleteRedirectPath] = useState(AUTH_COMPLETE_REDIRECT_PATH);

  const copy = copyByMode[mode];
  const isLoaded = mode === "sign-in" ? isSignInLoaded : isSignUpLoaded;
  const authResource = mode === "sign-in" ? signIn : signUp;
  const instagramStrategy = useMemo(() => getEnabledInstagramStrategy(clerk), [clerk]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedRedirectPath = getSafeRedirectPath(params.get("redirect_url"));
    if (requestedRedirectPath) {
      setAuthCompleteRedirectPath(requestedRedirectPath);
    }
  }, []);

  async function startInstagramSso() {
    if (!isLoaded || !authResource) {
      return;
    }

    if (!instagramStrategy) {
      setError(INSTAGRAM_SSO_NOT_ENABLED_MESSAGE);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await authResource.authenticateWithRedirect({
        strategy: instagramStrategy,
        redirectUrl: SSO_CALLBACK_PATH,
        redirectUrlComplete: authCompleteRedirectPath,
        ...(mode === "sign-in" ? { continueSignIn: true } : { continueSignUp: true }),
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? `${caughtError.message} If this is a Clerk strategy error, set NEXT_PUBLIC_CLERK_INSTAGRAM_OAUTH_STRATEGY to the enabled strategy shown in Clerk, such as oauth_custom_instagram.`
          : "Could not start Instagram authentication.",
      );
      setIsSubmitting(false);
    }
  }

  async function startManualSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode !== "sign-in" || !isSignInLoaded || !signIn || !setActive) {
      return;
    }

    setIsManualAuthSubmitting(true);
    setManualAuthError(null);

    try {
      const result = await signIn.create({
        identifier: manualUsername.trim(),
        password: manualPassword,
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        window.location.assign(authCompleteRedirectPath);
        return;
      }

      setManualAuthError("Could not complete sign in. Please try again or use Instagram.");
    } catch (caughtError) {
      setManualAuthError(
        caughtError instanceof Error ? caughtError.message : "Could not sign in with those credentials.",
      );
    } finally {
      setIsManualAuthSubmitting(false);
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

          <button
            className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_20px_44px_-24px_rgba(14,116,144,0.85)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!isLoaded || isSubmitting}
            onClick={startInstagramSso}
            type="button"
          >
            {isSubmitting ? "Opening Instagram…" : "Continue with Instagram"}
          </button>

          {error ? (
            <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <p className="text-sm text-muted-foreground">
            {copy.alternateLabel} {" "}
            <Link className="font-semibold text-primary hover:text-primary/85" href={copy.alternateHref}>
              {copy.alternateCta}
            </Link>
          </p>
        </div>
      </section>

      <details className="rounded-3xl border border-border/70 bg-card/80 p-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none font-semibold text-foreground">
          {copy.fallbackSummary}
        </summary>
        {mode === "sign-in" ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={startManualSignIn}>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Username
              <input
                autoComplete="username"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignInLoaded || isManualAuthSubmitting}
                name="username"
                onChange={(event) => setManualUsername(event.target.value)}
                required
                type="text"
                value={manualUsername}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-left text-sm font-medium text-foreground">
              Password
              <input
                autoComplete="current-password"
                className="rounded-2xl border border-border bg-background px-3 py-2 text-foreground outline-none transition focus:border-primary"
                disabled={!isSignInLoaded || isManualAuthSubmitting}
                name="password"
                onChange={(event) => setManualPassword(event.target.value)}
                required
                type="password"
                value={manualPassword}
              />
            </label>
            <button
              className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-primary/35 px-5 py-2.5 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!isSignInLoaded || isManualAuthSubmitting}
              type="submit"
            >
              {isManualAuthSubmitting ? "Signing in…" : "Sign in with username"}
            </button>
            {manualAuthError ? (
              <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {manualAuthError}
              </p>
            ) : null}
          </form>
        ) : (
          <p className="mt-3 leading-6">
            Other Clerk options are intentionally hidden here so this page cannot call
            unsupported social strategies. Enable Instagram in Clerk, then use the
            primary Instagram button above.
          </p>
        )}
      </details>
    </div>
  );
}
