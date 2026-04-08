export interface Greeting {
  message: string;
  timestamp: number;
}

export type GreetFn = (name: string) => Greeting;
