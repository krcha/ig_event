import { EmailAuthCard } from "@/components/auth/email-auth-card";
import Link from "next/link";
import { getLocale } from "@/i18n/server";
import { localizeHref, LOCALE_LANGUAGE_TAGS } from "@/i18n/config";
import { accountText } from "@/lib/i18n/account-messages";

export default async function SignUpPage() {
  const locale = await getLocale();
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 py-10 text-center" lang={LOCALE_LANGUAGE_TAGS[locale]}>
        <h1 className="text-2xl font-semibold">{accountText(locale, "auth.signUpUnavailable")}</h1>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">{accountText(locale, "auth.tryLater")}</p>
        <Link className="button-secondary min-h-11 px-4" href={localizeHref("/", locale)}>{accountText(locale, "install.backEvents")}</Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <EmailAuthCard mode="sign-up" />
    </div>
  );
}
