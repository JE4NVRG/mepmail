import { redirect } from "next/navigation";

/** Correio moved to its own full-window app; old links land there. */
export default function MailboxesPage() {
  redirect("/mail");
}
