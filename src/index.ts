import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import packlist from "npm-packlist";
import tsBlankSpace from "ts-blank-space";
import { TS_SPECIFIER_PATTERNS, rewriteTsSpecifiers } from "./rewrite-specifiers.ts";

const execFileAsync = promisify(execFile);

export interface TsNodePackOptions {
  tsconfig?: string;
  emitOnly?: boolean;
  keepTemp?: boolean;
  verbose?: boolean;
}

/**
 * Main pipeline: pack a TypeScript package into a Node-compatible tarball.
 * Returns the path to the .tgz file (or the staging dir if --emit-only).
 */
export async function tsNodePack(
  packageDir: string,
  options: TsNodePackOptions = {},
): Promise<string> {
  const { tsconfig, emitOnly, keepTemp, verbose } = options;
  const log = verbose ? (...args: unknown[]) => console.error("[ts-node-pack]", ...args) : () => {};

  packageDir = resolve(packageDir);

  // ── Phase 1: Resolve package ──────────────────────────────────────────
  log("Phase 1: Resolving package...");
  const pkgJsonPath = join(packageDir, "package.json");
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  log(`Package: ${pkgJson.name}@${pkgJson.version}`);

  const tsconfigPath = resolveTsconfig(packageDir, tsconfig);
  if (tsconfigPath) log(`Found tsconfig: ${tsconfigPath}`);

  // ── Phase 2: Create staging directory ─────────────────────────────────
  log("Phase 2: Creating staging directory...");
  const tmpDir = await mkdtemp(join(tmpdir(), "ts-node-pack-"));
  const stagingDir = join(tmpDir, "package");
  await mkdir(stagingDir, { recursive: true });
  log(`Staging: ${stagingDir}`);

  try {
    // ── Phase 3: Copy the npm-packlist into staging ──────────────────────
    // `npm-packlist` is the same file-enumeration engine `npm pack` uses
    // internally. It applies `files`, `.npmignore`, the npm default
    // includes (package.json, README*, LICENSE*) and default excludes
    // (.git, node_modules, ...) — so the staging directory ends up as a
    // faithful mirror of whatever `npm pack` would have produced from
    // the source tree, minus our downstream transforms.
    //
    // `isProjectRoot: true` sends npm-packlist down its "root package"
    // branch — without it, it tries to walk `edgesOut` which doesn't
    // exist on our hand-built tree (no @npmcli/arborist).
    log("Phase 3: Enumerating package files via npm-packlist...");
    const packFiles = await packlist({
      path: packageDir,
      package: pkgJson,
      isProjectRoot: true,
    });
    // Pre-create unique parent dirs serially (concurrent mkdir on the
    // same path can race on some filesystems), then copy in parallel.
    const dirs = new Set<string>(packFiles.map((rel) => dirname(join(stagingDir, rel))));
    for (const d of dirs) await mkdir(d, { recursive: true });
    await Promise.all(
      packFiles.map((rel) => copyFile(join(packageDir, rel), join(stagingDir, rel))),
    );
    log(`Copied ${packFiles.length} file(s) into staging`);

    // ── Phase 4: Decide whether to run tsc, generate config if so ────────
    // Three conditions trigger declaration emit:
    //   1. user passed --tsconfig (explicit opt-in)
    //   2. tsconfig.build.json exists (agoric convention for opt-in)
    //   3. any source contains .ts/.tsx/.mts (we'd be stripping them
    //      anyway, and probably want their declarations)
    // For pure JS+JSDoc packages with only `tsconfig.json` and no .ts
    // sources, this skips tsc entirely — matching what `npm pack` would
    // have done before ts-node-pack: ship .js files, no .d.ts.
    const hasTsSources = packFiles.some(
      (f) => /\.(ts|tsx|mts)$/.test(f) && !/\.d\.(ts|mts)$/.test(f),
    );
    const isExplicitOptIn =
      tsconfigPath !== null &&
      (tsconfig !== undefined || basename(tsconfigPath) === "tsconfig.build.json");
    const shouldRunTsc = tsconfigPath !== null && (isExplicitOptIn || hasTsSources);

    if (shouldRunTsc) {
      log("Phase 4: Generating derived tsconfig...");
      const emitConfigPath = join(tmpDir, "tsconfig.emit.json");
      // tsc's typeRoots walk-up starts at the config's directory, so it
      // can't reach packageDir/node_modules/@types from our temp-dir
      // location. Pin typeRoots when that directory exists. (TS 6.0
      // surfaces the missing resolution as TS2688 instead of the silent
      // "Cannot find module 'node:util'" cascade of earlier versions.)
      const atTypesDir = join(packageDir, "node_modules", "@types");
      const hasAtTypes = existsSync(atTypesDir);
      const emitConfig = {
        extends: tsconfigPath,
        compilerOptions: {
          // Force rootDir so emit preserves the source layout —
          // otherwise tsc infers the common ancestor and strips the
          // `src/` prefix, breaking `main`/`exports` that reference
          // `./src/...`.
          rootDir: packageDir,
          outDir: stagingDir,
          declaration: true,
          // ts-blank-space handles .js emit (Phase 6); tsc only emits .d.ts.
          emitDeclarationOnly: true,
          // Extract types from JS+JSDoc sources in mixed packages.
          allowJs: true,
          noEmit: false,
          // Incremental/composite write a .tsbuildinfo whose path tsc
          // computes relative to the base config, producing garbled
          // paths when our outDir crosses directory trees.
          incremental: false,
          composite: false,
          tsBuildInfoFile: null,
          ...(hasAtTypes ? { typeRoots: [atTypesDir] } : {}),
        },
      };
      await writeFile(emitConfigPath, JSON.stringify(emitConfig, null, 2) + "\n");

      log("Phase 5: Emitting .d.ts files via tsc...");
      await runTsc(emitConfigPath, packageDir, log);
    } else {
      log(
        tsconfigPath === null
          ? "Phase 4-5: Skipping tsc (no tsconfig found; pure-JS package)"
          : "Phase 4-5: Skipping tsc (no .ts sources and no tsconfig.build.json opt-in)",
      );
    }

    // ── Phase 6: Strip types and rewrite specifiers ─────────────────────
    // Single-pass transform of every staging file that could contain a
    // relative module specifier: .ts/.mts get ts-blank-space'd then
    // specifier-rewritten (one read, one write, original unlinked);
    // .js/.mjs/.d.ts/.d.mts just get specifier-rewritten in place.
    // ts-blank-space preserves line and column positions, so no
    // sourcemaps are needed for debugging.
    log("Phase 6: Stripping types and rewriting specifiers...");
    const { strippedCount, rewrittenCount } = await processStagingFiles(stagingDir, log);
    log(
      `Stripped ${strippedCount} type-annotated file(s); rewrote ${rewrittenCount} other file(s)`,
    );

    // ── Phase 7: Rewrite package.json ───────────────────────────────────
    // README, LICENSE, and any other npm-always-included files already
    // landed in staging via Phase 4. We overwrite the copy of
    // package.json with a rewritten one: first resolve any
    // `workspace:*` protocol specifiers (required for monorepo
    // packages to publish), then flip entry paths and strip dev-only
    // fields.
    log("Phase 7: Rewriting package.json...");
    const resolvedPkg = await resolveWorkspaceDependencies(pkgJson, packageDir, log);
    const rewrittenPkg = rewritePackageJson(resolvedPkg);
    await writeFile(join(stagingDir, "package.json"), JSON.stringify(rewrittenPkg, null, 2) + "\n");

    // ── Phase 8: Validate ─────────────────────────────────────────────────
    log("Phase 8: Validating...");
    await validate(stagingDir, rewrittenPkg, log);

    // ── Phase 9: Pack ─────────────────────────────────────────────────────
    if (!emitOnly) {
      log("Phase 9: Packing...");
      const tgzPath = await pack(stagingDir);
      const tgzName = basename(tgzPath);
      const dest = join(process.cwd(), tgzName);
      await copyFile(tgzPath, dest);
      log(`Created: ${dest}`);
      return dest;
    }

    log(`Emit-only mode. Staging directory: ${stagingDir}`);
    return stagingDir;
  } finally {
    // ── Phase 10: Cleanup ───────────────────────────────────────────────
    if (!emitOnly && !keepTemp) {
      log("Phase 10: Cleaning up temp directory...");
      await rm(tmpDir, { recursive: true, force: true });
    } else if (keepTemp) {
      log(`Keeping temp directory: ${tmpDir}`);
    }
  }
}

