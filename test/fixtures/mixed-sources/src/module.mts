// A .mts source. ts-node-pack must strip it in place and rename to
// .mjs, and any specifiers pointing at it elsewhere must be rewritten
// from `.mts` to `.mjs` (not `.js`).
export function moduleHelper(): number {
  return 2;
}
