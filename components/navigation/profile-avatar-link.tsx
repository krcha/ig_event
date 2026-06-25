"use client";

import Link from "next/link";
import { CircleUserRound } from "lucide-react";
import { cn } from "@/lib/utils";

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
  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      aria-label="Your profile"
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full ring-1 transition",
        variant === "desktop" ? "h-10 w-10" : "h-9 w-9",
        isActive
          ? "bg-primary text-primary-foreground ring-primary/30 shadow-[0_16px_34px_-22px_rgba(14,116,144,0.52)]"
          : "bg-white/[0.05] text-muted-foreground ring-white/[0.08] hover:bg-primary/[0.16] hover:text-primary",
        className,
      )}
      href="/you"
      title="Your profile"
    >
      <CircleUserRound className="h-4 w-4" />
    </Link>
  );
}
