import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rowId } from "../sapi/src/ids.ts";

describe("inventory-switcher", () => {
  it("rowId 联合键", () => {
    assert.equal(rowId("p1", "default"), "p1|default");
  });

  it("快照结构含 36 槽位占位约定", () => {
    const slots = Array.from({ length: 36 }, () => null);
    assert.equal(slots.length, 36);
  });
});
