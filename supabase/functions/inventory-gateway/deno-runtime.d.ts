declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

declare module "node:async_hooks" { export class AsyncLocalStorage<T> { getStore(): T | undefined; run<R>(store: T, callback: () => R): R; } }
