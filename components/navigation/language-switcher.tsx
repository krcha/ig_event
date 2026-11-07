"use client";

import { Check, ChevronDown, Globe2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale } from "@/i18n/client";
import { localizeHref, type Locale } from "@/i18n/config";
import { accountText } from "@/lib/i18n/account-messages";

const LANGUAGE_OPTIONS: ReadonlyArray<{ locale: Locale; label: string }> = [
  { locale: "sr", label: "Srpski" },
  { locale: "en", label: "English" },
  { locale: "ru", label: "Русский" },
];

/** A language switch loads a fresh document so the server document language,
 * metadata and client providers always agree. */
export function LanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLAnchorElement | null>>([]);
  const [hash, setHash] = useState("");
  const current = LANGUAGE_OPTIONS.find(option => option.locale === locale)!;

  useEffect(() => {
    function updateHash() { setHash(window.location.hash); }
    updateHash();
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, [pathname, search]);

  useEffect(() => {
    if (!isOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setIsOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { setIsOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [isOpen]);

  function openAndFocus() {
    setHash(window.location.hash);
    setIsOpen(true);
    requestAnimationFrame(() => options.current[LANGUAGE_OPTIONS.findIndex(option => option.locale === locale)]?.focus());
  }

  const sourceHref = `${pathname}${search.size ? `?${search.toString()}` : ""}${hash}`;
  return (
    <div className="relative shrink-0" data-language-switcher ref={root}>
      <button
        aria-expanded={isOpen}
        aria-label={accountText(locale, "nav.chooseLanguage")}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium text-foreground hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:gap-1.5 lg:px-2"
        onClick={() => { setHash(window.location.hash); setIsOpen(value => !value); }}
        onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openAndFocus(); } }}
        ref={trigger}
        type="button"
      >
        <Globe2 aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="lg:hidden">{locale.toUpperCase()}</span>
        <span className="hidden lg:inline">{current.label}</span>
        <ChevronDown aria-hidden="true" className="hidden h-3 w-3 lg:block" />
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-full z-[90] mt-1 min-w-48 rounded-xl border border-border bg-card p-2 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.6)]">
          <p className="px-2 pb-2 pt-1 text-xs text-muted-foreground">{accountText(locale, "nav.chooseLanguage")}</p>
          {LANGUAGE_OPTIONS.map((option, index) => (
            <a
              aria-current={option.locale === locale ? "true" : undefined}
              className={option.locale === locale
                ? "flex min-h-11 items-center justify-between gap-4 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                : "flex min-h-11 items-center justify-between gap-4 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring"}
              href={localizeHref(sourceHref, option.locale)}
              hrefLang={option.locale === "sr" ? "sr-Latn" : option.locale}
              key={option.locale}
              lang={option.locale === "sr" ? "sr-Latn" : option.locale}
              onClick={() => setIsOpen(false)}
              onKeyDown={event => {
                let next: number | undefined;
                if (event.key === "ArrowDown") next = (index + 1) % LANGUAGE_OPTIONS.length;
                if (event.key === "ArrowUp") next = (index + LANGUAGE_OPTIONS.length - 1) % LANGUAGE_OPTIONS.length;
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = LANGUAGE_OPTIONS.length - 1;
                if (next !== undefined) { event.preventDefault(); options.current[next]?.focus(); }
              }}
              ref={element => { options.current[index] = element; }}
            >
              {option.label}{option.locale === locale ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
