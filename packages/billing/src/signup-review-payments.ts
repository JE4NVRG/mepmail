import Stripe from "stripe";
import { isLiveKey } from "./stripe.js";

export type SignupReviewPaymentStatus = "confirmed" | "not_observed" | "unknown";
export type SignupReviewPaymentReader = (
  customerIds: string[],
) => Promise<Record<string, SignupReviewPaymentStatus>>;

const LIMITS = {
  customers: 32,
  concurrency: 3,
  pages: 2,
  pageSize: 25,
  requestMs: 1_500,
  batchMs: 8_000,
} as const;

type PaymentRow = {
  id: string;
  customer: string | { id: string } | null;
  livemode: boolean;
};
type ReadResult<T> = { kind: "ok"; value: T } | { kind: "failed" | "stopped" };
type ScanResult = { status: SignupReviewPaymentStatus; stopped: boolean };

function belongsTo(row: PaymentRow, customerId: string): boolean {
  const customer = typeof row.customer === "string" ? row.customer : row.customer?.id;
  return customer === customerId && row.livemode === true;
}

/**
 * Read-only proof of a positive historical payment. Callers supply only customer
 * IDs already bound to their teams in the database; no email search is performed.
 * Missing/test credentials, incomplete history and provider errors stay unknown.
 */
export function createSignupReviewPaymentReader(
  secret: string | undefined,
): SignupReviewPaymentReader {
  let stripe: Stripe | undefined;
  // Shared by concurrent invocations of this reader, including timed-out calls.
  let inFlight = 0;

  async function request<T>(
    read: (timeout: number) => PromiseLike<T>,
    deadline: number,
  ): Promise<ReadResult<T>> {
    const timeout = Math.min(LIMITS.requestMs, deadline - Date.now());
    if (timeout <= 0 || inFlight >= LIMITS.concurrency) return { kind: "stopped" };
    inFlight += 1;
    // Keep the slot until the actual SDK operation settles. A dependency that
    // ignores its deadline cannot cause a later invocation to exceed the bound.
    const settled = Promise.resolve()
      .then(() => read(timeout))
      .then<ReadResult<T>, ReadResult<T>>(
        (value) => {
          inFlight -= 1;
          return { kind: "ok", value };
        },
        () => {
          inFlight -= 1;
          return { kind: "failed" };
        },
      );
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "stopped" }), timeout);
      void settled.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async function scan<T extends PaymentRow>(
    customerId: string,
    read: (cursor: string | undefined, timeout: number) => PromiseLike<Stripe.ApiList<T>>,
    valid: (row: T) => boolean,
    paid: (row: T) => boolean,
    deadline: number,
    ambiguous: (row: T) => boolean = () => false,
  ): Promise<ScanResult> {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < LIMITS.pages; pageNumber += 1) {
      const response = await request((timeout) => read(cursor, timeout), deadline);
      if (response.kind !== "ok")
        return { status: "unknown", stopped: response.kind === "stopped" };
      const page = response.value;
      if (
        !page ||
        !Array.isArray(page.data) ||
        page.data.length > LIMITS.pageSize ||
        typeof page.has_more !== "boolean" ||
        page.data.some(
          (row) =>
            !row ||
            typeof row.id !== "string" ||
            !/^(?:ch|in)_[A-Za-z0-9_]+$/.test(row.id) ||
            !belongsTo(row, customerId) ||
            !valid(row),
        )
      )
        return { status: "unknown", stopped: false };
      if (page.data.some(paid)) return { status: "confirmed", stopped: false };
      if (page.data.some(ambiguous)) return { status: "unknown", stopped: false };
      if (!page.has_more) return { status: "not_observed", stopped: false };
      const last = page.data.at(-1)?.id;
      if (!last || last === cursor) return { status: "unknown", stopped: false };
      cursor = last;
    }
    return { status: "unknown", stopped: false };
  }

  return async (customerIds) => {
    const result: Record<string, SignupReviewPaymentStatus> = Object.create(null);
    const unique = [...new Set(customerIds.filter((id) => /^cus_[A-Za-z0-9_]{1,128}$/.test(id)))];
    for (const id of unique) result[id] = "unknown";
    if (!unique.length || !secret || !isLiveKey(secret)) return result;
    if (!stripe) {
      try {
        stripe = new Stripe(secret, { timeout: LIMITS.requestMs, maxNetworkRetries: 0 });
      } catch {
        return result;
      }
    }
    const client = stripe;
    const pending = unique.slice(0, LIMITS.customers);
    const deadline = Date.now() + LIMITS.batchMs;
    let next = 0;
    const worker = async () => {
      while (next < pending.length && Date.now() < deadline) {
        const id = pending[next++];
        if (!id) return;
        const charges = await scan(
          id,
          (cursor, timeout) =>
            client.charges.list(
              {
                customer: id,
                limit: LIMITS.pageSize,
                ...(cursor ? { starting_after: cursor } : {}),
              },
              { timeout, maxNetworkRetries: 0 },
            ),
          (row) =>
            Number.isSafeInteger(row.amount) &&
            row.amount >= 0 &&
            typeof row.paid === "boolean" &&
            typeof row.captured === "boolean" &&
            ["succeeded", "pending", "failed"].includes(row.status),
          (row) => row.amount > 0 && row.paid && row.captured && row.status === "succeeded",
          deadline,
        );
        if (charges.status === "confirmed") {
          result[id] = "confirmed";
          continue;
        }
        if (charges.stopped) return;
        const invoices = await scan(
          id,
          (cursor, timeout) =>
            client.invoices.list(
              {
                customer: id,
                limit: LIMITS.pageSize,
                ...(cursor ? { starting_after: cursor } : {}),
              },
              { timeout, maxNetworkRetries: 0 },
            ),
          (row) =>
            Number.isSafeInteger(row.amount_paid) &&
            row.amount_paid >= 0 &&
            row.status !== null &&
            ["draft", "open", "paid", "uncollectible", "void"].includes(row.status),
          // Paid invoices may be settled by credits or marked paid out of band.
          // Only a succeeded captured Charge is payment proof in this adapter.
          () => false,
          deadline,
          (row) => row.amount_paid > 0,
        );
        result[id] =
          invoices.status === "confirmed"
            ? "confirmed"
            : charges.status === "not_observed" && invoices.status === "not_observed"
              ? "not_observed"
              : "unknown";
        if (invoices.stopped) return;
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, pending.length) }, worker));
    return result;
  };
}
