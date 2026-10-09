import type { ImapFolder, ImapSession } from "./imap";

/** Envelope and visible recipients; From only counts in a Sent folder (an address the account sends as). */
const RECIPIENT_FIELDS = ["TO", "CC", "DELIVERED-TO", "X-ORIGINAL-TO", "ENVELOPE-TO"] as const;
const FIELDS = [...RECIPIENT_FIELDS, "FROM"] as const;
const ADDRESS =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;
const SKIPPED =
  /^(?:trash|lixeira|lixo|deleted|spam|junk|lixo eletr[oô]nico|bulk|\[gmail\]\/(?:all mail|todos os e-mails|trash|lixeira|spam))$/i;

export interface ScanProgress {
  foldersDone: number;
  foldersTotal: number;
  messagesSeen: number;
  truncated: boolean;
}
export interface ScanResult extends ScanProgress {
  /** Own-domain addresses: message count and the newest internal date. */
  addresses: Map<string, { messages: number; lastSeenAt: Date | null }>;
  /** Everything else, counted by domain only. */
  external: Map<string, number>;
}

/** Folders worth reading: selectable, not trash/spam, not Gmail's All Mail duplicate. */
export function scannableFolders(folders: readonly ImapFolder[]): ImapFolder[] {
  return folders.filter(
    (folder) =>
      !folder.flags.includes("\\noselect") &&
      !folder.flags.includes("\\nonexistent") &&
      !folder.flags.includes("\\trash") &&
      !folder.flags.includes("\\junk") &&
      !folder.flags.includes("\\all") &&
      !SKIPPED.test(folder.display.trim()),
  );
}

export function sentFolder(folder: ImapFolder): boolean {
  return (
    folder.flags.includes("\\sent") ||
    /(^|\/)(sent|enviad|itens enviados|sent items)/i.test(folder.display)
  );
}

/** Header block -> lower-case field name -> unfolded values. */
export function headerFields(header: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const line of header.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), line.slice(colon + 1)]);
  }
  return fields;
}

export async function scanAccount(
  session: ImapSession,
  input: {
    ownDomains: ReadonlySet<string>;
    perFolderCap?: number;
    batchSize?: number;
    onProgress?: (progress: ScanProgress) => void;
    cancelled?: () => boolean;
  },
): Promise<ScanResult> {
  const cap = input.perFolderCap ?? 50_000;
  const batch = input.batchSize ?? 500;
  const folders = scannableFolders(await session.list());
  const result: ScanResult = {
    foldersDone: 0,
    foldersTotal: folders.length,
    messagesSeen: 0,
    truncated: false,
    addresses: new Map(),
    external: new Map(),
  };
  input.onProgress?.(result);
  for (const folder of folders) {
    if (input.cancelled?.()) break;
    const { exists } = await session.examine(folder.name);
    const oldest = Math.max(1, exists - cap + 1);
    if (exists > cap) result.truncated = true;
    const fromIsOurs = sentFolder(folder);
    // Newest first, so a ceiling keeps the most recent mail.
    for (let high = exists; high >= oldest; high -= batch) {
      if (input.cancelled?.()) break;
      const low = Math.max(oldest, high - batch + 1);
      for (const message of await session.fetchHeaders(low, high, FIELDS)) {
        const fields = headerFields(message.header);
        const seen = new Set<string>();
        const names = fromIsOurs ? [...RECIPIENT_FIELDS, "FROM"] : RECIPIENT_FIELDS;
        for (const name of names)
          for (const value of fields.get(name.toLowerCase()) ?? [])
            for (const address of value.match(ADDRESS) ?? []) seen.add(address.toLowerCase());
        const externalDomains = new Set<string>();
        for (const address of seen) {
          const domain = address.slice(address.lastIndexOf("@") + 1);
          if (!input.ownDomains.has(domain)) {
            externalDomains.add(domain);
            continue;
          }
          const entry = result.addresses.get(address) ?? { messages: 0, lastSeenAt: null };
          entry.messages++;
          if (
            message.internalDate &&
            (!entry.lastSeenAt || message.internalDate > entry.lastSeenAt)
          )
            entry.lastSeenAt = message.internalDate;
          result.addresses.set(address, entry);
        }
        for (const domain of externalDomains)
          result.external.set(domain, (result.external.get(domain) ?? 0) + 1);
        result.messagesSeen++;
      }
      input.onProgress?.(result);
    }
    result.foldersDone++;
    input.onProgress?.(result);
  }
  return result;
}
