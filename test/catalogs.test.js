import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogs, resolveCatalogSpec } from "../src/catalogs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const consumerDir = join(__dirname, "fixtures/catalog-root/packages/consumer");

describe("loadCatalogs", () => {
  it("walks up to find .yarnrc.yml and normalizes its catalogs", async () => {
    const loaded = await loadCatalogs(consumerDir);
    assert.ok(loaded, "expected to find a catalog config");
    assert.match(loaded.source, /catalog-root[/\\]\.yarnrc\.yml$/);
    // pnpm normalizes the default (unnamed) catalog under the "default" key.
    assert.equal(loaded.catalogs.default.lodash, "^4.17.21");
    assert.equal(loaded.catalogs.dev.typescript, "~6.0.3");
    assert.equal(loaded.catalogs.dev["eslint-plugin-import"], "npm:eslint-plugin-import-x@4.16.2");
  });

  it("returns null when no ancestor defines a catalog", async () => {
    assert.equal(await loadCatalogs("/"), null);
  });
});

describe("resolveCatalogSpec", () => {
  let catalogs;
  it("resolves a named-catalog spec to its range", async () => {
    ({ catalogs } = await loadCatalogs(consumerDir));
    assert.equal(resolveCatalogSpec("catalog:dev", "typescript", catalogs), "~6.0.3");
  });

  it("resolves a default-catalog spec to its range", () => {
    assert.equal(resolveCatalogSpec("catalog:", "lodash", catalogs), "^4.17.21");
  });

  it("preserves an npm: alias entry verbatim", () => {
    assert.equal(
      resolveCatalogSpec("catalog:dev", "eslint-plugin-import", catalogs),
      "npm:eslint-plugin-import-x@4.16.2",
    );
  });

  it("passes non-catalog specs through unchanged", () => {
    assert.equal(resolveCatalogSpec("^1.2.3", "whatever", catalogs), "^1.2.3");
    assert.equal(resolveCatalogSpec("npm:foo@^1.0.0", "whatever", catalogs), "npm:foo@^1.0.0");
  });

  it("is a no-op on non-string input", () => {
    assert.equal(resolveCatalogSpec(undefined, "x", catalogs), undefined);
    assert.equal(resolveCatalogSpec(42, "x", catalogs), 42);
  });

  it("throws when the dependency is absent from the named catalog", () => {
    assert.throws(
      () => resolveCatalogSpec("catalog:dev", "not-in-catalog", catalogs),
      /not-in-catalog|catalog/i,
    );
  });

  it("throws when the referenced catalog does not exist", () => {
    assert.throws(
      () => resolveCatalogSpec("catalog:nonexistent", "typescript", catalogs),
      /nonexistent|catalog/i,
    );
  });
});