// ── Phase helpers ──────────────────────────────────────────────────────────

/**
 * Find the tsconfig to extend, or null if the package has no TypeScript
 * config at all (pure JS package). The `--tsconfig` flag is the one
 * explicit case where missing-config is fatal.
 */
function resolveTsconfig(packageDir, tsconfigOption): string | null {
  if (tsconfigOption) {
    const p = resolve(packageDir, tsconfigOption);
    if (!existsSync(p)) {
      throw new Error(`tsconfig not found: ${p}`);
    }
    return p;
  }
  const buildConfig = join(packageDir, "tsconfig.build.json");
  if (existsSync(buildConfig)) return buildConfig;
  const defaultConfig = join(packageDir, "tsconfig.json");
  if (existsSync(defaultConfig)) return defaultConfig;
  return null;
}

/**
 * Walk upward from `startDir`, returning the first `node_modules/.bin/<name>`
 * that exists. Mirrors how npm composes `$PATH` for scripts in a workspace.
 * Returns null when nothing is found before the filesystem root.
 */
function findLocalBin(startDir, name) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function runTsc(emitConfigPath, cwd, log) {
  // Prefer a local tsc so users control the compiler version (and to avoid
  // npx resolving to macOS's /usr/bin/tsc — the TeX/Smalltalk compiler —
  // when no local install exists). In a monorepo, the package's own
  // node_modules/.bin may be empty while the workspace root has the
  // binary, so walk upward the same way npm's `$PATH` composition does.
  const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const localTsc = findLocalBin(cwd, binName);
  const useLocal = localTsc !== null;
  const [cmd, argv] = useLocal
    ? [localTsc, ["-p", emitConfigPath]]
    : ["npx", ["--yes", "tsc", "-p", emitConfigPath]];
  log(useLocal ? `Using local tsc: ${localTsc}` : "Using npx tsc (no local install found)");
  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout.trim()) log(stdout.trim());
    if (stderr.trim()) log(stderr.trim());
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    if (output) console.error(output);
    throw new Error("TypeScript compilation failed");
  }
}

