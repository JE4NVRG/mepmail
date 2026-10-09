import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopInfo, isDesktop, notifyDesktop, setNativeTitle } from "./desktop-bridge";

const info = { app: "mepmail-correio", version: "0.1.0", platform: "windows" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop bridge", () => {
  it("is inert outside the shell", async () => {
    vi.stubGlobal("window", {});
    expect(desktopInfo()).toBeNull();
    expect(isDesktop()).toBe(false);
    expect(await setNativeTitle("Correio")).toBe(false);
  });

  it("ignores a marker that is not the Correio shell", () => {
    vi.stubGlobal("window", { __MEPMAIL_DESKTOP__: { ...info, app: "other" } });
    expect(isDesktop()).toBe(false);
  });

  it("sets the native title through the Tauri IPC inside the shell", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("window", { __MEPMAIL_DESKTOP__: info, __TAURI_INTERNALS__: { invoke } });
    expect(desktopInfo()).toEqual(info);
    expect(await setNativeTitle("(3) Correio")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:window|set_title", {
      label: "main",
      value: "(3) Correio",
    });
  });

  it("reports false when the shell refuses the command", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("not allowed"));
    vi.stubGlobal("window", { __MEPMAIL_DESKTOP__: info, __TAURI_INTERNALS__: { invoke } });
    expect(await setNativeTitle("Correio")).toBe(false);
  });

  it("notifies only with permission, asking for it only inside the shell", async () => {
    const created: { title: string; options: NotificationOptions | undefined }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "granted";
        return FakeNotification.permission;
      });
      constructor(title: string, options?: NotificationOptions) {
        created.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    vi.stubGlobal("window", {});
    expect(await notifyDesktop("Correio", "1 new message")).toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(created).toEqual([]);

    vi.stubGlobal("window", { __MEPMAIL_DESKTOP__: info });
    expect(await notifyDesktop("Correio", "1 new message")).toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(created).toEqual([
      { title: "Correio", options: { body: "1 new message", tag: "mepmail-correio-unread" } },
    ]);
  });
});
