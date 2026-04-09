/**
 * Post-rewrite validation of a staged package. `validate()` is the one
 * caller of `collectReferencedFiles`; both live here because the
 * strict-vs-lenient partition is a policy decision owned by validation.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { TS_SPECIFIER_PATTERNS } from "./rewrite-specifiers.ts";

export async function validate(
  stagingDir,
  pkg,
  log: (...args: unknown[]) => void = () => {},
) {
  const errors = [];

  // Check .js/.mjs and .d.ts/.d.mts files for remaining .ts specifiers
  const allFiles = await findFiles(
    stagingDir,
    (name) =>
      name.endsWith(".js") ||
      name.endsWith(".mjs") ||
      name.endsWith(".d.ts") ||
      name.endsWith(".d.mts"),
  );

  for (const filePath of allFiles) {
    const raw = await readFile(filePath, "utf8");
    // Strip block and line comments before scanning so JSDoc examples that
    // literally contain strings like `import './foo.ts'` don't register as
    // false positives. Comment stripping here is intentionally coarse
    // (doesn't understand strings-containing-comment-markers) — good enough
    // for tsc-emitted output, where comments are well-behaved.
    const content = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const relPath = relative(stagingDir, filePath);

    for (const pattern of TS_SPECIFIER_PATTERNS) {
      for (const m of content.matchAll(pattern)) {
        errors.push(`${relPath}: remaining .ts specifier: ${m[0]}`);
      }
    }
  }

  // Check package.json for .ts references in entry points
  const entryFields = ["main", "module", "types", "typings"];
  for (const field of entryFields) {
    if (typeof pkg[field] === "string" && /(?<!\.d)\.(tsx?|mts)$/.test(pkg[field])) {
      errors.push(`package.json "${field}" still references .ts: ${pkg[field]}`);
    }
  }

  // main/module/types/typings/exports must resolve to a file that is
  // actually in the staging dir. This catches rewrite bugs that specifier
  // scanning can't — e.g. the @endo/ses-ava regression where a synthesized
  // `types: ./index.d.ts` pointed at a .d.ts ts-node-pack never emitted.
  // `bin` is deliberately excluded: yarn/npm both tolerate a missing bin
  // target (see the bin-missing fixture — agoric/portfolio-api ships that
  // way intentionally), so we only warn.
  const { strict: strictRefs, lenient: lenientRefs } = collectReferencedFiles(pkg);
  for (const ref of strictRefs) {
    if (!existsSync(join(stagingDir, ref))) {
      errors.push(`referenced file missing from tarball: ${ref}`);
    }
  }
  for (const ref of lenientRefs) {
    if (!existsSync(join(stagingDir, ref))) {
      log(`  Warning: referenced file missing from tarball: ${ref}`);
    }
  }

  if (errors.length > 0) {
    const msg = "Validation failed:\n  " + errors.join("\n  ");
    throw new Error(msg);
  }

  log(`Validated ${allFiles.length} file(s), no issues found`);
}

/**
 * Collect the relative file paths referenced by path-bearing fields of a
 * package.json manifest, partitioned by how strictly a missing target
 * should be treated.
 *
 * - `strict`: `main`, `module`, `types`, `typings`, and every leaf of
 *   `exports`. A missing target here is a bug in the tarball we produced —
 *   Node's module resolution will fail and `npm publish` warns on
 *   dangling `types`.
 * - `lenient`: `bin` entries. yarn and npm both tolerate a `bin` pointing
 *   at a missing file (see the `bin-missing` fixture, which mirrors
 *   agoric/portfolio-api's intentional shape).
 *
 * Exported for direct unit-testing of the policy; the only runtime caller
 * is `validate()` above.
 */
export function collectReferencedFiles(pkg) {
  const strict = new Set<string>();
  const lenient = new Set<string>();
  const addStrict = (p) => strict.add(stripDotSlash(p));
  const addLenient = (p) => lenient.add(stripDotSlash(p));

  for (const field of ["main", "module", "types", "typings"]) {
    if (typeof pkg[field] === "string") addStrict(pkg[field]);
  }

  if (typeof pkg.bin === "string") {
    addLenient(pkg.bin);
  } else if (typeof pkg.bin === "object" && pkg.bin !== null) {
    for (const v of Object.values(pkg.bin)) {
      if (typeof v === "string") addLenient(v);
    }
  }

  if (pkg.exports) collectExportsRefs(pkg.exports, strict);

  return { strict, lenient };
}

function collectExportsRefs(value, refs) {
  if (typeof value === "string") {
    refs.add(stripDotSlash(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectExportsRefs(v, refs);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) collectExportsRefs(v, refs);
  }
}

function stripDotSlash(p) {
  return p.replace(/^\.\//, "");
}

async function findFiles(dir, test) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && test(entry.name)) {
      results.push(join(entry.parentPath, entry.name));
    }
  }
  return results;
}
