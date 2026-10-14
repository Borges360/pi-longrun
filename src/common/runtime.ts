import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { loadConfig, saveConfig, type Config } from "./config.js";
import {
  FileStorage,
  SqliteStorage,
  type StorageBase,
  type PortableSnapshot,
} from "./storage.js";
import { DurableStorage } from "./durable.js";
import { Interop, type EventBus } from "./contracts.js";
import {
  atomicWrite,
  canonical,
  digest,
  projectKey,
  redact,
} from "./security.js";

export interface CommandContext {
  cwd: string;
  trusted: boolean;
  signal?: AbortSignal;
  hostContext?: ExtensionContext;
  commandContext?: ExtensionCommandContext;
}
export interface Service {
  capabilities: string[];
  menu: string[];
  menuGroups?: Record<string, string[]>;
  menuInputs?: Record<string, string>;
  command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown>;
  start?(): Promise<void>;
  close?(): Promise<void>;
  prompt?(prompt: string, context: ExtensionContext): Promise<unknown>;
  toolCall?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined>;
  toolResult?(event: unknown, context: ExtensionContext): Promise<void>;
  messageEnd?(event: unknown, context: ExtensionContext): Promise<void>;
  settle?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ continue?: boolean; entries?: unknown[] } | undefined>;
}
export type ServiceFactory = (host: Host) => Service;
export const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redact(value)) }],
  details: redact(value),
});
export class Host {
  config!: Config;
  store!: StorageBase;
  interop!: Interop;
  service!: Service;
  key = "";
  private started = false;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  migrationFault?: (phase: "after-seal" | "after-pointer") => void;
  constructor(
    readonly extension: string,
    readonly factory: ServiceFactory,
    readonly cwd: string,
    readonly bus: EventBus,
    readonly trusted = false,
    readonly api?: ExtensionAPI,
  ) {}
  async start() {
    if (this.started) return;
    if (!this.starting)
      this.starting = this.initialize().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async initialize() {
    try {
      await this.initializeResources();
    } catch (error) {
      this.interop?.close();
      await this.service?.close?.().catch(() => {});
      await this.store?.close().catch(() => {});
      throw error;
    }
  }
  private async initializeResources() {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted);
    this.key = await projectKey(this.cwd);
    const base = join(this.config.storage.root, "projects", this.key);
    await mkdir(base, { recursive: true, mode: 0o700 });
    let backend = this.config.storage.backend;
    let root = base;
    try {
      const pointer = JSON.parse(
        await readFile(join(base, "backend.json"), "utf8"),
      );
      if (
        !["files", "sqlite", "durable"].includes(pointer.backend) ||
        !/^migration-[a-zA-Z0-9-]+$/.test(pointer.directory)
      )
        throw new Error("invalid-backend-pointer");
      backend = pointer.backend;
      root = join(base, pointer.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.store =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await this.store.open();
    const metadata = await this.store.getMetadata();
    if (metadata.migratedTo) {
      // An old backend is only selected when the pointer switch did not commit.
      // Its own journal is still authoritative, so rollback never replays effects.
      if (metadata.migrationHost !== hostname() || !metadata.migrationPid)
        throw new Error("migration-owner-review-required");
      let dead = false;
      try {
        process.kill(metadata.migrationPid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) throw new Error("migration-in-progress");
      await this.store.rollbackMigration(metadata.migratedTo);
    }
    this.interop = new Interop(
      this.extension,
      this.bus,
      this.key,
      this.config.disabledIntegrations,
    );
    this.service = this.factory(this);
    await this.service.start?.();
    this.interop.start(this.service.capabilities);
    this.started = true;
  }
  async close() {
    await this.starting?.catch(() => {});
    if (!this.started) return;
    this.interop.close();
    await this.service.close?.();
    await this.store.close();
    this.started = false;
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async configure(patch: Partial<Config>) {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted, {
      ...this.config,
      ...patch,
    });
    await saveConfig(this.extension, this.config);
    return this.config;
  }
  async doctor() {
    const recovery = await this.store.recover();
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return {
      extension: this.extension,
      version:
        typeof manifest.version === "string" ? manifest.version : "unknown",
      pi: "1.2.0",
      node: process.versions.node,
      enabled: this.config.enabled,
      mode: this.config.mode,
      storage: this.store.constructor.name,
      recovery,
      integrations: {
        failures: this.interop.failures,
        fallbacks: this.interop.fallbacks,
        incompatible: this.interop.incompatible,
      },
      standalone: true,
    };
  }
  async command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown> {
    if (action === "doctor") return this.doctor();
    if (action === "config") return this.config;
    if (action === "off" || action === "auto" || action === "observe")
      return this.configure({ enabled: action !== "off", mode: action });
    if (action === "storage")
      return args[0] === "migrate"
        ? this.migrate(args[1])
        : {
            backend: this.store.constructor.name,
            root: this.store.options.root,
          };
    return this.service.command(action, args, context);
  }
  async migrate(backend?: string) {
    if (backend !== "files" && backend !== "sqlite" && backend !== "durable")
      throw new Error("supported-backends: files, sqlite, durable");
    const activeChildren = await this.store.listRecords<{ status: string }>(
      "children",
    );
    const activeRuns = await this.store.listRecords<{ status: string }>("runs");
    if (
      activeChildren.some((c) => c.status === "running") ||
      activeRuns.some((r) => r.status === "active")
    )
      throw new Error("pause-active-work-before-migration");
    const sourceStore = this.store;
    const migrationId = crypto.randomUUID();
    const base = join(this.config.storage.root, "projects", this.key);
    const directory = "migration-" + migrationId;
    const root = join(base, directory);
    const target =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await target.open();
    let switched = false;
    let sealed = false;
    let previousPointer: string | undefined;
    try {
      previousPointer = await readFile(join(base, "backend.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      await this.store.transact(async (source) => {
        const frozen = structuredClone(source);
        const logical = (s: PortableSnapshot) =>
          digest({
            metadata: s.metadata,
            records: s.records,
            events: s.events,
            blobs: s.blobs,
          });
        await target.importSnapshot(frozen);
        if (logical(await target.exportSnapshot()) !== logical(frozen))
          throw new Error("migration-parity-failed");
        await target.recover();
        source.metadata.migratedTo = root;
        source.metadata.migrationPid = process.pid;
        source.metadata.migrationHost = hostname();
      });
      sealed = true;
      this.migrationFault?.("after-seal");
      await atomicWrite(
        join(base, "backend.json"),
        canonical({
          schemaVersion: 1,
          backend,
          directory,
          migrationId,
          sourceRoot: this.store.options.root,
        }),
      );
      switched = true;
      this.migrationFault?.("after-pointer");
      await target.recover();
      await this.service.close?.();
      this.store = target;
      // Services capture Host, never a stale store handle; restart listeners after backend replacement.
      this.interop.close();
      this.interop = new Interop(
        this.extension,
        this.bus,
        this.key,
        this.config.disabledIntegrations,
      );
      this.service = this.factory(this);
      await this.service.start?.();
      this.interop.start(this.service.capabilities);
      await sourceStore.close();
      return { migrationId, backend, verified: true, backupPreserved: true };
    } catch (e) {
      if (switched) {
        if (previousPointer)
          await atomicWrite(join(base, "backend.json"), previousPointer);
        else await unlink(join(base, "backend.json"));
      }
      this.store = sourceStore;
      if (sealed) await sourceStore.rollbackMigration(root);
      await target.close();
      throw e;
    }
  }
}
export function register(
  pi: ExtensionAPI,
  extension: string,
  command: string,
  factory: ServiceFactory,
  tools: ToolDefinition[] = [],
) {
  let host: Host | undefined;
  const get = async (ctx: ExtensionContext) => {
    if (!host || host.cwd !== ctx.cwd) {
      await host?.close();
      host = new Host(
        extension,
        factory,
        ctx.cwd,
        pi.events,
        ctx.isProjectTrusted(),
        pi,
      );
      await host.start();
    }
    await host.start();
    return host;
  };
  const show = (value: unknown, feedback?: string) =>
    pi.sendMessage({
      customType: extension,
      content: `${feedback ? `${feedback}\n\n` : ""}${JSON.stringify(
        redact(value),
        null,
        2,
      )}`,
      display: true,
    });
  pi.on("session_start", async (_e, ctx) => {
    await get(ctx);
  });
  pi.on("session_shutdown", async () => {
    await host?.close();
    host = undefined;
  });
  pi.registerCommand(command, {
    description: `${extension}: status, explain, mode/config, doctor`,
    handler: async (args, ctx) => {
      const h = await get(ctx);
      const interactive = ctx.mode === "tui" && ctx.hasUI;
      const groups = h.service.menuGroups ?? {
        Ações: h.service.menu,
        Configurações: ["mode", "doctor"],
      };
      const options = [
        {
          action: "auto",
          label: "Automático",
          description:
            "Permite continuações automáticas para tarefas elegíveis.",
        },
        {
          action: "observe",
          label: "Observar decisões",
          description: "Observa o trabalho sem continuar automaticamente.",
        },
        {
          action: "off",
          label: "Desativado",
          description: "Desativa as integrações automáticas do Longrun.",
        },
      ];
      const labelFor = (mode: string) =>
        options.find((option) => option.action === mode)?.label ??
        "Desconhecido";
      const formatKey = (key: string) =>
        key
          .split("+")
          .map(
            (part) =>
              ({ enter: "Enter", return: "Enter", escape: "Esc" })[
                part.toLowerCase()
              ] ?? part.toUpperCase(),
          )
          .join("+");

      const showModePanel = async () => {
        let activeAction =
          !h.config.enabled || h.config.mode === "off"
            ? "off"
            : h.config.mode === "observe"
              ? "observe"
              : "auto";
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => {
            let saving = false;
            let status = "";
            const confirmKeys =
              keybindings
                .getKeys("tui.select.confirm")
                .map(formatKey)
                .join(" / ") || "Enter";
            const cancelKeys =
              keybindings
                .getKeys("tui.select.cancel")
                .map(formatKey)
                .join(" / ") || "Esc";
            const fit = (line: string, width: number) =>
              line.length <= width
                ? line
                : line.slice(0, Math.max(0, width - 1)) + "~";

            return {
              render(width) {
                const current =
                  options.find((option) => option.action === activeAction) ??
                  options[0]!;
                const nextIndex =
                  (options.findIndex(
                    (option) => option.action === activeAction,
                  ) +
                    1) %
                  options.length;
                const next = options[nextIndex]!.label;
                const lines = [
                  "Longrun / Configurações / Modo",
                  "",
                  "MODO ATUAL",
                  current.label,
                  current.description,
                  "",
                  "PRÓXIMA AÇÃO",
                  `[ ${confirmKeys} ] Mudar para ${next}`,
                  options[nextIndex]!.description,
                  `${confirmKeys}: salvar    ${cancelKeys}: voltar às configurações`,
                  status,
                ];
                return lines.map((line, index) => {
                  const visible = fit(line, width).padEnd(width, " ");
                  const foreground = [0, 2, 6, 7].includes(index)
                    ? theme.fg("accent", theme.bold(visible))
                    : theme.fg("toolOutput", visible);
                  return theme.bg("toolPendingBg", foreground);
                });
              },
              invalidate() {},
              async handleInput(data) {
                if (keybindings.matches(data, "tui.select.cancel")) {
                  done(undefined);
                  return;
                }
                if (saving || !keybindings.matches(data, "tui.select.confirm"))
                  return;

                const currentIndex = options.findIndex(
                  (option) => option.action === activeAction,
                );
                const next = options[(currentIndex + 1) % options.length]!;
                saving = true;
                try {
                  await h.serial(() =>
                    h.command(next.action, [], {
                      cwd: ctx.cwd,
                      trusted: ctx.isProjectTrusted(),
                      hostContext: ctx,
                      commandContext: ctx,
                      signal: ctx.signal,
                    }),
                  );
                  activeAction = next.action;
                  status = `Salvo: ${labelFor(activeAction)}.`;
                } catch {
                  status = "Não foi possível salvar. Tente novamente.";
                } finally {
                  saving = false;
                  tui.requestRender();
                }
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "72%",
              maxHeight: 15,
              anchor: "center",
              margin: 1,
            },
          },
        );
      };

      const runMenu = async (initialGroup?: string) => {
        let group = initialGroup;
        while (true) {
          if (!group) {
            group = await ctx.ui.select(extension, Object.keys(groups));
            if (!group) return;
          }
          const choices = [...(groups[group] ?? []), "Voltar ao Longrun"];
          const selected = await ctx.ui.select(group, choices);
          if (!selected || selected === "Voltar ao Longrun") {
            group = undefined;
            continue;
          }

          const selectedParts = selected.split(/\s+/);
          const selectedAction = selectedParts[0] ?? "status";
          if (selectedAction === "mode" || selectedAction === "config") {
            await showModePanel();
            continue;
          }

          const inputTitle = h.service.menuInputs?.[selected];
          if (inputTitle) {
            const value = await ctx.ui.input(inputTitle);
            if (!value?.trim()) continue;
            selectedParts.push(value.trim());
          }
          const menuAction = selectedParts.shift() ?? "status";
          const result = await h.serial(() =>
            h.command(menuAction, selectedParts, {
              cwd: ctx.cwd,
              trusted: ctx.isProjectTrusted(),
              hostContext: ctx,
              commandContext: ctx,
              signal: ctx.signal,
            }),
          );
          show(result);
        }
      };

      let parts = args.trim().split(/\s+/).filter(Boolean);
      if (interactive && parts.length === 0) {
        await runMenu();
        return;
      }
      let action = parts.shift() ?? "status";
      if (action === "mode") action = "config";
      if (action === "config" && interactive) {
        await showModePanel();
        await runMenu("Configurações");
        return;
      }
      const result = await h.serial(() =>
        h.command(action, parts, {
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
          hostContext: ctx,
          commandContext: ctx,
          signal: ctx.signal,
        }),
      );
      show(result);
    },
  });
  for (const t of tools)
    pi.registerTool({
      ...t,
      execute: async (callId, input, signal, onUpdate, ctx) => {
        await get(ctx);
        return t.execute(callId, input, signal, onUpdate, ctx);
      },
    });
  pi.on("before_agent_start", async (e, ctx) => {
    const h = await get(ctx);
    if (
      !h.config.enabled ||
      h.config.mode === "off" ||
      e.messageType !== "user"
    )
      return;
    const value = await h.serial(
      () => h.service.prompt?.(e.prompt, ctx) ?? Promise.resolve(undefined),
    );
    if (value !== undefined)
      return {
        message: {
          customType: extension,
          content: JSON.stringify(redact(value)),
          display: false,
        },
      };
  });
  pi.on("tool_call", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      return h.serial(
        () => h.service.toolCall?.(e, ctx) ?? Promise.resolve(undefined),
      );
  });
  pi.on("tool_result", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      await h.serial(() => h.service.toolResult?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("message_end", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      await h.serial(() => h.service.messageEnd?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("agent_before_settle", async (e, ctx) => {
    const h = await get(ctx);
    if (!h.config.enabled || h.config.mode === "observe") return;
    return (await h.serial(
      () => h.service.settle?.(e, ctx) ?? Promise.resolve(undefined),
    )) as { continue?: boolean } | undefined;
  });
  return { get };
}
