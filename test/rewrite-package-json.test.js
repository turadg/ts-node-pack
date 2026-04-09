import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { rewritePackageJson } from "../src/index.ts";

describe("rewritePackageJson — entry fields", () => {
  it("rewrites main from .ts to .js", () => {
    const out = rewritePackageJson({ main: "./src/index.ts" });
    assert.equal(out.main, "./src/index.js");
  });

  it("rewrites module from .ts to .js", () => {
    const out = rewritePackageJson({ module: "./src/index.ts" });
    assert.equal(out.module, "./src/index.js");
  });

  it("rewrites .tsx as well", () => {
    const out = rewritePackageJson({ main: "./src/index.tsx" });
    assert.equal(out.main, "./src/index.js");
  });

  it("leaves .js main untouched", () => {
    const out = rewritePackageJson({ main: "./dist/index.js" });
    assert.equal(out.main, "./dist/index.js");
  });
});

describe("rewritePackageJson — types", () => {
  it("rewrites explicit types to .d.ts", () => {
    const out = rewritePackageJson({ types: "./src/index.ts" });
    assert.equal(out.types, "./src/index.d.ts");
  });

  it("rewrites explicit typings to .d.ts", () => {
    const out = rewritePackageJson({ typings: "./src/index.ts" });
    assert.equal(out.typings, "./src/index.d.ts");
  });

  it("derives types from main when neither types nor typings is set", () => {
    const out = rewritePackageJson({ main: "./src/index.ts" });
    assert.equal(out.types, "./src/index.d.ts");
  });

  it("does not derive types when types is already present", () => {
    const out = rewritePackageJson({
      main: "./src/index.ts",
      types: "./types/custom.ts",
    });
    assert.equal(out.types, "./types/custom.d.ts");
  });

  // Regression: pure JS+JSDoc packages (main ends in .js, no types field)
  // used to come out with a synthesized `"types": "./index.d.ts"` pointing
  // at a file that ts-node-pack never emits — npm publish then warns and
  // TypeScript consumers see a broken types pointer. See @endo/ses-ava in
  // the agoric/endo monorepo.
  it("does not synthesize types when main is already .js", () => {
    const out = rewritePackageJson({ main: "./index.js" });
    assert.equal(out.types, undefined);
  });
});

describe("rewritePackageJson — bin", () => {
  it("rewrites string bin", () => {
    const out = rewritePackageJson({ bin: "./src/cli.ts" });
    assert.equal(out.bin, "./src/cli.js");
  });

  it("rewrites object bin", () => {
    const out = rewritePackageJson({
      bin: { foo: "./src/foo.ts", bar: "./src/bar.tsx" },
    });
    assert.deepEqual(out.bin, {
      foo: "./src/foo.js",
      bar: "./src/bar.js",
    });
  });
});

describe("rewritePackageJson — exports", () => {
  it("rewrites string exports", () => {
    const out = rewritePackageJson({ exports: "./src/index.ts" });
    assert.equal(out.exports, "./src/index.js");
  });

  it("rewrites subpath exports", () => {
    const out = rewritePackageJson({
      exports: {
        ".": "./src/index.ts",
        "./utils": "./src/utils.ts",
      },
    });
    assert.deepEqual(out.exports, {
      ".": "./src/index.js",
      "./utils": "./src/utils.js",
    });
  });

  it("rewrites conditional exports, distinguishing types from import", () => {
    const out = rewritePackageJson({
      exports: {
        ".": {
          types: "./src/index.ts",
          import: "./src/index.ts",
          default: "./src/index.ts",
        },
      },
    });
    assert.deepEqual(out.exports, {
      ".": {
        types: "./src/index.d.ts",
        import: "./src/index.js",
        default: "./src/index.js",
      },
    });
  });

  it("handles nested conditions (types inside a subpath's import)", () => {
    const out = rewritePackageJson({
      exports: {
        "./util": {
          import: {
            types: "./src/util.ts",
            default: "./src/util.ts",
          },
        },
      },
    });
    assert.deepEqual(out.exports, {
      "./util": {
        import: {
          types: "./src/util.d.ts",
          default: "./src/util.js",
        },
      },
    });
  });

  it("handles array fallbacks in exports", () => {
    const out = rewritePackageJson({
      exports: { ".": ["./src/index.ts", "./src/fallback.ts"] },
    });
    assert.deepEqual(out.exports["."], ["./src/index.js", "./src/fallback.js"]);
  });
});

describe("rewritePackageJson — files array", () => {
  it("expands .ts entries to both .js and .d.ts", () => {
    const out = rewritePackageJson({
      files: ["src/index.ts", "README.md"],
    });
    assert.deepEqual(out.files, ["src/index.js", "src/index.d.ts", "README.md"]);
  });

  it("leaves non-.ts entries alone", () => {
    const out = rewritePackageJson({
      files: ["dist/", "README.md", "schemas/*.json"],
    });
    assert.deepEqual(out.files, ["dist/", "README.md", "schemas/*.json"]);
  });
});

describe("rewritePackageJson — scrubbing", () => {
  it("strips devDependencies and scripts", () => {
    const out = rewritePackageJson({
      main: "./src/index.ts",
      devDependencies: { typescript: "^5.7.0" },
      scripts: { build: "tsc" },
    });
    assert.equal(out.devDependencies, undefined);
    assert.equal(out.scripts, undefined);
  });

  it("does not mutate the input", () => {
    const input = {
      main: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      scripts: { build: "tsc" },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    rewritePackageJson(input);
    assert.deepEqual(input, snapshot);
  });
});
