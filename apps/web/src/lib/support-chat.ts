/**
 * The support chat runs only on /support and /support/chat, the pages whose
 * policy loads the Elozi widget: the dashboard never runs that script. From the
 * dashboard it opens in its own small window; a blocked popup falls back to
 * the same tab.
 */
export const SUPPORT_CHAT_PATH = "/support/chat";

export function openSupportChat(view: Pick<Window, "open" | "location"> = window): void {
  const popup = view.open(SUPPORT_CHAT_PATH, "mepmail-support", "popup=yes,width=440,height=720");
  if (popup) popup.focus();
  else view.location.assign(SUPPORT_CHAT_PATH);
}
