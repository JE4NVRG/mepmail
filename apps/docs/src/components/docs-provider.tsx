"use client";

import { type Framework, FrameworkProvider } from "fumadocs-core/framework";
import { RootProvider, type RootProviderProps } from "fumadocs-ui/provider/base";
import Image from "next/image";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { i18n } from "../lib/i18n";

export function publicDocsPathname(pathname: string): string {
  const prefix = `/${i18n.defaultLanguage}`;
  if (i18n.hideLocale !== "default-locale") return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

function useDocsPathname(): string {
  // Prerendering sees /en/*; the browser sees the unprefixed public URL.
  // Fumadocs uses this path for the page tree, TOC title and pagination.
  return publicDocsPathname(usePathname());
}

export function DocsProvider({ children, ...props }: RootProviderProps) {
  return (
    <FrameworkProvider
      // The framework's HTML props are looser than Next's required href/src.
      // Keep the exact Next components used by Fumadocs' own NextProvider.
      Link={Link as NonNullable<Framework["Link"]>}
      Image={Image as NonNullable<Framework["Image"]>}
      useParams={useParams}
      useRouter={useRouter}
      usePathname={useDocsPathname}
    >
      <RootProvider {...props}>{children}</RootProvider>
    </FrameworkProvider>
  );
}
