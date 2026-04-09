/**
 * Integration tests that run the full tsNodePack pipeline against small
 * fixture packages. Each test targets a specific gotcha hit during the
 * real-world validation against agoric-sdk, codified here so that a
 * future change to the pipeline can't silently break any of them.
 *
 * Uses `skipPack: true` + `stageTo: <mkdtemp>` so there is no
 * `npm pack` step and no node_modules churn — the tests only assert on
 * the contents of the per-fixture staging directory, which is cleaned
 * up in `afterAll`.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tsNodePack } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

/** Tracks every staging dir created so we can clean up in afterAll. */
const tempDirs = [];

async function packFixture(fixtureName) {
  // Use stageTo with a per-test mkdtemp so each fixture gets its own
  // staging dir that we can inspect (the new API requires stageTo
  // whenever skipPack is set — there is no more "give me a temp dir
  // back" mode).
  const stageTo = await mkdtemp(join(tmpdir(), "ts-node-pack-test-"));
  const stagingDir = await tsNodePack(join(fixtures, fixtureName), {
    skipPack: true,
    stageTo,
    force: true,
  });
  tempDirs.push(stagingDir);
  return stagingDir;
}

afterAll(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
});

// ── mixed sources (.ts + .js + .mts + hand-authored .d.ts) ────────────────

