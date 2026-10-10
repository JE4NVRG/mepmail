import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { resolveEloziSupportChannel } from "@/lib/elozi-support";
import { hasSession } from "@/server/auth";
import { eloziIdentityKey } from "@/server/support-identity";
import { SupportChatWindow, type SupportChatWindowLabels } from "./support-chat-window";
import "./support-chat.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("support");
  return {
    title: { absolute: t("chatWindow.title") },
    robots: { index: false, follow: false },
  };
}

/** The window the dashboard's "Support" button opens: only the chat, verified when signed in. */
export default async function SupportChatPage() {
  const t = await getTranslations("support");
  const identified = !!eloziIdentityKey() && (await hasSession());
  return (
    <SupportChatWindow
      config={resolveEloziSupportChannel()}
      identified={identified}
      labels={t.raw("chatWindow") as SupportChatWindowLabels}
    />
  );
}
