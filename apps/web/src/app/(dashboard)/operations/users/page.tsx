import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { UsersView } from "@/components/console/users/users-view";
import { usersDirectoryReader } from "@/server/users-directory-gate";

/** A read-only directory; every request is authorized on the server. */
export default async function OperationsUsersPage() {
  const reader = await usersDirectoryReader(await headers());
  if (!reader) notFound();
  return <UsersView readOnly />;
}
