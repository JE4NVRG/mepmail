import { describe, expect, it } from "vitest";
import { mailboxRailGroups, RAIL_GROUP_LIMIT } from "./mailbox-rail";

const box = (id: string, kind: "person" | "agent", label = id, address = `${id}@example.com`) => ({
  id,
  kind,
  label,
  address,
});

describe("mailboxRailGroups", () => {
  it("lists people first, then agents, and leaves empty groups out", () => {
    const groups = mailboxRailGroups([box("bot", "agent"), box("ana", "person")]);
    expect(groups.map((group) => [group.kind, group.boxes.map((b) => b.id)])).toEqual([
      ["person", ["ana"]],
      ["agent", ["bot"]],
    ]);
    expect(mailboxRailGroups([box("ana", "person")]).map((group) => group.kind)).toEqual([
      "person",
    ]);
  });

  it("shows the first mailboxes of a long group until it is expanded", () => {
    const many = Array.from({ length: RAIL_GROUP_LIMIT + 3 }, (_, i) => box(`p${i}`, "person"));
    const [collapsed] = mailboxRailGroups(many);
    expect(collapsed?.boxes).toHaveLength(RAIL_GROUP_LIMIT);
    expect(collapsed?.hidden).toBe(3);
    expect(collapsed?.total).toBe(RAIL_GROUP_LIMIT + 3);
    const [open] = mailboxRailGroups(many, { expanded: { person: true } });
    expect(open?.boxes).toHaveLength(RAIL_GROUP_LIMIT + 3);
    expect(open?.hidden).toBe(0);
  });

  it("keeps the selected mailbox visible past the limit", () => {
    const many = Array.from({ length: RAIL_GROUP_LIMIT + 2 }, (_, i) => box(`p${i}`, "person"));
    const last = `p${RAIL_GROUP_LIMIT + 1}`;
    const [group] = mailboxRailGroups(many, { selectedId: last });
    expect(group?.boxes.at(-1)?.id).toBe(last);
    expect(group?.hidden).toBe(1);
  });

  it("matches label or address, ignoring case and accents, and shows every match", () => {
    const boxes = [
      box("a", "person", "João Suporte", "joao@acme.com"),
      box("b", "person", "Vendas", "sales@acme.com"),
      box("c", "agent", "Robô", "bot@acme.com"),
    ];
    expect(mailboxRailGroups(boxes, { query: "joao" })[0]?.boxes.map((b) => b.id)).toEqual(["a"]);
    expect(mailboxRailGroups(boxes, { query: "SALES" })[0]?.boxes.map((b) => b.id)).toEqual(["b"]);
    expect(mailboxRailGroups(boxes, { query: "robo" }).map((group) => group.kind)).toEqual([
      "agent",
    ]);
    expect(mailboxRailGroups(boxes, { query: "zzz" })).toEqual([]);
  });
});
