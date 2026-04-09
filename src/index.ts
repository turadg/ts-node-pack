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
import { rewriteTsSpecifiers } from "./rewrite-specifiers.ts";
import { validate } from "./validation.ts";

const execFileAsync = promisify(execFile);

export interface TsNodePackOptions {
  tsconfig?: string;
  /**
   * Skip the final `npm pack` step. Requires `stageTo` (otherwise there
   * is no way for the caller to access the staged contents).
   */
  skipPack?: boolean;
  /**
   * Stage directly into this directory instead of an auto-created temp
   * dir. Caller owns cleanup. Errors if the directory already has
   * contents, unless `force` is set.
   */
  stageTo?: string;
  /** With `stageTo`, clear the target directory if it already has contents. */
  force?: boolean;
  verbose?: boolean;
}

/**
 * Main pipeline: pack a TypeScript package into a Node-compatible tarball.
 * Returns the path to the .tgz file, or the staging directory when
 * `skipPack` is set.
 */
export async function tsNodePack(
  packageDir: string,
  options: TsNodePackOptions = {},
): Promise<string> {
  const { tsconfig, skipPack, stageTo, force, verbose } = options;
  const log = verbose ? (...args: unknown[]) => console.error("[ts-node-pack]", ...args) : () => {};

  if (skipPack && !stageTo) {
    throw new Error(
      "skipPack requires stageTo: caller must specify where to put the staged contents",
    );
  }

  packageDir = resolve(packageDir);

  // ── Phase 1: Resolve package ──────────────────────────────────────────
  log("Phase 1: Resolving package...");
  const pkgJsonPath = join(packageDir, "package.json");
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  log(`Package: ${pkgJson.name}@${pkgJson.version}`);

  const tsconfigPath = resolveTsconfig(packageDir, tsconfig);
  if (tsconfigPath) log(`Found tsconfig: ${tsconfigPath}`);

  // ── Phase 2: Create work and staging directories ─────────────────────
  // We always need a private work dir for auxiliary files (e.g.
  // tsconfig.emit.json) that MUST NOT land inside the packed contents.
  // In default mode the staging dir is nested inside the work dir, so
  // cleaning up the work dir cleans up everything. In stageTo mode the
  // staging dir is the caller's directory — we still create a small
  // separate work dir for auxiliary files and rm only that in Phase 10.
  log("Phase 2: Creating work and staging directories...");
  const workDir = await mkdtemp(join(tmpdir(), "ts-node-pack-"));
  let stagingDir: string;
  if (stageTo) {
    stagingDir = resolve(stageTo);
    if (existsSync(stagingDir)) {
      const entries = await readdir(stagingDir);
      if (entries.length > 0) {
        if (!force) {
          throw new Error(
            `stageTo directory is not empty: ${stagingDir}. Pass force: true to clear it.`,
          );
        }
        await rm(stagingDir, { recursive: true, force: true });
      }
    }
    await mkdir(stagingDir, { recursive: true });
  } else {
    stagingDir = join(workDir, "package");
    await mkdir(stagingDir, { recursive: true });
  }
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
    // Trigger declaration emit only when there's something to derive:
    //   1. user passed --tsconfig (explicit opt-in), OR
    //   2. any source contains .ts/.tsx/.mts (we'd be stripping them
    //      anyway, and probably want their declarations).
    // The mere presence of tsconfig.build.json is NOT enough — monorepos
    // commonly keep one per package for a root project-references build
    // (`tsc --build`) without intending each package to be independently
    // emit-able. Pure JS+JSDoc packages with no .ts sources skip tsc and
    // ship whatever .js files are already in the packlist, matching plain
    // `npm pack` semantics.
    const hasTsSources = packFiles.some(
      (f) => /\.(ts|tsx|mts)$/.test(f) && !/\.d\.(ts|mts)$/.test(f),
    );
    const shouldRunTsc = tsconfigPath !== null && (tsconfig !== undefined || hasTsSources);

    if (shouldRunTsc) {
      log("Phase 4: Generating derived tsconfig...");
      const emitConfigPath = join(workDir, "tsconfig.emit.json");
      // tsc's typeRoots walk-up starts at the config's directory, so it
      // can't reach packageDir/node_modules/@types from our temp-dir
      // location. Pin typeRoots when that directory exists. (TS 6.0
      // surfaces the missing resolution as TS2688 instead of the silent
      // "Cannot find module 'node:util'" cascade of earlier versions.)
      // Walk upward to find the nearest ancestor that actually has
      // node_modules/@types. Yarn 4's pnpm linker keeps `@types` only at
      // the workspace root, so the package's own node_modules is empty.
      const findAtTypes = (start: string): string | null => {
        let dir = start;
        while (true) {
          const candidate = join(dir, "node_modules", "@types");
          if (existsSync(candidate)) return candidate;
          const parent = dirname(dir);
          if (parent === dir) return null;
          dir = parent;
        }
      };
      const atTypesDir = findAtTypes(packageDir);
      const hasAtTypes = atTypesDir !== null;
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
    if (!skipPack) {
      log("Phase 9: Packing...");
      const tgzPath = await pack(stagingDir);
      const tgzName = basename(tgzPath);
      const dest = join(process.cwd(), tgzName);
      await copyFile(tgzPath, dest);
      // In stageTo mode the whole staging dir survives into the caller's
      // filesystem, so the intermediate .tgz that `npm pack` wrote in
      // there would stick around as visible clutter. Remove it. (In
      // default mode the entire workDir is rm'd in Phase 10, so this
      // unlink is redundant but harmless.)
      if (stageTo) await unlink(tgzPath);
      log(`Created: ${dest}`);
      return dest;
    }

    log(`Skip-pack mode. Staging directory: ${stagingDir}`);
    return stagingDir;
  } finally {
    // ── Phase 10: Cleanup ───────────────────────────────────────────────
    // Always rm the work dir. In default mode this also removes the
    // staging dir (nested inside). In stageTo mode the staging dir is
    // the caller's directory and survives.
    log("Phase 10: Cleaning up work directory...");
    await rm(workDir, { recursive: true, force: true });
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

async function findLocalTsc(cwd) {
  // Prefer a local tsc so users control the compiler version (and to avoid
  // npx resolving to macOS's /usr/bin/tsc — the TeX/Smalltalk compiler —
  // when no local install exists). In a monorepo, the package's own
  // node_modules/.bin may be empty while the workspace root has the
  // binary, so walk upward the same way npm's `$PATH` composition does.
  const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const fromBin = findLocalBin(cwd, binName);
  if (fromBin !== null) return fromBin;
  // Yarn 4's pnpm/PnP linkers do not populate node_modules/.bin/. Fall back
  // to `yarn bin tsc`, which resolves through the active linker and prints
  // the absolute path of the tsc binary when the workspace depends on it.
  try {
    const { stdout } = await execFileAsync("yarn", ["bin", "tsc"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const candidate = stdout.trim().split("\n").pop();
    if (candidate && existsSync(candidate)) return candidate;
  } catch {
    // `yarn` not on PATH or not a yarn project — fall through to npx.
  }
  return null;
}

async function runTsc(emitConfigPath, cwd, log) {
  const localTsc = await findLocalTsc(cwd);
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
  const originalMain = result.main;
  if (result.main) result.main = rewriteTsToJs(result.main);
  if (result.module) result.module = rewriteTsToJs(result.module);
  const mainWasTs = result.main !== originalMain;

  // Only synthesize a `types` field from `main` when `main` was a .ts
  // source (a .d.ts will be emitted alongside the .js). For pure JS+JSDoc
  // packages, inventing `"./index.d.ts"` would point at a file that
  // ts-node-pack never creates — see @endo/ses-ava in agoric/endo, where
  // this produced a dangling types pointer in published tarballs.
  if (result.types) {
    result.types = rewriteTsToDts(result.types);
  } else if (result.typings) {
    result.typings = rewriteTsToDts(result.typings);
  } else if (mainWasTs) {
    result.types = rewriteTsToDts(originalMain);
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
      if (typeof f === "string" && TS_SOURCE_EXT_RE.test(f)) {
        return [rewriteTsToJs(f), rewriteTsToDts(f)];
      }
      return [f];
    });
  }

  return result;
}

// `.ts`/`.tsx` → `.js`; `.mts` → `.mjs`. Matches what `ts-blank-space`
// writes in Phase 6 and the specifier-rewrite pass in rewrite-specifiers.ts.
function rewriteTsToJs(p) {
  if (typeof p !== "string") return p;
  return p.replace(/\.mts$/, ".mjs").replace(/\.tsx?$/, ".js");
}

// `.ts`/`.tsx` → `.d.ts`; `.mts` → `.d.mts`. Matches the declaration files
// tsc emits from an .mts source.
function rewriteTsToDts(p) {
  if (typeof p !== "string") return p;
  return p.replace(/\.mts$/, ".d.mts").replace(/\.tsx?$/, ".d.ts");
}

const TS_SOURCE_EXT_RE = /\.(tsx?|mts)$/;

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
