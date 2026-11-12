import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

// Execute the actual handler body without starting the worker or its queues.
const path = new URL("../src/server.ts", import.meta.url);
const source = readFileSync(path, "utf8");
// Extract this exact callback up to its neighboring handler, then execute it.
// No compiler API is required (the pinned TypeScript CLI need not expose one).
const handler = source.match(
  /"sends\.reconcile":\s*(async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\}),\s*\n\s*"retention\.purge":/,
)?.[1];
if (!handler) throw new Error("Missing actual sends.reconcile handler");
const code = `module.exports = ${handler};`;

it.each([
  { registry: true, transport: true, domain: 1, directAlert: 0 },
  { registry: true, transport: false, domain: 0, directAlert: 1 },
  { registry: false, transport: false, domain: 0, directAlert: 0 },
])("preserves transport admission and alert coverage: %j", async (flags) => {
  const context = {
    module: { exports: undefined as unknown },
    db: {},
    enqueueSends: vi.fn(),
    queueAdmission: undefined,
    mailboxRegistryEnabled: flags.registry,
    mailboxTransportEnabled: flags.transport,
    reconcileStalledSends: vi.fn(async () => 0),
    reconcileMailboxOutbox: vi.fn(async () => ({ requeued: 0, unknown: 0 })),
    alertRetainedMailboxSends: vi.fn(async () => ({
      alerted: 0,
      recovered: 0,
      failed: false,
      skipped: false,
    })),
    queue: { send: vi.fn() },
    console: { log: vi.fn() },
  };
  vm.runInNewContext(code, context);
  if (typeof context.module.exports !== "function")
    throw new Error("Invalid actual reconcile handler");
  await context.module.exports();
  expect(context.reconcileMailboxOutbox).toHaveBeenCalledTimes(flags.domain);
  expect(context.alertRetainedMailboxSends).toHaveBeenCalledTimes(flags.directAlert);
  expect(context.reconcileStalledSends).toHaveBeenCalledTimes(1);
  expect(context.queue.send).not.toHaveBeenCalled();
});
