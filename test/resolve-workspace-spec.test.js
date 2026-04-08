import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveWorkspaceSpec } from "../src/index.ts";

describe("resolveWorkspaceSpec", () => {
  it("translates workspace:* to the concrete version", () => {
    assert.equal(resolveWorkspaceSpec("workspace:*", "1.2.3"), "1.2.3");
  });

  it("translates empty workspace: the same as workspace:*", () => {
    assert.equal(resolveWorkspaceSpec("workspace:", "1.2.3"), "1.2.3");
  });

  it("translates workspace:^ to a caret range at the concrete version", () => {
    assert.equal(resolveWorkspaceSpec("workspace:^", "1.2.3"), "^1.2.3");
  });

  it("translates workspace:~ to a tilde range at the concrete version", () => {
    assert.equal(resolveWorkspaceSpec("workspace:~", "1.2.3"), "~1.2.3");
  });

  it("passes a literal workspace:<range> through verbatim", () => {
    assert.equal(resolveWorkspaceSpec("workspace:^1.2.0", "1.2.3"), "^1.2.0");
    assert.equal(resolveWorkspaceSpec("workspace:~2.0.0", "1.2.3"), "~2.0.0");
    assert.equal(resolveWorkspaceSpec("workspace:1.2.0", "1.2.3"), "1.2.0");
    assert.equal(resolveWorkspaceSpec("workspace:>=1.0.0 <2.0.0", "1.2.3"), ">=1.0.0 <2.0.0");
  });

  it("leaves non-workspace specs untouched", () => {
    assert.equal(resolveWorkspaceSpec("^1.2.3", "9.9.9"), "^1.2.3");
    assert.equal(resolveWorkspaceSpec("npm:foo@^1.0.0", "9.9.9"), "npm:foo@^1.0.0");
    assert.equal(resolveWorkspaceSpec("file:../other", "9.9.9"), "file:../other");
  });

  it("is a no-op on non-string input", () => {
    // @ts-expect-error — deliberate misuse
    assert.equal(resolveWorkspaceSpec(undefined, "1.2.3"), undefined);
    // @ts-expect-error — deliberate misuse
    assert.equal(resolveWorkspaceSpec(42, "1.2.3"), 42);
  });
});
