import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getCatalogsFromWorkspaceManifest } from "@pnpm/catalogs.config";
import { resolveFromCatalog } from "@pnpm/catalogs.resolver";

/** The normalized catalog tables produced by the pnpm catalog config. */
export type Catalogs = ReturnType<typeof getCatalogsFromWorkspaceManifest>;

/**
 * Workspace config files that may define a dependency catalog, in lookup
 * priority order. Both Yarn berry (`.yarnrc.yml`) and pnpm
 * (`pnpm-workspace.yaml`) express catalogs with the identical top-level
 * `catalog:` / `catalogs:` shape, so a single YAML parse + the pnpm
 * normalizer handles both.
 */
const CATALOG_CONFIG_FILES = [".yarnrc.yml", "pnpm-workspace.yaml"];

/**
 * Walk upward from `startDir` looking for a workspace config file that
 * defines a catalog. Returns the normalized catalogs together with the
 * path of the file they came from, or null if no catalog config exists in
 * any ancestor.
 *
 * The first file found that actually declares `catalog`/`catalogs` wins; a
 * config file present but without catalog keys is skipped (it is not a
 * catalog source) and the walk continues upward.
 */
export async function loadCatalogs(
  startDir: string,
): Promise<{ catalogs: Catalogs; source: string } | null> {
  let dir = startDir;
  while (true) {
    for (const file of CATALOG_CONFIG_FILES) {
      const configPath = join(dir, file);
      let raw: string;
      try {
        raw = await readFile(configPath, "utf8");
      } catch {
        continue; // file absent here — try the next candidate / parent
      }
      const manifest = parseYaml(raw) ?? {};
      if (manifest.catalog == null && manifest.catalogs == null) continue;
      const catalogs = getCatalogsFromWorkspaceManifest({
        catalog: manifest.catalog,
        catalogs: manifest.catalogs,
      });
      return { catalogs, source: configPath };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a single `catalog:` specifier for dependency `depName` against
 * the given catalogs. Returns the concrete specifier from the catalog
 * (verbatim, including `npm:` alias specs). Non-catalog specs pass through
 * unchanged.
 *
 * Throws on a misconfigured catalog reference (unknown catalog, or a
 * dependency the catalog doesn't list) — a broken workspace config that
 * would otherwise ship an unpublishable tarball.
 */
export function resolveCatalogSpec(spec: unknown, depName: string, catalogs: Catalogs): unknown {
  if (typeof spec !== "string" || !spec.startsWith("catalog:")) return spec;
  const result = resolveFromCatalog(catalogs, {
    alias: depName,
    bareSpecifier: spec,
  });
  switch (result.type) {
    case "found":
      return result.resolution.specifier;
    case "unused":
      // Should be unreachable given the startsWith guard above, but treat a
      // spec the resolver declines to touch as a pass-through rather than
      // forcing it.
      return spec;
    case "misconfiguration":
      throw result.error;
    default:
      return spec;
  }
}
