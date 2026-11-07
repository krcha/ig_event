import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(file, mocks) {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const vmModule = { exports: {} };
  new Function("require", "exports", "module", source)((name) => mocks[name] ?? require(name), vmModule.exports, vmModule);
  return vmModule.exports;
}

const flow = compile("lib/auth/email-sign-in.ts", {});
const localeConfig = compile("i18n/config.ts", {});
const accountMessages = compile("lib/i18n/account-messages.ts", {});
const safeRedirect = compile("lib/auth/safe-redirect.ts", { "@/i18n/config": localeConfig });
const emailFactor = { strategy: "email_code", emailAddressId: "email_qa", safeIdentifier: "o***@example.invalid" };
const state = (status, extra = {}) => ({ status, createdSessionId: null, supportedSecondFactors: [emailFactor], ...extra });
assert.deepEqual(flow.getEmailSignInStep(state("needs_second_factor")), { kind: "email-code", emailAddressId: "email_qa", destination: emailFactor.safeIdentifier });
assert.equal(flow.getEmailSignInStep(state("needs_client_trust")).kind, "email-code");
assert.equal(flow.getEmailSignInStep(state("needs_new_password")).kind, "new-password");
assert.deepEqual(flow.getEmailSignInStep(state("complete", { createdSessionId: "session_qa" })), { kind: "complete", sessionId: "session_qa" });
assert.throws(() => flow.getEmailSignInStep(state("complete")), /could not finish/);
assert.throws(() => flow.getEmailSignInStep(state("needs_first_factor")), /could not finish/);
assert.throws(() => flow.getEmailSignInStep(state("needs_second_factor", { supportedSecondFactors: [{ strategy: "totp" }] })), /another verification method/);
assert.throws(() => flow.getEmailSignInStep(state("needs_second_factor", { supportedSecondFactors: null })), /another verification method/);
assert.equal(flow.getEmailSignInError({ errors: [{ longMessage: "That verification code has expired." }] }, "fallback"), "That verification code has expired.");
assert.equal(flow.getEmailSignInError(new Error("Network unavailable"), "fallback"), "Network unavailable");
assert.equal(flow.getEmailSignInError(null, "fallback"), "fallback");

// Execute the actual component's event handlers. Only hooks and Clerk transport
// are replaced; no email, real credentials, or production session is used.
let hookStates = [];
let hookIndex = 0;
let signIn;
let calls;
let settings;
let currentLocale = "sr";
const navigation = [];
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { assign: (path) => navigation.push(path), search: "" } } });

const { EmailAuthCard } = compile("components/auth/email-auth-card.tsx", {
  "@clerk/nextjs": {
    useSignIn: () => ({ isLoaded: true, signIn, setActive: async (args) => calls.active.push(args) }),
    useSignUp: () => ({ isLoaded: true, signUp: null, setActive: null }),
  },
  "@/lib/auth/email-sign-in": flow,
  "@/lib/auth/safe-redirect": safeRedirect,
  "@/i18n/client": { useLocale: () => currentLocale },
  "@/i18n/config": localeConfig,
  "@/lib/i18n/account-messages": accountMessages,
  "next/link": { __esModule: true, default: ({ children, ...props }) => createElement("a", props, children) },
  react: {
    useEffect: () => {},
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hookStates)) hookStates[index] = typeof initial === "function" ? initial() : initial;
      return [hookStates[index], (value) => { hookStates[index] = typeof value === "function" ? value(hookStates[index]) : value; }];
    },
  },
});

