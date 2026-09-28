import { describe, expect, it } from "vitest";
import { navItemsWithConsole } from "./nav";

const NAV = ["/emails", "/settings"] as const;
const CONSOLE = "/console";

describe("navItemsWithConsole", () => {
  it("appends the console entry for the instance operator", () => {
    expect(navItemsWithConsole(NAV, CONSOLE, true)).toEqual(["/emails", "/settings", "/console"]);
  });

  it("leaves the nav untouched for every other account", () => {
    expect(navItemsWithConsole(NAV, CONSOLE, false)).toEqual(["/emails", "/settings"]);
  });

  it("returns the base list itself when the item is not appended", () => {
    expect(navItemsWithConsole(NAV, CONSOLE, false)).toBe(NAV);
  });

  it("never mutates the base list", () => {
    const base = ["/emails"];
    navItemsWithConsole(base, CONSOLE, true);
    expect(base).toEqual(["/emails"]);
  });
});
