/** Server-owned MIME classification. Missing/unknown metadata never permits rewriting a draft. */
export type NativeDraftFormat = "plain_text" | "formatted" | "unknown";
export function nativeDraftIsReadOnly(item: { kind: string; draftMessageFormat?: unknown }) {
  return item.kind === "draft" && item.draftMessageFormat !== "formatted";
}
export function canChooseNativePlainText(input: {
  source: unknown;
  html: string | null;
  uploads: number;
  retained: number;
}) {
  // TipTap reports this exact empty paragraph on a fresh editor's onCreate.
  // Do not normalize/strip HTML: whitespace, marks, links and unknown shapes stay rich.
  const emptyEditor = !input.html || input.html === "<p></p>";
  return input.source == null && emptyEditor && input.uploads === 0 && input.retained === 0;
}
export function nativePlainTextSaveFields(input: {
  source: unknown;
  html: string | null;
  uploads: number;
  retained: number;
}) {
  if (!canChooseNativePlainText(input))
    throw new Error("plain_text_requires_new_unformatted_message");
  return { messageFormat: "plain_text" as const };
}
