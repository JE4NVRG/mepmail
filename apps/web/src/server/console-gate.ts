import { getDb } from "@millionsend/db";
import { getAuth } from "./auth";
import { isInstanceOperator } from "./instance-operator";

/**
 * The console's gate, shared by its layout and the pages under it: the
 * signed-in user when they are the instance operator, null for everyone
 * else — signed out or signed in alike, so a member learns nothing more
 * than a stranger. Callers answer null with notFound().
 */
export async function consoleOperator(
  headers: Headers,
): Promise<{ id: string; email: string; name: string } | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  return (await isInstanceOperator(getDb(), session.user.id)) ? session.user : null;
}
