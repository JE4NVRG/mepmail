import { canReadUserDirectory, isInstanceOperator } from "@millionsend/core";
import { type Db, getDb } from "@millionsend/db";
import { getAuth } from "./auth";

export interface UsersDirectoryGateDeps {
  session(headers: Headers): Promise<{ user: { id: string; email: string; name: string } } | null>;
  db(): Db;
}

const defaultDeps: UsersDirectoryGateDeps = {
  session: (headers) => getAuth().api.getSession({ headers }),
  db: getDb,
};

/** A separate read page: delegated readers never pass consoleOperator. */
export async function usersDirectoryReader(
  headers: Headers,
  deps: UsersDirectoryGateDeps = defaultDeps,
) {
  const session = await deps.session(headers);
  if (!session) return null;
  const db = deps.db();
  return (await isInstanceOperator(db, session.user.id)) ||
    (await canReadUserDirectory(db, session.user.id))
    ? session.user
    : null;
}
