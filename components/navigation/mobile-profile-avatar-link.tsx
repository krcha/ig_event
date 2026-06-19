"use client";

import Link from "next/link";
import { CircleUserRound } from "lucide-react";
import { cn } from "@/lib/utils";

type MobileProfileAvatarLinkProps = {
  className?: string;
};

export function MobileProfileAvatarLink({ className }: MobileProfileAvatarLinkProps) {
  return (
    <Link
      aria-label="Your profile"
      className={cn(
        "inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/[0.05] text-muted-foreground ring-1 ring-white/[0.08] transition hover:bg-primary/[0.16] hover:text-primary",
        className,
      )}
      href="/you"
    >
      <CircleUserRound className="h-4 w-4" />
    </Link>
  );
}
