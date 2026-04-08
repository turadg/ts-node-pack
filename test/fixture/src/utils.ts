import type { Greeting } from "./types.ts";

export function createGreeting(message: string): Greeting {
  return { message, timestamp: Date.now() };
}

export function formatGreeting(g: Greeting): string {
  return `[${g.timestamp}] ${g.message}`;
}
