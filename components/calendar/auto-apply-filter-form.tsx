"use client";

import { usePathname, useRouter } from "next/navigation";
import { buildCalendarFilterUrl } from "@/lib/events/calendar-filter-url";
import {
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useTransition,
} from "react";

type AutoApplyFilterFormProps = Omit<HTMLAttributes<HTMLFormElement>, "children" | "onSubmit"> & {
  children: ReactNode;
  closeOnApply?: boolean;
  searchDebounceMs?: number;
};

function buildFilterUrl(pathname: string, form: HTMLFormElement): string {
  return buildCalendarFilterUrl(
    pathname,
    new FormData(form).entries(),
    typeof window === "undefined" ? undefined : window.location.href,
  );
}

export function AutoApplyFilterForm({
  children,
  closeOnApply = false,
  searchDebounceMs,
  ...props
}: AutoApplyFilterFormProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  const applyFilters = useCallback(
    (form: HTMLFormElement) => {
      const targetUrl = buildFilterUrl(pathname || "/", form);
      if (closeOnApply) {
        form.closest("details")?.removeAttribute("open");
      }
      startTransition(() => {
        router.replace(targetUrl, { scroll: false });
      });
    },
    [closeOnApply, pathname, router],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    applyFilters(event.currentTarget);
  }

  function handleChange(event: FormEvent<HTMLFormElement>) {
    const target = event.target;
    if (searchDebounceMs !== undefined && target instanceof HTMLInputElement && target.type === "search") {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const form = event.currentTarget;
      searchTimer.current = setTimeout(() => applyFilters(form), searchDebounceMs);
      return;
    }
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    applyFilters(event.currentTarget);
  }

  return (
    <form
      {...props}
      data-calendar-auto-apply-filter-form="true"
      method="get"
      onChange={handleChange}
      onSubmit={handleSubmit}
    >
      {children}
    </form>
  );
}