/**
 * Walk stagingDir for every file that might contain a relative module
 * specifier — .ts/.mts (strip types then rewrite), and .js/.mjs/.d.ts/
 * .d.mts (rewrite specifiers only). Each file is read once and, if
 * changed, written once. Sourcemap files (.d.ts.map, .d.mts.map) are
 * skipped because they're binary-encoded JSON with no specifiers.
 *
 * Throws if ts-blank-space rejects a .ts/.mts file (non-erasable
 * syntax like `enum`, `namespace`, or parameter properties).
 */
async function processStagingFiles(stagingDir, log) {
  const files = await findFiles(
    stagingDir,
    (name) =>
      (name.endsWith(".ts") && !name.endsWith(".d.ts")) ||
      (name.endsWith(".mts") && !name.endsWith(".d.mts")) ||
      name.endsWith(".js") ||
      name.endsWith(".mjs") ||
      (name.endsWith(".d.ts") && !name.endsWith(".d.ts.map")) ||
      (name.endsWith(".d.mts") && !name.endsWith(".d.mts.map")),
  );
  let strippedCount = 0;
  let rewrittenCount = 0;
  for (const srcPath of files) {
    const rel = relative(stagingDir, srcPath);
    const isTs = srcPath.endsWith(".ts") && !srcPath.endsWith(".d.ts");
    const isMts = srcPath.endsWith(".mts") && !srcPath.endsWith(".d.mts");
    const source = await readFile(srcPath, "utf8");

    let content = source;
    if (isTs || isMts) {
      const errors: string[] = [];
      content = tsBlankSpace(source, (node) => {
        errors.push(
          `${rel}: unsupported non-erasable syntax: ${String(node.getText?.() ?? node).slice(0, 80)}`,
        );
      });
      if (errors.length > 0) {
        throw new Error(
          "ts-blank-space rejected non-erasable TypeScript:\n  " + errors.join("\n  "),
        );
      }
    }
    content = rewriteTsSpecifiers(content);

    if (isTs || isMts) {
      const destPath = srcPath.replace(isMts ? /\.mts$/ : /\.ts$/, isMts ? ".mjs" : ".js");
      await writeFile(destPath, content);
      await unlink(srcPath);
      strippedCount++;
      log(`  Stripped: ${rel} → ${basename(destPath)}`);
    } else if (content !== source) {
      await writeFile(srcPath, content);
      rewrittenCount++;
      log(`  Rewrote: ${rel}`);
    }
  }
  return { strippedCount, rewrittenCount };
}

const DEP_FIELDS_WITH_WORKSPACE = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

