"use client";

import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type DataAttributes = {
  [key: `data-${string}`]: boolean | number | string | undefined;
};

type ReadMoreTextProps = {
  bodyClassName?: string;
  buttonClassName?: string;
  collapsedButtonClassName?: string;
  className?: string;
  lessLabel?: string;
  lines?: number;
  moreLabel?: string;
  paragraphProps?: Omit<HTMLAttributes<HTMLParagraphElement>, "children" | "className" | "style"> &
    DataAttributes;
  prefix?: ReactNode;
  text: string;
  textClassName?: string;
};

function getCollapsedStyle(lines: number): CSSProperties {
  return {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: lines,
  };
}

export function ReadMoreText({
  bodyClassName,
  buttonClassName,
  collapsedButtonClassName,
  className,
  lessLabel = "less",
  lines = 2,
  moreLabel = "more",
  paragraphProps,
  prefix,
  text,
  textClassName,
}: ReadMoreTextProps) {
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setCanExpand(false);
  }, [lines, text]);

  useEffect(() => {
    const paragraph = paragraphRef.current;
    if (!paragraph || expanded) {
      return undefined;
    }

    const updateOverflow = () => {
      setCanExpand(paragraph.scrollHeight > paragraph.clientHeight + 1);
    };

    updateOverflow();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    resizeObserver?.observe(paragraph);
    window.addEventListener("resize", updateOverflow);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateOverflow);
    };
  }, [expanded, lines, text]);

  return (
    <div className={cn("relative", className)}>
      <p
        {...paragraphProps}
        className={cn("whitespace-pre-line", canExpand && !expanded ? "pr-14" : null, textClassName)}
        data-read-more-text="true"
        ref={paragraphRef}
        style={expanded ? undefined : getCollapsedStyle(lines)}
      >
        {prefix ? <>{prefix} </> : null}
        <span className={bodyClassName}>{text}</span>
      </p>
      {canExpand ? (
        <button
          aria-expanded={expanded}
          className={cn(
            "inline-flex text-sm font-semibold text-muted-foreground transition hover:text-foreground",
            expanded ? "mt-1" : "absolute bottom-0 right-0 pl-1",
            buttonClassName,
            expanded ? null : collapsedButtonClassName,
          )}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      ) : null}
    </div>
  );
}
