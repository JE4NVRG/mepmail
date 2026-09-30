import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthArt } from "../src/components/auth/auth-art";

// Harness sintético dos hooks/DOM: browser real cobre rede, reprodução e layout.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  pending: [] as (() => void)[],
  video: { play: vi.fn(), pause: vi.fn(), playbackRate: 1, defaultPlaybackRate: 1 },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => undefined | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const previous = h.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      h.pending.push(() => {
        previous?.cleanup?.();
        h.slots[index] = { deps, cleanup: effect() };
      });
    }
  },
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render() {
  h.cursor = 0;
  const tree = nodes(AuthArt());
  for (const node of tree) {
    if (node.props.ref)
      (node.props.ref as { current: unknown }).current = node.type === "video" ? h.video : {};
  }
  if (!tree.some((n) => n.type === "video") && h.slots[1])
    (h.slots[1] as { current: unknown }).current = null;
  const effects = h.pending.splice(0);
  for (const effect of effects) effect();
  return tree;
}
let desktop: {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
let reduce: typeof desktop;
let update: () => void;
let visibility: string;
function settle() {
  render();
  return render();
}
function button(tree: Node[]) {
  const node = tree.find((n) => n.type === "button");
  if (!node) throw new Error("Expected playback control");
  return node;
}
function video(tree: Node[]) {
  return tree.find((n) => n.type === "video");
}
function event(node: Node | undefined, name: string) {
  if (!node) throw new Error("Expected event target");
  (node.props[name] as () => void)();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.slots = [];
  h.pending = [];
  h.video.pause.mockReset();
  h.video.playbackRate = 1;
  h.video.defaultPlaybackRate = 1;
  h.video.play.mockResolvedValue(undefined);
  desktop = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  reduce = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  visibility = "visible";
  vi.stubGlobal("window", {
    matchMedia: (query: string) => (query.includes("min-width") ? desktop : reduce),
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_: string, callback: () => void) => {
      update = callback;
    },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
});

describe("auth illustration: synthetic state harness", () => {
  it("SSR has responsive static poster, but no video or hidden mobile poster URL", () => {
    const tree = render();
    expect(video(tree)).toBeUndefined();
    expect(tree.find((n) => n.type === "source")?.props.media).toBe("(min-width: 960px)");
    expect(tree.find((n) => n.type === "img")?.props.src).toMatch(/^data:/);
  });
  it("mobile never mounts video; initial reduced motion only shows poster", () => {
    desktop.matches = false;
    expect(video(settle())).toBeUndefined();
    desktop.matches = true;
    reduce.matches = true;
    update();
    expect(video(settle())).toBeUndefined();
    expect(h.video.play).not.toHaveBeenCalled();
  });
  it("visible desktop plays muted inline loop with contain supplied by CSS", () => {
    const tree = settle();
    expect(video(tree)?.props).toMatchObject({
      muted: true,
      playsInline: true,
      loop: true,
      preload: "none",
    });
    expect(h.video.play).toHaveBeenCalled();
    expect(h.video.playbackRate).toBe(1.5);
    expect(h.video.defaultPlaybackRate).toBe(1.5);
    event(video(tree), "onPlaying");
    expect(button(render()).props.children).toContain("pauseAnimation");
  });
  it("manual pause survives visibility, rerender and dynamic motion changes", () => {
    let tree = settle();
    event(video(tree), "onPlaying");
    tree = render();
    event(button(tree), "onClick");
    event(video(tree), "onPause");
    settle();
    h.video.play.mockClear();
    visibility = "hidden";
    update();
    settle();
    visibility = "visible";
    update();
    settle();
    reduce.matches = true;
    update();
    expect(video(settle())).toBeUndefined();
    h.video.playbackRate = 1;
    h.video.defaultPlaybackRate = 1;
    reduce.matches = false;
    update();
    tree = settle();
    expect(h.video.play).not.toHaveBeenCalled();
    expect(button(tree).props.children).toContain("playAnimation");
    event(button(tree), "onClick");
    settle();
    expect(h.video.play).toHaveBeenCalled();
    expect(h.video.playbackRate).toBe(1.5);
    expect(h.video.defaultPlaybackRate).toBe(1.5);
  });
  it("visibility pauses automatic playback and resumes only on return", () => {
    settle();
    h.video.play.mockClear();
    h.video.pause.mockClear();
    visibility = "hidden";
    update();
    settle();
    expect(h.video.pause).toHaveBeenCalled();
    expect(h.video.play).not.toHaveBeenCalled();
    visibility = "visible";
    update();
    settle();
    expect(h.video.play).toHaveBeenCalled();
  });
  it("one gesture after denied autoplay does not abort pending native playback", async () => {
    h.video.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    settle();
    await Promise.resolve();
    const tree = settle();
    let resolvePlay!: () => void;
    let rejectPlay!: (error: Error) => void;
    h.video.play.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          resolvePlay = resolve;
          rejectPlay = reject;
        }),
    );
    h.video.pause.mockImplementation(() => rejectPlay?.(new Error("AbortError")));
    h.video.play.mockClear();
    h.video.pause.mockClear();
    event(button(tree), "onClick");
    settle();
    expect(h.video.play).toHaveBeenCalledTimes(1);
    expect(h.video.pause).not.toHaveBeenCalled();
    resolvePlay();
    await Promise.resolve();
    event(video(render()), "onPlaying");
    expect(button(settle()).props.children).toContain("pauseAnimation");
  });
  it("obsolete rejection cannot override a newer gesture across visibility changes", async () => {
    let rejectOld!: (error: Error) => void;
    h.video.play.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    );
    const tree = settle();
    event(button(tree), "onClick");
    settle();
    rejectOld(new Error("AbortError"));
    await Promise.resolve();
    settle();
    h.video.play.mockClear();
    visibility = "hidden";
    update();
    settle();
    visibility = "visible";
    update();
    settle();
    expect(h.video.play).toHaveBeenCalledTimes(1);
  });
  it("denied autoplay is caught; retry is a user gesture; media failure keeps poster", async () => {
    h.video.play.mockRejectedValue(new Error("NotAllowedError"));
    settle();
    await Promise.resolve();
    let tree = settle();
    expect(button(tree).props.children).toContain("playAnimation");
    h.video.play.mockResolvedValue(undefined);
    event(button(tree), "onClick");
    tree = settle();
    event(video(tree), "onError");
    tree = settle();
    expect(video(tree)).toBeUndefined();
    expect(tree.some((n) => n.type === "picture")).toBe(true);
  });
});
