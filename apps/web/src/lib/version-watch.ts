/**
 * Notices a new MepMail release while a page stays open: a browser tab left for days, or
 * the Windows app, which keeps its window alive in the tray and never reloads by itself.
 * The page knows the revision it was rendered with; the server answers the one it runs
 * now (GET /api/version). A different, well-formed one is a new release.
 */
export const VERSION_CHECK_INTERVAL_MS = 10 * 60_000;
/** Focus and visibility changes come in bursts: one check per minute at most. */
export const VERSION_CHECK_MIN_GAP_MS = 60_000;

const REVISION = /^[0-9a-f]{7,64}$/;

/** Unknown on either side (a local build, a failed read) is never a new release. */
export function isNewRevision(page: string | null | undefined, served: unknown): served is string {
  return (
    typeof page === "string" &&
    REVISION.test(page) &&
    typeof served === "string" &&
    REVISION.test(served) &&
    served !== page
  );
}

export interface VersionWatchEnvironment {
  /** Reads the served revision; any failure answers null. */
  fetchRevision: () => Promise<unknown>;
  visible: () => boolean;
  now: () => number;
  onVisible: (listener: () => void) => () => void;
  every: (ms: number, run: () => void) => () => void;
}

/**
 * Checks on an interval and whenever the page comes back into view, while it is visible.
 * Calls onNewRevision once per new revision. Returns the stop function.
 */
export function startVersionWatch(
  revision: string | null | undefined,
  onNewRevision: (served: string) => void,
  env: VersionWatchEnvironment,
): () => void {
  if (!revision || !REVISION.test(revision)) return () => {};
  let last = Number.NEGATIVE_INFINITY;
  let announced: string | null = null;
  let stopped = false;
  const check = async () => {
    if (stopped || !env.visible()) return;
    const at = env.now();
    if (at - last < VERSION_CHECK_MIN_GAP_MS) return;
    last = at;
    let served: unknown = null;
    try {
      served = await env.fetchRevision();
    } catch {
      return;
    }
    if (stopped || !isNewRevision(revision, served) || served === announced) return;
    announced = served;
    onNewRevision(served);
  };
  const stopInterval = env.every(VERSION_CHECK_INTERVAL_MS, () => void check());
  const stopVisible = env.onVisible(() => void check());
  return () => {
    stopped = true;
    stopInterval();
    stopVisible();
  };
}
