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

const authCard = requireFile(authCardPath);
requireIncludes(authCardPath, authCard, "Sign in with email", "email sign-in heading");
requireIncludes(authCardPath, authCard, "Sign up with email", "email sign-up heading");
requireIncludes(authCardPath, authCard, 'AUTH_COMPLETE_REDIRECT_PATH = "/"', "root fallback redirect");
requireIncludes(authCardPath, authCard, "window.location.assign(authCompleteRedirectPath)", "post-auth redirect");
requireIncludes(authCardPath, authCard, "getSafeRedirectPath", "same-origin post-auth redirect guard");
requireIncludes(authCardPath, authCard, "signIn.create", "manual email/password sign-in call");
requireIncludes(authCardPath, authCard, "identifier: signInEmail.trim()", "email identifier submission");
requireIncludes(authCardPath, authCard, "setSignInActive({ session:", "manual sign-in session activation");
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
requireIncludes(requireAuthHookPath, requireAuthHook, "/sign-in?redirect_url=", "custom sign-in redirect");
requireExcludes(requireAuthHookPath, requireAuthHook, "openSignIn", "generic Clerk modal");

const savedLibrary = requireFile(savedLibraryPath);
requireIncludes(savedLibraryPath, savedLibrary, 'href="/sign-in?redirect_url=%2Fsaved"', "saved page custom sign-in link");
requireIncludes(savedLibraryPath, savedLibrary, 'href="/sign-up?redirect_url=%2Fsaved"', "saved page custom sign-up link");
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
requireIncludes(youProfilePath, youProfile, 'href="/sign-in?redirect_url=%2Fyou"', "profile custom sign-in link");
requireIncludes(youProfilePath, youProfile, 'href="/sign-up?redirect_url=%2Fyou"', "profile custom sign-up link");
requireExcludes(youProfilePath, youProfile, "SignInButton", "generic Clerk sign-in modal");
requireExcludes(youProfilePath, youProfile, "SignUpButton", "generic Clerk sign-up modal");

console.log(`Clerk email auth QA passed (${checks.length} checks).`);