function reset(options = {}) {
  hookStates = [];
  settings = { initialStatus: "needs_second_factor", failSend: false, verification: "complete", ...options };
  calls = { create: [], prepare: [], verify: [], active: [], reset: [] };
  navigation.length = 0;
  signIn = {
    ...state(settings.initialStatus, settings.initialStatus === "complete" ? { createdSessionId: "session_qa" } : {}),
    async create(args) { calls.create.push(args); return signIn; },
    async prepareSecondFactor(args) {
      calls.prepare.push(args);
      if (settings.failSend) throw { errors: [{ longMessage: "The code could not be sent. Please try again." }] };
      return signIn;
    },
    async attemptSecondFactor(args) {
      calls.verify.push(args);
      if (settings.verification === "invalid") throw { errors: [{ code: "verification_expired", longMessage: "That verification code has expired." }] };
      signIn.status = settings.verification;
      signIn.createdSessionId = settings.verification === "complete" ? "session_qa" : null;
      return signIn;
    },
    async attemptFirstFactor() { signIn.status = "needs_new_password"; return signIn; },
    async resetPassword(args) { calls.reset.push(args); signIn.status = "needs_second_factor"; return signIn; },
  };
}
function render() { hookIndex = 0; return EmailAuthCard({ mode: "sign-in" }); }
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.props?.children);
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean) ?? null;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
function input(name, value) {
  const element = find(render(), (node) => node.type === "input" && node.props.name === name);
  assert.ok(element, `Missing input ${name}`);
  element.props.onChange({ target: { value } });
}
function button(label) {
  const result = find(render(), (node) => node.type === "button" && text(node).trim() === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
async function submit() {
  const form = find(render(), (node) => node.type === "form");
  assert.ok(form);
  await form.props.onSubmit({ preventDefault() {} });
}
async function passwordSignIn() {
  input("email", "  owner@example.invalid  ");
  input("password", "qa-not-a-real-password");
  await submit();
}

try {
  reset();
  await passwordSignIn();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].identifier, "owner@example.invalid");
  assert.deepEqual(calls.prepare, [{ strategy: "email_code", emailAddressId: "email_qa" }]);
  assert.equal(calls.active.length, 0, "a valid password cannot bypass the required email code");
  assert.equal(navigation.length, 0);
  assert.match(text(render()), /Potvrdi prijavu/);
  assert.match(text(render()), /o\*\*\*@example.invalid/);
  assert.equal(button("Novi kod za 30 s").props.disabled, true);

  settings.verification = "invalid";
  input("sign-in-code", "000000");
  await submit();
  assert.equal(calls.active.length, 0);
  assert.match(text(render()), /Kod je istekao/);
  assert.equal(calls.create.length, 1, "code retries must preserve the password-verified attempt");

  settings.verification = "needs_second_factor";
  await submit();
  assert.equal(calls.active.length, 0, "incomplete code verification cannot create a session");
  assert.equal(calls.prepare.length, 1, "an incomplete verification must not automatically resend email");

  settings.verification = "complete";
  input("sign-in-code", " 123456 ");
  await submit();
  assert.deepEqual(calls.verify.at(-1), { strategy: "email_code", code: "123456" });
  assert.deepEqual(calls.active, [{ session: "session_qa" }]);
  assert.deepEqual(navigation, ["/"]);

  reset({ failSend: true });
  await passwordSignIn();
  assert.match(text(render()), /Potvrdi prijavu/);
  assert.ok(text(render()).includes(accountMessages.accountText("sr", "auth.errorSignIn")),
    "Unknown provider failures must use the localized safe fallback.");
  assert.equal(text(render()).includes("The code could not be sent"), false);
  settings.failSend = false;
  await button("Pošalji kod za potvrdu").props.onClick();
  assert.equal(calls.prepare.length, 2);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.active.length, 0);
  assert.equal(button("Novi kod za 30 s").props.disabled, true);
  button("Nazad na prijavu").props.onClick();
  assert.ok(find(render(), (node) => node.type === "input" && node.props.name === "password"));

  reset({ initialStatus: "complete" });
  await passwordSignIn();
  assert.equal(calls.prepare.length, 0);
  assert.deepEqual(calls.active, [{ session: "session_qa" }]);

  reset({ initialStatus: "needs_first_factor" });
  button("Zaboravljena lozinka?").props.onClick();
  input("email", "owner@example.invalid");
  await submit();
  assert.equal(calls.create[0].strategy, "reset_password_email_code");
  input("code", "123456");
  await submit();
  input("new-password", "qa-new-password-not-real");
  input("confirm-password", "qa-new-password-not-real");
  await submit();
  assert.deepEqual(calls.reset, [{ password: "qa-new-password-not-real", signOutOfOtherSessions: true }]);
  assert.equal(calls.active.length, 0, "password recovery must still respect required second-factor verification");
  assert.match(text(render()), /Potvrdi prijavu/);

  // The same actual Clerk state machine must retain its second-factor guard
  // and transport calls in every interface language, including its final URL.
  for (const [locale, heading, expired, target] of [
    ["sr", "Potvrdi prijavu", "Kod je istekao", "/"],
    ["en", "Verify sign-in", "The code has expired", "/en"],
    ["ru", "Подтвердить вход", "Срок действия кода истёк", "/ru"],
  ]) {
    currentLocale = locale;
    reset();
    await passwordSignIn();
    assert.ok(text(render()).includes(heading));
    assert.equal(calls.active.length, 0);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.prepare.length, 1);
    settings.verification = "invalid";
    input("sign-in-code", "000000");
    await submit();
    assert.ok(text(render()).includes(expired));
    assert.equal(calls.active.length, 0);
    settings.verification = "complete";
    input("sign-in-code", "123456");
    await submit();
    assert.deepEqual(calls.active, [{ session: "session_qa" }]);
    assert.deepEqual(navigation, [target]);
    assert.equal(calls.create.length, 1, "A locale must not recreate the password attempt during verification.");
    assert.equal(flow.getEmailSignInError({ errors: [{ code: "unknown_qa", longMessage: "provider internals" }] }, "safe fallback", locale), "safe fallback");
    assert.equal(safeRedirect.getSafeRedirectPath(`/${locale}/sign-in?redirect_url=/you`, locale), null);
    assert.equal(safeRedirect.getSafeRedirectPath(`/${locale}/sign-up`, locale), null);
    assert.equal(safeRedirect.getSafeRedirectPath("//attacker.example", locale), null);
  }

  // Optional local visual fixture: this inert markup never contacts Clerk.
  if (process.env.AUTH_QA_MARKUP_PATH) writeFileSync(process.env.AUTH_QA_MARKUP_PATH, renderToStaticMarkup(render()));
} finally {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else delete globalThis.window;
}

console.log("Clerk sign-in flow QA passed: required email factor, expiry/retry/resend, session activation only after verification, and password recovery with MFA (no network or email).");
