import type { SignInSecondFactor } from "@clerk/types";

type SignInState = {
  status: string | null;
  createdSessionId: string | null;
  supportedSecondFactors: SignInSecondFactor[] | null;
};

export type EmailSignInStep =
  | { kind: "complete"; sessionId: string }
  | { kind: "email-code"; emailAddressId: string; destination: string }
  | { kind: "new-password" };

export function getEmailSignInStep(result: SignInState): EmailSignInStep {
  if (result.status === "complete" && result.createdSessionId) {
    return { kind: "complete", sessionId: result.createdSessionId };
  }
  if (result.status === "needs_second_factor" || result.status === "needs_client_trust") {
    const emailFactor = result.supportedSecondFactors?.find((factor) => factor.strategy === "email_code");
    if (emailFactor?.emailAddressId) {
      return { kind: "email-code", emailAddressId: emailFactor.emailAddressId, destination: emailFactor.safeIdentifier };
    }
    throw new Error("Your account requires another verification method. Contact support to complete sign in.");
  }
  if (result.status === "needs_new_password") return { kind: "new-password" };
  throw new Error("Sign in could not finish. Please restart sign in and try again.");
}

export function getEmailSignInError(error: unknown, fallback: string): string {
  // Clerk API errors can be plain objects rather than Error instances.
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    const first = error.errors[0];
    if (first && typeof first === "object") {
      if (typeof first.longMessage === "string" && first.longMessage.trim()) return first.longMessage;
      if (typeof first.message === "string" && first.message.trim()) return first.message;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