/**
 * Resolve `workspace:` protocol specifiers in the package's dependency
 * fields to concrete versions, matching yarn-berry and pnpm behavior.
 *
 * Translation rules:
 *   workspace:*       → <version>
 *   workspace:^       → ^<version>
 *   workspace:~       → ~<version>
 *   workspace:<range> → <range>
 *
 * Walks upward from packageDir to find the workspace root (the first
 * ancestor whose package.json has a `workspaces` field), expands its
 * workspace globs to locate sibling packages, and builds a
 * `name → version` map.
 *
 * Throws if the package has `workspace:` specifiers but no workspace
 * root can be found, or if a referenced sibling package is unknown.
 * These failure modes indicate a broken workspace, not a ts-node-pack
 * bug — surface them loudly rather than shipping an unpublishable
 * tarball.
 */
export async function resolveWorkspaceDependencies(pkg, packageDir, log) {
  if (!hasWorkspaceDeps(pkg)) return pkg;

  const workspaceRoot = await findWorkspaceRoot(packageDir);
  if (!workspaceRoot) {
    throw new Error(
      `${pkg.name || "package"}: found 'workspace:' dependencies but no workspace root ancestor has a 'workspaces' field`,
    );
  }
  log(`Resolving workspace: deps against workspace root ${workspaceRoot}`);

  const versionMap = await buildWorkspaceVersionMap(workspaceRoot);

  const result = { ...pkg };
  for (const field of DEP_FIELDS_WITH_WORKSPACE) {
    const deps = result[field];
    if (!deps || typeof deps !== "object") continue;
    const updated = { ...deps };
    for (const [name, spec] of Object.entries(updated)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const version = versionMap.get(name);
      if (!version) {
        throw new Error(
          `${pkg.name || "package"}: ${field}["${name}"] = "${spec}" but no workspace package named "${name}" was found under ${workspaceRoot}`,
        );
      }
      const resolved = resolveWorkspaceSpec(spec, version);
      updated[name] = resolved;
      log(`  ${field}["${name}"]: ${spec} → ${resolved}`);
    }
    result[field] = updated;
  }
  return result;
}

function hasWorkspaceDeps(pkg) {
  for (const field of DEP_FIELDS_WITH_WORKSPACE) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const spec of Object.values(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) return true;
    }
  }
  return false;
}

async function findWorkspaceRoot(startDir) {
  let dir = startDir;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (pkg.workspaces) return dir;
    } catch {
      // Missing or unreadable package.json — not the root, keep going.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function buildWorkspaceVersionMap(workspaceRoot) {
  const rootPkg = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  const patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : rootPkg.workspaces?.packages || [];

  const map = new Map<string, string>();
  for (const pattern of patterns) {
    const dirs = await expandWorkspacePattern(workspaceRoot, pattern);
    for (const d of dirs) {
      try {
        const pkg = JSON.parse(await readFile(join(d, "package.json"), "utf8"));
        if (pkg.name && pkg.version) map.set(pkg.name, pkg.version);
      } catch {
        // Missing or malformed sibling package.json — skip.
      }
    }
  }
  return map;
}

/**
 * Expand a workspace pattern (e.g. "packages/*", "apps/*", "solo") into
 * concrete directory paths. Supports `*` as a single-segment wildcard.
 * `**` is not supported — no real-world agoric-sdk-style workspace uses
 * it, and implementing recursive globs without a library is more code
 * than it's worth for the common case.
 */
async function expandWorkspacePattern(workspaceRoot, pattern) {
  if (pattern.includes("**")) {
    throw new Error(`Unsupported workspace pattern: "${pattern}" (globstar ** is not supported)`);
  }
  const parts = pattern.split("/").filter((p) => p.length > 0);
  let currentDirs = [workspaceRoot];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of currentDirs) {
      if (part === "*") {
        try {
          const entries = await readdir(base, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) next.push(join(base, e.name));
          }
        } catch {
          // base doesn't exist — skip.
        }
      } else if (part.includes("*")) {
        const regex = new RegExp(
          "^" + part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
        );
        try {
          const entries = await readdir(base, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory() && regex.test(e.name)) next.push(join(base, e.name));
          }
        } catch {
          // base doesn't exist — skip.
        }
      } else {
        next.push(join(base, part));
      }
    }
    currentDirs = next;
  }
  return currentDirs;
}

