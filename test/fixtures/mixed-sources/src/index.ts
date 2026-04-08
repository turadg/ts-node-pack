// A .ts source that imports a .js sibling, a .mts sibling, and uses a
// type from a hand-authored .d.ts file with no runtime twin.
import { plainHelper } from "./plain.js";
import { moduleHelper } from "./module.mts";
import type { Branded } from "./tagged.d.ts";

export function tagged(x: number): Branded {
  return (x + plainHelper() + moduleHelper()) as Branded;
}
