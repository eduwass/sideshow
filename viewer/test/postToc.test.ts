import { expect, test } from "vitest";
import { stepPost } from "../src/state.ts";

const ids = ["a", "b", "c"];

test("stepPost moves one post at a time and clamps at the ends", () => {
  expect(stepPost(ids, "a", 1)).toBe("b");
  expect(stepPost(ids, "c", 1)).toBe("c");
  expect(stepPost(ids, "b", -1)).toBe("a");
  expect(stepPost(ids, "a", -1)).toBe("a");
});

test("stepPost jumps to the edges", () => {
  expect(stepPost(ids, "b", "first")).toBe("a");
  expect(stepPost(ids, "b", "last")).toBe("c");
});

test("stepPost lands on the first post when nothing is current, and on null when empty", () => {
  expect(stepPost(ids, null, 1)).toBe("a");
  expect(stepPost(ids, "gone", -1)).toBe("a");
  expect(stepPost([], null, "last")).toBeNull();
});
