"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useTransition,
} from "react";

type AutoApplyFilterFormProps = Omit<HTMLAttributes<HTMLFormElement>, "children" | "onSubmit"> & {
  children: ReactNode;
  closeOnApply?: boolean;
};

function buildFilterUrl(pathname: string, form: HTMLFormElement): string {
  const formData = new FormData(form);
  const params = new URLSearchParams();

  for (const [key, rawValue] of formData.entries()) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const value = rawValue.trim();
    if (!value) {
      continue;
    }

    params.set(key, value);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function AutoApplyFilterForm({
  children,
  closeOnApply = false,
  ...props
}: AutoApplyFilterFormProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

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
    applyFilters(event.currentTarget);
  }

  function handleChange(event: FormEvent<HTMLFormElement>) {
    const target = event.target;
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
