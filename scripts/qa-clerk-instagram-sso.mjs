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

const authCardPath = "components/auth/instagram-sso-card.tsx";
const requireAuthHookPath = "lib/auth/use-require-auth.ts";
const savedLibraryPath = "components/saved/saved-library-panel.tsx";
const signInPath = "app/(auth)/sign-in/[[...sign-in]]/page.tsx";
const signUpPath = "app/(auth)/sign-up/[[...sign-up]]/page.tsx";
const callbackPath = "app/(auth)/sso-callback/[[...sso-callback]]/page.tsx";
const youProfilePath = "components/auth/you-profile-panel.tsx";

const authCard = requireFile(authCardPath);
requireIncludes(authCardPath, authCard, "oauth_instagram", "native Instagram OAuth strategy");
requireIncludes(authCardPath, authCard, "oauth_custom_instagram", "custom Instagram OAuth strategy fallback");
requireIncludes(authCardPath, authCard, "NEXT_PUBLIC_CLERK_INSTAGRAM_OAUTH_STRATEGY", "configurable custom Instagram OAuth strategy");
requireIncludes(authCardPath, authCard, "authenticatableSocialStrategies", "Clerk allowed-strategy guard");
requireIncludes(authCardPath, authCard, "isInstagramSsoSupported", "Instagram support detection helper");
requireIncludes(authCardPath, authCard, "INSTAGRAM_SSO_NOT_ENABLED_MESSAGE", "dashboard setup error message");
requireIncludes(authCardPath, authCard, "authenticateWithRedirect", "Clerk redirect SSO flow");
requireIncludes(authCardPath, authCard, "redirectUrl: SSO_CALLBACK_PATH", "shared SSO callback redirect");
requireIncludes(authCardPath, authCard, "redirectUrlComplete: authCompleteRedirectPath", "post-auth redirect");
requireIncludes(authCardPath, authCard, "getSafeRedirectPath", "same-origin post-auth redirect guard");
requireIncludes(authCardPath, authCard, "Continue with Instagram", "primary Instagram CTA");
requireIncludes(authCardPath, authCard, "signIn.create", "manual username/password sign-in call");
requireIncludes(authCardPath, authCard, "identifier: manualUsername.trim()", "username identifier submission");
requireIncludes(authCardPath, authCard, "setActive({ session:", "manual sign-in session activation");
requireIncludes(authCardPath, authCard, 'name="username"', "manual username input");
requireIncludes(authCardPath, authCard, 'type="password"', "manual password input");
requireExcludes(authCardPath, authCard, "socialProviderStrategies", "non-authenticatable social provider strategy source");
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
requireIncludes(signInPath, signInPage, "InstagramSsoAuthCard", "custom Instagram auth card");
requireIncludes(signInPath, signInPage, 'mode="sign-in"', "sign-in mode");

const signUpPage = requireFile(signUpPath);
requireIncludes(signUpPath, signUpPage, "InstagramSsoAuthCard", "custom Instagram auth card");
requireIncludes(signUpPath, signUpPage, 'mode="sign-up"', "sign-up mode");

const callbackPage = requireFile(callbackPath);
requireIncludes(callbackPath, callbackPage, "AuthenticateWithRedirectCallback", "Clerk SSO callback component");

const youProfile = requireFile(youProfilePath);
requireIncludes(youProfilePath, youProfile, 'href="/sign-in?redirect_url=%2Fyou"', "profile custom sign-in link");
requireIncludes(youProfilePath, youProfile, 'href="/sign-up?redirect_url=%2Fyou"', "profile custom sign-up link");
requireExcludes(youProfilePath, youProfile, "SignInButton", "generic Clerk sign-in modal");
requireExcludes(youProfilePath, youProfile, "SignUpButton", "generic Clerk sign-up modal");

console.log(`Clerk Instagram SSO QA passed (${checks.length} checks).`);
