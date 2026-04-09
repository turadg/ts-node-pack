/**
 * @file Rewrite relative TypeScript specifiers to JavaScript ones.
 *
 * The input grammar is intentionally narrow: a relative path (`./` or
 * `../`) ending in `.ts`, `.tsx`, or `.mts`, embedded in one of six
 * specific syntactic contexts. The output replaces the extension with
 * `.js` (for `.ts`/`.tsx`) or `.mjs` (for `.mts`), matching what
 * `ts-blank-space` produces in the strip phase.
 *
 * Why regex is sound here:
 *
 *   The inputs are tsc-emitted `.d.ts` declaration files and JS sources
 *   stripped of types — both highly constrained subsets of JavaScript:
 *
 *   - Import/export specifiers are always single-line string literals.
 *   - Specifiers are always wrapped in matching quotes (' or ").
 *   - Relative paths always start with `./` or `../`.
 *   - No template literals, concatenation, or computed specifiers appear.
 *
 *   Because the grammar of relative specifiers in this input is regular
 *   (a finite set of keyword prefixes + a quoted string literal), regex
 *   matches it exactly with no false positives — provided the patterns
 *   below stay in sync with each other and the validator that uses them.
 */

// Six shapes for a relative TypeScript specifier in a string literal:
//   1. `from './foo.ts'`                — named/default/type imports, re-exports
//   2. `import './foo.ts'`              — bare side-effect imports
//   3. `import('./foo.ts')`             — dynamic imports
//   4. `require('./foo.ts')`            — CJS requires (in .cjs / .d.cts)
//   5. `declare module './foo.ts' {…}`  — TypeScript ambient declarations
//   6. `/// <reference path="./foo.ts"/>` — triple-slash directives
//
// The extension capture group matches `ts`, `tsx`, or `mts`. The
// negative lookbehind `(?<!\.d)` prevents the regex from matching
// `./foo.d.ts` (and `.d.mts`/`.d.cts`/`.d.tsx`), which are pure
// declaration files that must keep their original specifiers.
//
// Word-boundary anchors (`\b`) on the keyword-leading patterns prevent
// false positives on identifiers like `myfrom` or `customRequire`.
//
// Used both to rewrite specifiers and (in the validator) to detect any
// specifier that slipped through. Patterns must stay in sync.
export const TS_SPECIFIER_PATTERNS = [
  /(\bfrom\s*['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"])/g,
  /(\bimport\s+['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"])/g,
  /(\bimport\s*\(\s*['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"]\s*\))/g,
  /(\brequire\s*\(\s*['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"]\s*\))/g,
  /(\bdeclare\s+module\s*['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"])/g,
  /(<reference\s+path\s*=\s*['"])(\.\.?\/[^'"]*?)(?<!\.d)\.(tsx?|mts)(['"])/g,
];

/**
 * Apply every pattern in TS_SPECIFIER_PATTERNS to `content`, rewriting
 * each matched relative TypeScript specifier to its corresponding
 * JavaScript form. Returns the transformed string; the input is not
 * mutated.
 */
export function rewriteTsSpecifiers(content: string): string {
  for (const pattern of TS_SPECIFIER_PATTERNS) {
    content = content.replace(
      pattern,
      (_m, pre, path, ext, post) => pre + path + (ext === "mts" ? ".mjs" : ".js") + post,
    );
  }
  return content;
}
