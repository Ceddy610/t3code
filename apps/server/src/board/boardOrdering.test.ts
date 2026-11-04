import { assert, describe, it } from "@effect/vitest";

import { positionBetween, renumber } from "./boardOrdering.ts";

describe("boardOrdering", () => {
  it("places between, before and after neighbours", () => {
    assert.equal(positionBetween(null, null), 1024);
    assert.equal(positionBetween(null, 1024), 0);
    assert.equal(positionBetween(1024, null), 2048);
    assert.equal(positionBetween(1024, 2048), 1536);
  });

  it("returns null once precision runs out", () => {
    let next = 2048;
    let steps = 0;
    for (let position = positionBetween(1024, next); position !== null; steps++) {
      next = position;
      position = positionBetween(1024, next);
    }
    assert.isAbove(steps, 10);
    assert.isNull(positionBetween(1, 1 + Number.EPSILON));
  });

  it("renumbers in steps of 1024", () => {
    assert.deepStrictEqual(renumber(3), [1024, 2048, 3072]);
  });
});
