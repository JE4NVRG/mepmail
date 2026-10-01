import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { migrateLocked } from "./migrate.js";

/** Independent optional extension; do not pass the main migration directory here. */
export const mailboxMigrationsFolder = fileURLToPath(
  new URL("../mailbox-drizzle", import.meta.url),
);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url || !["true", "1"].includes(process.env.MAILBOX_REGISTRY_ENABLED ?? "")) {
    throw new Error(
      "Mailbox registry migration requires DATABASE_URL and MAILBOX_REGISTRY_ENABLED",
    );
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await migrateLocked(db, () =>
      migrate(db, {
        migrationsFolder: mailboxMigrationsFolder,
        migrationsTable: "__mailbox_migrations",
      }),
    );
    console.log("mailbox registry: migrations applied");
  } finally {
    await client.end();
  }
}
