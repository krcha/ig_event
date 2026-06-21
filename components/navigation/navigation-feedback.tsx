"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAVIGATION_FEEDBACK_TIMEOUT_MS = 10_000;

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function getSameOriginNavigationHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const anchor = target.closest("a[href]");
  if (!anchor || !(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  if (anchor.target && anchor.target !== "_self") {
    return null;
  }
  if (anchor.hasAttribute("download")) {
    return null;
  }

  const href = anchor.href;
  if (!href) {
    return null;
  }

  const nextUrl = new URL(href, window.location.href);
  if (nextUrl.origin !== window.location.origin) {
    return null;
  }
  if (nextUrl.href === window.location.href) {
    return null;
  }

  return nextUrl.href;
}

function shouldUseDocumentNavigation(href: string): boolean {
  const nextUrl = new URL(href, window.location.href);
  return nextUrl.pathname === window.location.pathname && nextUrl.search !== window.location.search;
}

function isGetFormNavigation(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLFormElement)) {
    return false;
  }
  const method = target.method.trim().toLowerCase();
  return method === "" || method === "get";
}

export function NavigationFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const routeKeyRef = useRef(routeKey);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    routeKeyRef.current = routeKey;
    setIsPending(false);
    document.documentElement.dataset.navigationPending = "false";
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [routeKey]);

  useEffect(() => {
    function startPending() {
      setIsPending(true);
      document.documentElement.dataset.navigationPending = "true";
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setIsPending(false);
        document.documentElement.dataset.navigationPending = "false";
        timeoutRef.current = null;
      }, NAVIGATION_FEEDBACK_TIMEOUT_MS);
    }

    function onPointerDown(event: PointerEvent) {
      if (event.defaultPrevented) {
        return;
      }
      if (!getSameOriginNavigationHref(event.target)) {
        return;
      }
      startPending();
    }

    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || !isPlainLeftClick(event)) {
        return;
      }
      const href = getSameOriginNavigationHref(event.target);
      if (!href) {
        return;
      }
      startPending();
      if (shouldUseDocumentNavigation(href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.assign(href);
      }
    }

    function onSubmit(event: SubmitEvent) {
      if (event.defaultPrevented || !isGetFormNavigation(event.target)) {
        return;
      }
      startPending();
    }

    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    window.addEventListener("click", onClick, { capture: true });
    window.addEventListener("submit", onSubmit, { capture: true });

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("submit", onSubmit, { capture: true });
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      document.documentElement.dataset.navigationPending = "false";
    };
  }, []);

  return (
    <div
      aria-hidden={!isPending}
      className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-3 pt-[env(safe-area-inset-top)]"
      data-navigation-feedback="true"
      data-pending={isPending ? "true" : "false"}
    >
      <div className="mt-1 h-1 w-full max-w-[28rem] overflow-hidden rounded-full bg-white/[0.08] opacity-0 shadow-[0_16px_44px_-24px_rgba(139,134,251,0.95)] transition-opacity duration-150 data-[pending=true]:opacity-100">
        <div className="h-full w-1/2 animate-[navigation-feedback_1s_ease-in-out_infinite] rounded-full bg-primary" />
      </div>
      <span className="sr-only" role="status">
        {isPending ? "Loading" : ""}
      </span>
    </div>
  );
}
