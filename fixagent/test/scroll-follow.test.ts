import assert from "node:assert/strict";
import test from "node:test";

// The helper is shipped directly to the browser, so it intentionally remains JavaScript.
// @ts-expect-error The public browser module has no separate declaration file.
import { createScrollFollowState } from "../public/scroll-follow.js";

const metrics = (scrollTop: number) => ({
  scrollHeight: 1_000,
  clientHeight: 600,
  scrollTop,
});

test("scroll following pauses immediately when the user moves upward", () => {
  const state = createScrollFollowState();
  state.observe(metrics(400));
  assert.equal(state.isFollowing(), true);

  state.observe(metrics(380));
  assert.equal(state.isFollowing(), false);
});

test("paused scrolling stays paused until the user returns to the bottom", () => {
  const state = createScrollFollowState();
  state.observe(metrics(400));
  state.pause();

  state.observe(metrics(360));
  assert.equal(state.isFollowing(), false);
  state.observe(metrics(395));
  assert.equal(state.isFollowing(), true);
});

test("the jump control explicitly resumes scroll following", () => {
  const state = createScrollFollowState();
  state.pause();
  assert.equal(state.isFollowing(), false);

  state.resume(metrics(400));
  assert.equal(state.isFollowing(), true);
});
