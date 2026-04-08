import "./init.ts";
import { createGreeting, formatGreeting } from "./utils.ts";
import type { Greeting, GreetFn } from "./types.ts";

export type { Greeting, GreetFn };
export { createGreeting, formatGreeting };

export function greet(name: string): string {
  const g = createGreeting(`Hello, ${name}!`);
  return formatGreeting(g);
}