describe("pipeline: mixed-sources fixture", () => {
  // Regression for multiple agoric-sdk findings: packages/internal had
  // a .mts file (ava-force-exit), a hand-authored .d.ts (tagged.d.ts),
  // and a mix of .ts and .js sources. All of them need to round-trip.
  let staging;

  beforeAll(async () => {
    staging = await packFixture("mixed-sources");
  }, 60_000);

  it("strips .ts source into .js (same directory) and deletes the .ts", () => {
    assert.ok(existsSync(join(staging, "src/index.js")), "stripped .js should exist");
    assert.ok(!existsSync(join(staging, "src/index.ts")), ".ts source should be removed");
  });

  it("strips .mts source into .mjs and deletes the .mts", () => {
    assert.ok(existsSync(join(staging, "src/module.mjs")), "stripped .mjs should exist");
    assert.ok(!existsSync(join(staging, "src/module.mts")), ".mts source should be removed");
  });

  it("copies plain .js verbatim", async () => {
    const orig = await readFile(join(fixtures, "mixed-sources/src/plain.js"), "utf8");
    const staged = await readFile(join(staging, "src/plain.js"), "utf8");
    assert.equal(staged, orig);
  });

  it("emits .d.ts for every source file", () => {
    for (const f of ["index.d.ts", "plain.d.ts", "module.d.mts"]) {
      assert.ok(existsSync(join(staging, "src", f)), `missing declaration: src/${f}`);
    }
  });

  it("preserves hand-authored .d.ts with no JS twin", () => {
    // `src/tagged.d.ts` has no `.ts` or `.js` source — it's a pure
    // declarations file. npm-packlist copies it via `files: ["src"]`,
    // and nothing downstream should touch it.
    assert.ok(existsSync(join(staging, "src/tagged.d.ts")));
  });

  it("rewrites .mts specifiers to .mjs in the stripped .js output", async () => {
    const stagedIndex = await readFile(join(staging, "src/index.js"), "utf8");
    assert.match(
      stagedIndex,
      /from\s+['"]\.\/module\.mjs['"]/,
      "expected `./module.mjs` specifier",
    );
    assert.doesNotMatch(stagedIndex, /\.mts['"]/, "no .mts specifier should remain");
  });

  it("rewrites .ts specifiers to .js in the stripped .js output", async () => {
    const stagedIndex = await readFile(join(staging, "src/index.js"), "utf8");
    assert.match(stagedIndex, /from\s+['"]\.\/plain\.js['"]/);
    assert.doesNotMatch(stagedIndex, /from\s+['"]\.\/plain\.ts['"]/);
  });

  it("rewrites main from .ts to .js in package.json", async () => {
    const pkg = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
    assert.equal(pkg.main, "./src/index.js");
  });
});

// ── bin pointing at a missing file (agoric portfolio-api) ─────────────────

describe("pipeline: bin-missing fixture", () => {
  // portfolio-api's package.json has `"bin": "./src/cli/bin.js"` but
  // the `cli/` directory doesn't exist. yarn and npm both silently
  // tolerate this; ts-node-pack must too — the pack should succeed
  // with a non-fatal warning, not throw.
  it("succeeds with a missing `bin` entry (warn, don't fail)", async () => {
    const staging = await packFixture("bin-missing");
    assert.ok(existsSync(join(staging, "package.json")));
    assert.ok(existsSync(join(staging, "src/index.js")));
    assert.ok(
      !existsSync(join(staging, "src/cli/not-there.js")),
      "the missing bin file should stay missing, not be fabricated",
    );
  }, 60_000);
});

// ── workspace: protocol resolution (agoric internal → base-zone etc.) ─────

describe("pipeline: workspace-root/packages/consumer fixture", () => {
  // Regression for the workspace: protocol resolution bug. The
  // consumer package depends on `@regress/provider` via `workspace:*`,
  // `workspace:^`, and `workspace:~` across three dependency fields.
  // All three must resolve to the provider's concrete version (3.4.5)
  // at pack time; leaving the literal `workspace:*` string in place
  // produces a tarball that the npm registry will reject.
  let packageJson;

  beforeAll(async () => {
    const staging = await packFixture("workspace-root/packages/consumer");
    packageJson = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
  }, 60_000);

  it("resolves `workspace:*` to the concrete version", () => {
    assert.equal(packageJson.dependencies["@regress/provider"], "3.4.5");
  });

  it("resolves `workspace:^` to ^<version>", () => {
    assert.equal(packageJson.peerDependencies["@regress/provider"], "^3.4.5");
  });

  it("resolves `workspace:~` to ~<version>", () => {
    assert.equal(packageJson.optionalDependencies["@regress/provider"], "~3.4.5");
  });
});

// ── pure-JS package with no tsconfig at all ───────────────────────────────

describe("pipeline: pure-js fixture (no tsconfig)", () => {
  // Regression for a class of agoric-sdk packages (golang/cosmos,
  // packages/eslint-config, packages/wallet, packages/cosmic-swingset,
  // packages/telemetry) that have no tsconfig.build.json and either
  // no .ts sources or no tsconfig.json. Such packages should pack
  // successfully without ts-node-pack invoking tsc — matching what
  // `npm pack` would have produced.
  let staging;

  beforeAll(async () => {
    staging = await packFixture("pure-js");
  }, 60_000);

  it("packs without invoking tsc", () => {
    assert.ok(existsSync(join(staging, "package.json")));
    assert.ok(existsSync(join(staging, "src/index.js")));
  });

  it("emits no .d.ts files (no opt-in to declarations)", async () => {
    const { readdir } = await import("node:fs/promises");
    const srcEntries = await readdir(join(staging, "src"));
    const dts = srcEntries.filter((f) => f.endsWith(".d.ts"));
    assert.deepEqual(dts, [], "no .d.ts files should exist");
  });

  it("preserves the original .js content verbatim", async () => {
    const orig = await readFile(join(fixtures, "pure-js/src/index.js"), "utf8");
    const staged = await readFile(join(staging, "src/index.js"), "utf8");
    assert.equal(staged, orig);
  });
});

// ── JSDoc examples that LOOK like .ts specifiers (our own source!) ────────

describe("pipeline: JSDoc specifier false-positives", () => {
  // Regression for a bug caught when self-packing ts-node-pack:
  // rewriteTsSpecifiers' own JSDoc comment contains example strings
  // like `import './foo.ts'` as documentation. The validator naively
  // regex-scanned files for leftover .ts specifiers and flagged those
  // doc examples, blocking the pack. The fix is to strip comments
  // before scanning. We cover that here by self-packing via skipPack.
  it("self-pack of ts-node-pack succeeds despite JSDoc examples", async () => {
    const repoRoot = join(__dirname, "..");
    const stageTo = await mkdtemp(join(tmpdir(), "ts-node-pack-test-"));
    const staging = await tsNodePack(repoRoot, {
      skipPack: true,
      stageTo,
      force: true,
    });
    tempDirs.push(staging);
    // If the validator incorrectly flagged the JSDoc examples, the
    // pipeline would have thrown before returning. Reaching here =
    // validator handled the comment-stripping correctly.
    assert.ok(existsSync(join(staging, "src/index.js")));
  }, 60_000);
});
