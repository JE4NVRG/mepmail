import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/version/route";
import {
  isNewRevision,
  startVersionWatch,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_CHECK_MIN_GAP_MS,
  type VersionWatchEnvironment,
} from "../src/lib/version-watch";

const OLD = "137565a2176936a1f8e40314bca8273499a000cf";
const NEW = "b1417d2e0701cc0aee726f13b0564749709a9ac0";

function fakeEnvironment(served: () => unknown) {
  let clock = 1_000_000;
  let visible = true;
  const visibleListeners: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const fetchRevision = vi.fn(async () => served());
  const env: VersionWatchEnvironment = {
    fetchRevision,
    visible: () => visible,
    now: () => clock,
    onVisible: (listener) => {
      visibleListeners.push(listener);
      return () => visibleListeners.splice(visibleListeners.indexOf(listener), 1);
    },
    every: (ms, run) => {
      expect(ms).toBe(VERSION_CHECK_INTERVAL_MS);
      intervals.push(run);
      return () => intervals.splice(intervals.indexOf(run), 1);
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    env,
    fetchRevision,
    advance: (ms: number) => {
      clock += ms;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    comeBack: async () => {
      for (const listener of [...visibleListeners]) listener();
      await settle();
    },
    tick: async () => {
      for (const run of [...intervals]) run();
      await settle();
    },
    listeners: () => visibleListeners.length + intervals.length,
  };
}

describe("new release detection", () => {
  it("accepts only two known, different revisions", () => {
    expect(isNewRevision(OLD, NEW)).toBe(true);
    expect(isNewRevision(OLD, OLD)).toBe(false);
    expect(isNewRevision(null, NEW)).toBe(false);
    expect(isNewRevision("local", NEW)).toBe(false);
    expect(isNewRevision(OLD, null)).toBe(false);
    expect(isNewRevision(OLD, "<html>")).toBe(false);
    expect(isNewRevision(OLD, 42)).toBe(false);
  });

  it("announces a new release once, when the page comes back or on the interval", async () => {
    let served: unknown = OLD;
    const fake = fakeEnvironment(() => served);
    const onNew = vi.fn();
    const stop = startVersionWatch(OLD, onNew, fake.env);
    await fake.comeBack();
    expect(fake.fetchRevision).toHaveBeenCalledTimes(1);
    expect(onNew).not.toHaveBeenCalled();
    // A deploy: the Windows app reopened from the tray within a minute is not asked again.
    served = NEW;
    await fake.comeBack();
    expect(fake.fetchRevision).toHaveBeenCalledTimes(1);
    fake.advance(VERSION_CHECK_MIN_GAP_MS);
    await fake.comeBack();
    expect(onNew).toHaveBeenCalledWith(NEW);
    // The same release is not announced twice; the interval keeps checking.
    fake.advance(VERSION_CHECK_INTERVAL_MS);
    await fake.tick();
    expect(fake.fetchRevision).toHaveBeenCalledTimes(3);
    expect(onNew).toHaveBeenCalledTimes(1);
    stop();
    expect(fake.listeners()).toBe(0);
  });

  it("does not ask while hidden, ignores failed reads and never runs without a page revision", async () => {
    const fake = fakeEnvironment(() => {
      throw new Error("offline");
    });
    const onNew = vi.fn();
    startVersionWatch(OLD, onNew, fake.env);
    fake.setVisible(false);
    await fake.tick();
    expect(fake.fetchRevision).not.toHaveBeenCalled();
    fake.setVisible(true);
    await fake.tick();
    expect(fake.fetchRevision).toHaveBeenCalledTimes(1);
    expect(onNew).not.toHaveBeenCalled();
    const idle = fakeEnvironment(() => NEW);
    startVersionWatch(null, onNew, idle.env);
    expect(idle.listeners()).toBe(0);
  });
});

describe("GET /api/version", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("answers the running revision, never cached", async () => {
    vi.stubEnv("MILLIONSEND_REVISION", NEW);
    const response = GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ revision: NEW });
    vi.stubEnv("MILLIONSEND_REVISION", undefined);
    expect(await GET().json()).toEqual({ revision: null });
  });
});
