import type { MailboxFolder } from "@/lib/mailbox-inbox-presentation";

type MailboxIconName =
  | MailboxFolder
  | "refresh"
  | "restore"
  | "attachment"
  | "reply"
  | "replyAll"
  | "forward"
  | "read"
  | "unread"
  | "folderPlus"
  | "sliders"
  | "stack"
  | "chevronDown"
  | "sidebar"
  | "settings"
  | "monitor"
  | "sun"
  | "moon";

export function MailboxFolderIcon({
  name,
  filled = false,
  size = 17,
}: {
  name: MailboxIconName;
  filled?: boolean;
  size?: number;
}) {
  const paths: Record<MailboxIconName, string> = {
    inbox: "M3 4h18v14H3z M3 12h5l2 3h4l2-3h5",
    favorites: "m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9z",
    drafts: "M14 3H5v18h14V8z M14 3v5h5 M8 12h8 M8 16h5",
    sent: "m3 3 18 9-18 9 4-9z M7 12h14",
    spam: "M12 3 2 21h20z M12 9v5 M12 17h.01",
    quarantine: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M12 8v5 M12 16h.01",
    trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
    custom: "M3 6h7l2 3h9v12H3z M3 6V3h7l2 3h9v3",
    archive: "M3 4h18v4H3z M5 8v12h14V8 M10 12h4",
    refresh: "M20 7a9 9 0 1 0 1 8 M20 3v5h-5",
    restore: "M4 4v6h6 M4 10a8 8 0 1 1 1 8",
    attachment:
      "m20.5 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
    reply: "M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
    replyAll: "M7 14 2 9l5-5 M12 14 7 9l5-5 M7 9h9.5a5.5 5.5 0 0 1 0 11H14",
    forward: "m15 14 5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
    read: "M3 10 12 4l9 6v10H3z M3 10l9 6 9-6",
    unread: "M3 6h18v13H3z M3 7l9 6 9-6",
    folderPlus: "M3 6h7l2 3h9v12H3z M12 12v6 M9 15h6",
    sliders: "M4 7h9 M17 7h3 M13 4v6 M4 17h3 M11 17h9 M7 14v6",
    stack: "M3 9h18v11H3z M5 6h14 M7 3h10",
    chevronDown: "m6 9 6 6 6-6",
    sidebar: "M3 4h18v16H3z M9 4v16",
    settings:
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    monitor: "M3 4h18v12H3z M8 20h8 M12 16v4",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