/**
 * Translate a single `workspace:` specifier into the published form.
 *  workspace:*       → <version>
 *  workspace:^       → ^<version>
 *  workspace:~       → ~<version>
 *  workspace:<range> → <range>
 */
export function resolveWorkspaceSpec(spec, version) {
  if (typeof spec !== "string" || !spec.startsWith("workspace:")) return spec;
  const rest = spec.slice("workspace:".length);
  if (rest === "" || rest === "*") return version;
  if (rest === "^") return `^${version}`;
  if (rest === "~") return `~${version}`;
  return rest;
}

export function rewritePackageJson(pkg) {
  const result = { ...pkg };

  // Remove development-only fields that aren't needed in the published package
  delete result.devDependencies;
  delete result.scripts;

  // Rewrite entry points
  if (result.main) result.main = rewriteTsToJs(result.main);
  if (result.module) result.module = rewriteTsToJs(result.module);

  // Rewrite or derive types
  if (result.types) {
    result.types = rewriteTsToDts(result.types);
  } else if (result.typings) {
    result.typings = rewriteTsToDts(result.typings);
  } else if (result.main) {
    result.types = result.main.replace(/\.js$/, ".d.ts");
  }

  // Rewrite bin
  if (result.bin) {
    if (typeof result.bin === "string") {
      result.bin = rewriteTsToJs(result.bin);
    } else if (typeof result.bin === "object") {
      for (const [key, value] of Object.entries(result.bin)) {
        result.bin[key] = rewriteTsToJs(value);
      }
    }
  }

  // Rewrite exports
  if (result.exports) {
    result.exports = rewriteExportsValue(result.exports, false);
  }

  // Rewrite files array
  if (Array.isArray(result.files)) {
    result.files = result.files.flatMap((f) => {
      if (typeof f === "string" && /\.tsx?$/.test(f)) {
        return [rewriteTsToJs(f), rewriteTsToDts(f)];
      }
      return [f];
    });
  }

  return result;
}

function rewriteTsToJs(p) {
  return typeof p === "string" ? p.replace(/\.tsx?$/, ".js") : p;
}

function rewriteTsToDts(p) {
  return typeof p === "string" ? p.replace(/\.tsx?$/, ".d.ts") : p;
}

function rewriteExportsValue(value, isTypesKey) {
  if (typeof value === "string") {
    return isTypesKey ? rewriteTsToDts(value) : rewriteTsToJs(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteExportsValue(v, isTypesKey));
  }
  if (typeof value === "object" && value !== null) {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = rewriteExportsValue(val, key === "types");
    }
    return result;
  }
  return value;
}

async function validate(stagingDir, pkg, log) {
  const errors = [];

  // Check .js and .d.ts files for remaining .ts specifiers
  const allFiles = await findFiles(
    stagingDir,
    (name) => name.endsWith(".js") || name.endsWith(".d.ts"),
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
    if (typeof pkg[field] === "string" && /(?<!\.d)\.tsx?$/.test(pkg[field])) {
      errors.push(`package.json "${field}" still references .ts: ${pkg[field]}`);
    }
  }

  // Non-fatal: yarn/npm tolerate `bin`/`main` pointing at missing
  // files. Real transformation bugs are caught by the specifier
  // checks above.
  const referencedFiles = collectReferencedFiles(pkg);
  for (const ref of referencedFiles) {
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

function collectReferencedFiles(pkg) {
  const refs = new Set<string>();

  for (const field of ["main", "module", "types", "typings"]) {
    if (typeof pkg[field] === "string") {
      refs.add(pkg[field].replace(/^\.\//, ""));
    }
  }

  if (typeof pkg.bin === "string") {
    refs.add(pkg.bin.replace(/^\.\//, ""));
  } else if (typeof pkg.bin === "object" && pkg.bin !== null) {
    for (const v of Object.values(pkg.bin)) {
      if (typeof v === "string") refs.add(v.replace(/^\.\//, ""));
    }
  }

  if (pkg.exports) {
    collectExportsRefs(pkg.exports, refs);
  }

  return refs;
}

function collectExportsRefs(value, refs) {
  if (typeof value === "string") {
    refs.add(value.replace(/^\.\//, ""));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectExportsRefs(v, refs);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      collectExportsRefs(v, refs);
    }
  }
}

async function pack(stagingDir) {
  const { stdout } = await execFileAsync("npm", ["pack"], {
    cwd: stagingDir,
  });
  const tgzName = stdout.trim().split("\n").pop();
  return join(stagingDir, tgzName);
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
