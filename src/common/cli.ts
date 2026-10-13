import { Host, type ServiceFactory } from "./runtime.js";
import type { EventBus } from "./contracts.js";
export function localBus(): EventBus {
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  return {
    emit: (c, v) => {
      for (const f of listeners.get(c) ?? []) f(v);
    },
    on: (c, f) => {
      if (!listeners.has(c)) listeners.set(c, new Set());
      listeners.get(c)!.add(f);
      return () => {
        listeners.get(c)!.delete(f);
      };
    },
  };
}
export async function cli(
  extension: string,
  factory: ServiceFactory,
  args = process.argv.slice(2),
) {
  const host = new Host(extension, factory, process.cwd(), localBus(), false);
  try {
    await host.start();
    const action = args.shift() ?? "status";
    const result = await host.serial(() =>
      host.command(action, args, { cwd: process.cwd(), trusted: false }),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ error: (e as Error).message }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    await host.close();
  }
}
