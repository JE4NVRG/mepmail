import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EloziSupport } from "@/components/elozi-support";
import {
  createEloziSupportSession,
  ELOZI_SUPPORT_ORIGIN,
  resolveEloziSupportChannel,
} from "@/lib/elozi-support";
import en from "../messages/en/support.json";
import pt from "../messages/pt-BR/support.json";

const config = { tenantId: "test_tenant", channelId: "test_channel" };
const fixture = () => {
  const widget = { open: vi.fn(), destroy: vi.fn() };
  const module = { createWebchatWidget: vi.fn(() => widget) };
  return { widget, module, load: vi.fn(async () => module), status: vi.fn() };
};

describe("page-scoped visitor support", () => {
  it("fails closed with disabled, missing or malformed channel identifiers", () => {
    expect(resolveEloziSupportChannel()).toBeNull();
    for (const channel of [
      { enabled: false, ...config },
      { enabled: true, tenantId: "", channelId: "test_channel" },
      { enabled: true, tenantId: "tenant", channelId: "x?token=secret" },
      { enabled: true, tenantId: "tenant", channelId: "a".repeat(121) },
    ]) {
      expect(resolveEloziSupportChannel(channel)).toBeNull();
    }
    expect(resolveEloziSupportChannel({ enabled: true, ...config })).toEqual(config);
  });

  it.each([pt, en])("renders an honest fallback without a chat loader during SSR", (copy) => {
    const html = renderToStaticMarkup(
      createElement(EloziSupport, { config: null, labels: copy.assistant }),
    );
    expect(html).toContain(copy.assistant.pending);
    expect(html).toContain("mailto:support@je4ndev.com");
    expect(html).toContain("https://docs-mepmail.je4ndev.com");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<button");
    expect(JSON.stringify(copy)).not.toMatch(/one business day|1 dia útil/i);
  });

  it("does not load before a click and coalesces repeated clicks without identity", async () => {
    const f = fixture();
    const session = createEloziSupportSession(config, f.status, f.load);
    expect(f.load).not.toHaveBeenCalled();
    const first = session.open();
    expect(session.open()).toBe(first);
    expect(await first).toBe(true);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.module.createWebchatWidget).toHaveBeenCalledExactlyOnceWith({
      apiOrigin: ELOZI_SUPPORT_ORIGIN,
      ...config,
    });
    await session.open();
    expect(f.module.createWebchatWidget).toHaveBeenCalledTimes(1);
    expect(f.widget.open).toHaveBeenCalledTimes(2);
    session.destroy();
    session.destroy();
    expect(f.widget.destroy).toHaveBeenCalledTimes(1);
    expect(await session.open()).toBe(false);
  });

  it("never creates a late widget after the page unmounts during import", async () => {
    const f = fixture();
    let finish!: (module: typeof f.module) => void;
    const load = () =>
      new Promise<typeof f.module>((resolve) => {
        finish = resolve;
      });
    const session = createEloziSupportSession(config, f.status, load);
    const opening = session.open();
    session.destroy();
    finish(f.module);
    expect(await opening).toBe(false);
    expect(f.module.createWebchatWidget).not.toHaveBeenCalled();
    expect(f.status.mock.calls).toEqual([["loading"]]);
  });

  it("allows retry after a module/CORS failure without creating a stray widget", async () => {
    const f = fixture();
    f.load.mockRejectedValueOnce(new Error("CORS"));
    const session = createEloziSupportSession(config, f.status, f.load);
    expect(await session.open()).toBe(false);
    expect(f.status).toHaveBeenLastCalledWith("error");
    expect(f.module.createWebchatWidget).not.toHaveBeenCalled();
    expect(await session.open()).toBe(true);
    session.destroy();
    expect(f.widget.destroy).toHaveBeenCalledTimes(1);
  });

  it("disposes a failed opening and retries with a fresh handle", async () => {
    const f = fixture();
    f.widget.open.mockImplementationOnce(() => {
      throw new Error("not available");
    });
    const session = createEloziSupportSession(config, f.status, f.load);
    expect(await session.open()).toBe(false);
    expect(f.widget.destroy).toHaveBeenCalledTimes(1);
    expect(await session.open()).toBe(true);
    expect(f.module.createWebchatWidget).toHaveBeenCalledTimes(2);
    session.destroy();
    expect(f.widget.destroy).toHaveBeenCalledTimes(2);
  });

  it("refuses invalid public configuration before any module request", async () => {
    const f = fixture();
    const session = createEloziSupportSession({ ...config, channelId: "" }, f.status, f.load);
    expect(await session.open()).toBe(false);
    expect(f.load).not.toHaveBeenCalled();
  });

  it("keeps the validated channel when caller data changes during import", async () => {
    const f = fixture();
    const mutable = { ...config };
    const session = createEloziSupportSession(mutable, f.status, f.load);
    const opening = session.open();
    mutable.channelId = "another_channel";
    expect(await opening).toBe(true);
    expect(f.module.createWebchatWidget).toHaveBeenCalledWith({
      apiOrigin: ELOZI_SUPPORT_ORIGIN,
      ...config,
    });
    session.destroy();
  });
});
