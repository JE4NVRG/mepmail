import { getUntypedClient, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "@/server/routers";
import type {
  ApplyResult,
  MigrationConnectInput,
  MigrationSource,
  MigrationStatus,
  MxReadiness,
  PlanItem,
  PlanSummary,
} from "./mailbox-migration";

/**
 * The server side of the migration assistant, as the component sees it. The
 * calls go through the untyped tRPC client by path, so this file compiles
 * before the `mailboxes.migration` router exists; once it does, the typed
 * proxy can replace these five lines.
 */
export type MigrationApi = {
  connect(input: MigrationConnectInput): Promise<MigrationSource>;
  status(sourceId: string): Promise<MigrationStatus>;
  plan(sourceId: string, items: PlanItem[]): Promise<PlanSummary>;
  apply(sourceId: string, items: PlanItem[]): Promise<ApplyResult>;
  mxReadiness(sourceId: string): Promise<MxReadiness>;
};

export function createMigrationApi(client: TRPCClient<AppRouter>): MigrationApi {
  const raw = getUntypedClient(client);
  return {
    connect: (input) =>
      raw.mutation("mailboxes.migration.connect", input) as Promise<MigrationSource>,
    status: (sourceId) =>
      raw.query("mailboxes.migration.status", { sourceId }) as Promise<MigrationStatus>,
    plan: (sourceId, items) =>
      raw.mutation("mailboxes.migration.plan", { sourceId, items }) as Promise<PlanSummary>,
    apply: (sourceId, items) =>
      raw.mutation("mailboxes.migration.applyPlan", { sourceId, items }) as Promise<ApplyResult>,
    mxReadiness: (sourceId) =>
      raw.query("mailboxes.migration.mxReadiness", { sourceId }) as Promise<MxReadiness>,
  };
}
