import { existsSync, readFileSync } from "node:fs";

const checks = [];

function requireFile(path) {
  checks.push({ type: "file", path });
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function requireIncludes(path, content, needle, description = needle) {
  checks.push({ type: "content", path, description });
  if (!content.includes(needle)) {
    throw new Error(`${path} must include ${description}.`);
  }
}

function requireExcludes(path, content, needle, description = needle) {
  checks.push({ type: "absence", path, description });
  if (content.includes(needle)) {
    throw new Error(`${path} must not include ${description}.`);
  }
}

const authCardPath = "components/auth/email-auth-card.tsx";
const requireAuthHookPath = "lib/auth/use-require-auth.ts";
const savedLibraryPath = "components/saved/saved-library-panel.tsx";
const signInPath = "app/(auth)/sign-in/[[...sign-in]]/page.tsx";
const signUpPath = "app/(auth)/sign-up/[[...sign-up]]/page.tsx";
const callbackPath = "app/(auth)/sso-callback/[[...sso-callback]]/page.tsx";
const youProfilePath = "components/auth/you-profile-panel.tsx";
const layoutPath = "app/layout.tsx";
const layout = requireFile(layoutPath);
requireIncludes(layoutPath, layout, 'clerkJSVariant="headless"', "headless Clerk core for the custom auth UI");
requireIncludes(layoutPath, layout, "<AppDocument authEnabled locale={locale}>", "global authenticated provider context with its request locale");
requireIncludes(layoutPath, layout, "<LocaleProvider locale={locale}>", "the same server-rendered locale for public client components");

const authCard = requireFile(authCardPath);
requireIncludes(authCardPath, authCard, 't(mode === "sign-in" ? "auth.signIn" : "auth.signUp")', "localized public sign-in and sign-up headings");
requireExcludes(authCardPath, authCard, "Admin access", "admin-only public sign-in wording");
requireExcludes(authCardPath, authCard, "Clerk account", "auth provider jargon");
requireIncludes(authCardPath, authCard, 't("install.backEvents")', "localized return to public browsing");
requireIncludes(authCardPath, authCard, 'href={localizeHref("/", locale)}', "return to public browsing in the selected language");
requireIncludes(authCardPath, authCard, 'AUTH_COMPLETE_REDIRECT_PATH = "/"', "root fallback redirect");
requireIncludes(authCardPath, authCard, "window.location.assign(authCompleteRedirectPath)", "post-auth redirect");
requireIncludes(authCardPath, authCard, "getSafeRedirectPath", "same-origin post-auth redirect guard");
requireIncludes(authCardPath, authCard, "signIn.create", "manual email/password sign-in call");
requireIncludes(authCardPath, authCard, "identifier: signInEmail.trim()", "email identifier submission");
requireIncludes(authCardPath, authCard, "setSignInActive({ session:", "manual sign-in session activation");
requireIncludes(
  authCardPath,
  authCard,
  'strategy: "reset_password_email_code"',
  "Clerk email-code password recovery",
);
requireIncludes(authCardPath, authCard, "attemptFirstFactor", "password recovery code verification");
requireIncludes(authCardPath, authCard, "signIn.resetPassword", "verified password reset submission");
requireIncludes(
  authCardPath,
  authCard,
  "signOutOfOtherSessions: true",
  "password reset session revocation",
);
requireIncludes(authCardPath, authCard, 't("auth.forgotPassword")', "localized password recovery entry point");
requireIncludes(authCardPath, authCard, 'name="email"', "manual email input");
requireIncludes(authCardPath, authCard, 'type="email"', "email input type");
requireIncludes(authCardPath, authCard, 'type="password"', "manual password input");
requireIncludes(authCardPath, authCard, "signUp.create", "manual email/password sign-up call");
requireIncludes(authCardPath, authCard, "emailAddress: manualSignUpEmail.trim()", "manual sign-up email submission");
requireIncludes(authCardPath, authCard, "username: manualSignUpUsername.trim()", "current Clerk-required username submission");
requireIncludes(authCardPath, authCard, "prepareEmailAddressVerification", "manual sign-up email-code preparation");
requireIncludes(authCardPath, authCard, "attemptEmailAddressVerification", "manual sign-up email-code verification");
requireIncludes(authCardPath, authCard, "setSignUpActive({ session:", "manual sign-up session activation");
requireIncludes(authCardPath, authCard, 'autoComplete="one-time-code"', "manual sign-up code input");
requireExcludes(authCardPath, authCard, "socialProviderStrategies", "non-authenticatable social provider strategy source");
requireExcludes(authCardPath, authCard, "authenticateWithRedirect", "social redirect flow");
requireExcludes(authCardPath, authCard, "Continue with Instagram", "Instagram CTA");
requireExcludes(authCardPath, authCard, "oauth_google", "Google strategy usage");
requireExcludes(authCardPath, authCard, "oauth_instagram", "Instagram strategy usage");
requireExcludes(authCardPath, authCard, "<SignUp", "Clerk prebuilt sign-up fallback that can call unsupported social strategies");
requireExcludes(authCardPath, authCard, "<SignIn", "Clerk prebuilt sign-in fallback that can call unsupported social strategies");

const requireAuthHook = requireFile(requireAuthHookPath);
requireIncludes(requireAuthHookPath, requireAuthHook, 'localizeHref("/sign-in", locale)', "locale-aware custom sign-in redirect");
requireIncludes(requireAuthHookPath, requireAuthHook, "encodeURIComponent(currentPath)", "safe retention of the current route, query and fragment after sign-in");
requireExcludes(requireAuthHookPath, requireAuthHook, "openSignIn", "generic Clerk modal");

const savedLibrary = requireFile(savedLibraryPath);
requireIncludes(savedLibraryPath, savedLibrary, '"/sign-in?redirect_url=%2Fsaved"', "saved page custom sign-in link");
requireIncludes(savedLibraryPath, savedLibrary, '"/sign-up?redirect_url=%2Fsaved"', "saved page custom sign-up link");
requireIncludes(savedLibraryPath, savedLibrary, "encodeURIComponent(returnPath)", "preserve Saved date context after authentication");
requireExcludes(savedLibraryPath, savedLibrary, "SignInButton", "generic Clerk sign-in modal");
requireExcludes(savedLibraryPath, savedLibrary, "SignUpButton", "generic Clerk sign-up modal");

const signInPage = requireFile(signInPath);
requireIncludes(signInPath, signInPage, "EmailAuthCard", "custom email auth card");
requireIncludes(signInPath, signInPage, 'mode="sign-in"', "sign-in mode");

const signUpPage = requireFile(signUpPath);
requireIncludes(signUpPath, signUpPage, "EmailAuthCard", "custom email auth card");
requireIncludes(signUpPath, signUpPage, 'mode="sign-up"', "sign-up mode");

const callbackPage = requireFile(callbackPath);
requireIncludes(callbackPath, callbackPage, "AuthenticateWithRedirectCallback", "Clerk SSO callback component");

const youProfile = requireFile(youProfilePath);
requireIncludes(youProfilePath, youProfile, 'localizeHref("/sign-in", locale)', "localized profile custom sign-in link");
requireIncludes(youProfilePath, youProfile, 'localizeHref("/sign-up", locale)', "localized profile custom sign-up link");
requireIncludes(youProfilePath, youProfile, 'encodeURIComponent(localizeHref("/you", locale))', "profile authentication returns to the same locale");
requireExcludes(youProfilePath, youProfile, "SignInButton", "generic Clerk sign-in modal");
requireExcludes(youProfilePath, youProfile, "SignUpButton", "generic Clerk sign-up modal");

console.log(`Clerk email auth QA passed (${checks.length} checks).`);

await import("./qa-clerk-sign-in-flow.mjs");
