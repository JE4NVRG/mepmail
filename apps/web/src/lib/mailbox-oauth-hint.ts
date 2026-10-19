/**
 * The address typed in the connect dialog goes to the provider as a login hint only when that
 * provider can own it. A domain address (jean@empresa.com) sent to Microsoft signs a Microsoft
 * account in under that alias, and Outlook.com then refuses IMAP for it: "User is authenticated
 * but not connected" (Jean, 19/10). Google gets only its own addresses too.
 */
// microsoft mirrors MICROSOFT_CONSUMER_ADDRESS in packages/core/src/mailbox-external-oauth.ts.
const OWN: Record<"microsoft" | "google", RegExp> = {
  microsoft: /@(outlook|hotmail|live|msn)\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/,
  google: /@(gmail|googlemail)\.com$/,
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mailboxOAuthLoginHint(
  provider: "microsoft" | "google",
  address: string | undefined,
): string | null {
  const hint = address?.trim().toLowerCase();
  return hint && EMAIL.test(hint) && OWN[provider].test(hint) ? hint : null;
}
