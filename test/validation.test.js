import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { validate, collectReferencedFiles } from "../src/validation.ts";

// ── collectReferencedFiles — pure policy unit tests ───────────────────────

const strict = (pkg) => [...collectReferencedFiles(pkg).strict].sort();
const lenient = (pkg) => [...collectReferencedFiles(pkg).lenient].sort();

describe("collectReferencedFiles — strict fields", () => {
  it("collects main/module/types/typings into strict", () => {
    const out = collectReferencedFiles({
      main: "./dist/index.js",
      module: "./dist/index.mjs",
      types: "./dist/index.d.ts",
      typings: "./dist/index.d.ts",
    });
    assert.deepEqual(
      [...out.strict].sort(),
      ["dist/index.d.ts", "dist/index.js", "dist/index.mjs"],
    );
    assert.equal(out.lenient.size, 0);
  });

  it("strips a leading ./ so paths join against a staging dir", () => {
    assert.deepEqual(strict({ main: "./a/b.js" }), ["a/b.js"]);
    assert.deepEqual(strict({ main: "a/b.js" }), ["a/b.js"]);
  });

  it("ignores non-string fields", () => {
    const out = collectReferencedFiles({ main: null, types: 42, typings: {} });
    assert.equal(out.strict.size, 0);
  });
});

describe("collectReferencedFiles — bin is lenient", () => {
  it("puts string bin into lenient, not strict", () => {
    const out = collectReferencedFiles({ bin: "./bin/cli.js" });
    assert.deepEqual([...out.lenient], ["bin/cli.js"]);
    assert.equal(out.strict.size, 0);
  });

  it("puts each entry of object bin into lenient", () => {
    assert.deepEqual(
      lenient({ bin: { a: "./a.js", b: "./b.js" } }),
      ["a.js", "b.js"],
    );
  });

  it("ignores non-string values inside object bin", () => {
    const out = collectReferencedFiles({ bin: { a: "./a.js", b: null } });
    assert.deepEqual([...out.lenient], ["a.js"]);
  });
});

describe("collectReferencedFiles — exports", () => {
  it("collects string exports into strict", () => {
    assert.deepEqual(strict({ exports: "./index.js" }), ["index.js"]);
  });

  it("walks subpath exports", () => {
    assert.deepEqual(
      strict({
        exports: { ".": "./index.js", "./util": "./util.js" },
      }),
      ["index.js", "util.js"],
    );
  });

  it("walks nested conditional exports", () => {
    assert.deepEqual(
      strict({
        exports: {
          ".": {
            import: { types: "./index.d.ts", default: "./index.mjs" },
            require: "./index.cjs",
          },
        },
      }),
      ["index.cjs", "index.d.ts", "index.mjs"],
    );
  });

  it("walks array fallbacks in exports", () => {
    assert.deepEqual(
      strict({ exports: { ".": ["./a.js", "./b.js"] } }),
      ["a.js", "b.js"],
    );
  });

  it("deduplicates the same path referenced twice", () => {
    const out = collectReferencedFiles({
      main: "./index.js",
      exports: { ".": "./index.js" },
    });
    assert.deepEqual([...out.strict], ["index.js"]);
  });
});

// ── validate — tmpdir-based integration tests ────────────────────────────

async function stage(files) {
  const dir = await mkdtemp(join(tmpdir(), "tnp-validate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

let staged;
afterEach(async () => {
  if (staged) await rm(staged, { recursive: true, force: true });
  staged = undefined;
});

describe("validate — strict reference checks", () => {
  // Regression anchor: @endo/ses-ava shipped with a synthesized
  // `types: ./index.d.ts` pointing at a file that ts-node-pack never
  // emitted. validate() must catch exactly that shape.
  it("throws when `types` points at a missing file", async () => {
    staged = await stage({ "index.js": "export {};\n" });
    await assert.rejects(
      validate(staged, { main: "./index.js", types: "./index.d.ts" }),
      /referenced file missing from tarball: index\.d\.ts/,
    );
  });

  it("throws when `main` points at a missing file", async () => {
    staged = await stage({});
    await assert.rejects(
      validate(staged, { main: "./dist/index.js" }),
      /referenced file missing from tarball: dist\/index\.js/,
    );
  });

  it("throws when an `exports` condition points at a missing file", async () => {
    staged = await stage({ "index.js": "export {};\n" });
    await assert.rejects(
      validate(staged, {
        exports: { ".": { import: "./index.js", types: "./index.d.ts" } },
      }),
      /referenced file missing from tarball: index\.d\.ts/,
    );
  });

  it("passes when every strict reference exists", async () => {
    staged = await stage({
      "index.mjs": "export {};\n",
      "index.d.mts": "export {};\n",
    });
    await validate(staged, {
      main: "./index.mjs",
      types: "./index.d.mts",
      exports: {
        ".": { types: "./index.d.mts", import: "./index.mjs" },
      },
    });
  });
});

describe("validate — bin is lenient", () => {
  // agoric/portfolio-api ships a package.json whose `bin` points at a
  // file that doesn't exist in the tarball. yarn/npm both tolerate it;
  // ts-node-pack must too — warn, don't fail. (See the bin-missing
  // pipeline fixture.)
  it("does not throw when `bin` points at a missing file", async () => {
    staged = await stage({ "index.js": "export {};\n" });
    const warnings = [];
    await validate(
      staged,
      { main: "./index.js", bin: "./cli/missing.js" },
      (msg) => warnings.push(String(msg)),
    );
    assert.ok(
      warnings.some((w) => /cli\/missing\.js/.test(w)),
      `expected a warning about cli/missing.js, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does not throw when an object-bin entry is missing", async () => {
    staged = await stage({
      "index.js": "export {};\n",
      "bin/a.js": "#!/usr/bin/env node\n",
    });
    await validate(staged, {
      main: "./index.js",
      bin: { a: "./bin/a.js", b: "./bin/missing.js" },
    });
  });
});
