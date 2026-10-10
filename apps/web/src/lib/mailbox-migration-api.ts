import { getUntypedClient, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "@/server/routers";
import type { ImportJob, ImportTarget } from "./mailbox-import";
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
  /** History import (mailboxes.migration.import*): the password is held in memory only. */
  importStart(input: {
    host: string;
    port: 993;
    username: string;
    password: string;
    mailboxId: string;
    folders: { name: string; target: ImportTarget; folderId?: string | null }[];
  }): Promise<ImportJob>;
  importStatus(jobId: string): Promise<ImportJob>;
  importJobs(mailboxId: string | null): Promise<ImportJob[]>;
  importResume(jobId: string, password: string): Promise<ImportJob>;
  importCancel(jobId: string): Promise<ImportJob>;
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
    importStart: (input) =>
      raw.mutation("mailboxes.migration.importStart", input) as Promise<ImportJob>,
    importStatus: (jobId) =>
      raw.query("mailboxes.migration.importStatus", { jobId }) as Promise<ImportJob>,
    importJobs: (mailboxId) =>
      raw.query("mailboxes.migration.importJobs", { mailboxId }) as Promise<ImportJob[]>,
    importResume: (jobId, password) =>
      raw.mutation("mailboxes.migration.importResume", { jobId, password }) as Promise<ImportJob>,
    importCancel: (jobId) =>
      raw.mutation("mailboxes.migration.importCancel", { jobId }) as Promise<ImportJob>,
  };
}
