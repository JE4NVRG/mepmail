/**
 * "Move to": the folders of one mailbox filtered by what the person types,
 * and whether that text can become a new folder. The rules mirror the server
 * (packages/core mailbox-organization): names are trimmed with inner spaces
 * collapsed, at most 80 characters, unique per mailbox ignoring case, and a
 * mailbox holds at most 50 folders.
 */

export const MAILBOX_FOLDER_NAME_MAX = 80;
export const MAILBOX_FOLDERS_MAX = 50;

export type MailboxMoveFolder = { id: string; name: string };

export function normalizeMailboxFolderName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/**
 * Folders whose name contains the query (ignoring case and accents), in their
 * own order, plus the name a new folder would get: null when the query is
 * empty, too long, already a folder name (ignoring case, as the server does)
 * or the mailbox is full.
 */
export function mailboxMoveOptions<F extends MailboxMoveFolder>(
  folders: readonly F[],
  query: string,
): { matches: F[]; createName: string | null } {
  const name = normalizeMailboxFolderName(query);
  const key = fold(name);
  const matches = key ? folders.filter((folder) => fold(folder.name).includes(key)) : [...folders];
  const taken = folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase());
  const createName =
    name && name.length <= MAILBOX_FOLDER_NAME_MAX && !taken && folders.length < MAILBOX_FOLDERS_MAX
      ? name
      : null;
  return { matches, createName };
}
