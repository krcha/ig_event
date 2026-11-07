"use client";

import Link from "next/link";
import { CircleUserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";
import { accountText } from "@/lib/i18n/account-messages";

type ProfileAvatarLinkProps = {
  className?: string;
  isActive?: boolean;
  variant?: "desktop" | "mobile";
};

export function ProfileAvatarLink({
  className,
  isActive = false,
  variant = "mobile",
}: ProfileAvatarLinkProps) {
  const locale = useLocale();
  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      aria-label={accountText(locale, "nav.profile")}
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full ring-1 transition",
        variant === "desktop" ? "h-8.5 w-8.5" : "h-8 w-8",
        isActive
          ? "bg-primary text-primary-foreground ring-primary/30 shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
          : "bg-white/[0.05] text-muted-foreground ring-white/[0.08] hover:bg-primary/[0.16] hover:text-primary",
        className,
      )}
      href={localizeHref("/you", locale)}
      title={accountText(locale, "nav.profile")}
    >
      <CircleUserRound className="h-4 w-4" />
    </Link>
  );
}
