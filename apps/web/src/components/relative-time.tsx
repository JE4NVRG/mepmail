"use client";

import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Tooltip } from "./tooltip";

/** Compact relative stamp ("4h ago"); the exact local date and time on hover. */
export function RelativeTime({ date }: { date: Date | string | number }) {
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const d = new Date(date);
  const isoDay = Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  return (
    <Tooltip inline text={mounted ? formatDateTime(d, locale) : isoDay}>
      <time dateTime={Number.isNaN(d.getTime()) ? undefined : d.toISOString()}>
        {mounted ? formatRelative(d, locale) : isoDay}
      </time>
    </Tooltip>
  );
}
