import type { SignInSecondFactor } from "@clerk/types";
import type { Locale } from "@/i18n/config";

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

const LOCALIZED_CLERK_ERRORS: Record<string, Record<Locale, string>> = {
  form_password_incorrect: { sr: "Email ili lozinka nisu ispravni. Pokušaj ponovo.", en: "The email or password is incorrect. Please try again.", ru: "Неверная почта или пароль. Попробуйте ещё раз." },
  form_identifier_not_found: { sr: "Email ili lozinka nisu ispravni. Pokušaj ponovo.", en: "The email or password is incorrect. Please try again.", ru: "Неверная почта или пароль. Попробуйте ещё раз." },
  form_code_incorrect: { sr: "Kod nije ispravan. Proveri ga i pokušaj ponovo.", en: "The code is incorrect. Check it and try again.", ru: "Неверный код. Проверьте его и попробуйте ещё раз." },
  verification_expired: { sr: "Kod je istekao. Zatraži novi kod.", en: "The code has expired. Request a new code.", ru: "Срок действия кода истёк. Запросите новый код." },
  form_identifier_exists: { sr: "Nalog sa ovim podacima već postoji. Pokušaj da se prijaviš.", en: "An account with these details already exists. Try signing in.", ru: "Аккаунт с такими данными уже существует. Попробуйте войти." },
  form_password_pwned: { sr: "Izaberi drugu lozinku koja nije korišćena u poznatom curenju podataka.", en: "Choose a different password that has not appeared in a known data breach.", ru: "Выберите другой пароль, который не встречался в известных утечках данных." },
  too_many_requests: { sr: "Previše pokušaja. Sačekaj malo pa pokušaj ponovo.", en: "Too many attempts. Wait a moment and try again.", ru: "Слишком много попыток. Немного подождите и попробуйте ещё раз." },
};

export function getEmailSignInError(error: unknown, fallback: string, locale?: Locale): string {
  // Clerk API errors can be plain objects rather than Error instances.
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    const first = error.errors[0];
    if (first && typeof first === "object") {
      if (locale) {
        return typeof first.code === "string" && LOCALIZED_CLERK_ERRORS[first.code]
          ? LOCALIZED_CLERK_ERRORS[first.code][locale]
          : fallback;
      }
      if (typeof first.longMessage === "string" && first.longMessage.trim()) return first.longMessage;
      if (typeof first.message === "string" && first.message.trim()) return first.message;
    }
  }
  if (locale) {
    if (error instanceof Error && error.message === "Your account requires another verification method. Contact support to complete sign in.") {
      return { sr: "Nalog zahteva drugi način potvrde. Obrati se podršci da završiš prijavu.", en: error.message, ru: "Для аккаунта нужен другой способ подтверждения. Обратитесь в поддержку, чтобы завершить вход." }[locale];
    }
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}
