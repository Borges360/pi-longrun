import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { loadConfig, saveConfig } from "./config.js";
import { FileStorage, SqliteStorage, } from "./storage.js";
import { DurableStorage } from "./durable.js";
import { Interop } from "./contracts.js";
import { atomicWrite, canonical, digest, projectKey, redact, } from "./security.js";
export const toolResult = (value) => ({
    content: [{ type: "text", text: JSON.stringify(redact(value)) }],
    details: redact(value),
});
export class Host {
    extension;
    factory;
    cwd;
    bus;
    trusted;
    api;
    config;
    store;
    interop;
    service;
    key = "";
    started = false;
    starting;
    queue = Promise.resolve();
    migrationFault;
    constructor(extension, factory, cwd, bus, trusted = false, api) {
        this.extension = extension;
        this.factory = factory;
        this.cwd = cwd;
        this.bus = bus;
        this.trusted = trusted;
        this.api = api;
    }
    async start() {
        if (this.started)
            return;
        if (!this.starting)
            this.starting = this.initialize().finally(() => {
                this.starting = undefined;
            });
        return this.starting;
    }
    async initialize() {
        try {
            await this.initializeResources();
        }
        catch (error) {
            this.interop?.close();
            await this.service?.close?.().catch(() => { });
            await this.store?.close().catch(() => { });
            throw error;
        }
    }
    async initializeResources() {
        this.config = await loadConfig(this.extension, this.cwd, this.trusted);
        this.key = await projectKey(this.cwd);
        const base = join(this.config.storage.root, "projects", this.key);
        await mkdir(base, { recursive: true, mode: 0o700 });
        let backend = this.config.storage.backend;
        let root = base;
        try {
            const pointer = JSON.parse(await readFile(join(base, "backend.json"), "utf8"));
            if (!["files", "sqlite", "durable"].includes(pointer.backend) ||
                !/^migration-[a-zA-Z0-9-]+$/.test(pointer.directory))
                throw new Error("invalid-backend-pointer");
            backend = pointer.backend;
            root = join(base, pointer.directory);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
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
            }
            catch (error) {
                dead = error.code === "ESRCH";
            }
            if (!dead)
                throw new Error("migration-in-progress");
            await this.store.rollbackMigration(metadata.migratedTo);
        }
        this.interop = new Interop(this.extension, this.bus, this.key, this.config.disabledIntegrations);
        this.service = this.factory(this);
        await this.service.start?.();
        this.interop.start(this.service.capabilities);
        this.started = true;
    }
    async close() {
        await this.starting?.catch(() => { });
        if (!this.started)
            return;
        this.interop.close();
        await this.service.close?.();
        await this.store.close();
        this.started = false;
    }
    serial(fn) {
        const result = this.queue.then(fn);
        this.queue = result.catch(() => { });
        return result;
    }
    async configure(patch) {
        this.config = await loadConfig(this.extension, this.cwd, this.trusted, {
            ...this.config,
            ...patch,
        });
        await saveConfig(this.extension, this.config);
        return this.config;
    }
    async doctor() {
        const recovery = await this.store.recover();
        const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
        return {
            extension: this.extension,
            version: typeof manifest.version === "string" ? manifest.version : "unknown",
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
    async command(action, args, context) {
        if (action === "doctor")
            return this.doctor();
        if (action === "config")
            return this.config;
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
    async migrate(backend) {
        if (backend !== "files" && backend !== "sqlite" && backend !== "durable")
            throw new Error("supported-backends: files, sqlite, durable");
        const activeChildren = await this.store.listRecords("children");
        const activeRuns = await this.store.listRecords("runs");
        if (activeChildren.some((c) => c.status === "running") ||
            activeRuns.some((r) => r.status === "active"))
            throw new Error("pause-active-work-before-migration");
        const sourceStore = this.store;
        const migrationId = crypto.randomUUID();
        const base = join(this.config.storage.root, "projects", this.key);
        const directory = "migration-" + migrationId;
        const root = join(base, directory);
        const target = backend === "files"
            ? new FileStorage({ root, extension: this.extension })
            : backend === "sqlite"
                ? new SqliteStorage({ root, extension: this.extension })
                : new DurableStorage({ root, extension: this.extension });
        await target.open();
        let switched = false;
        let sealed = false;
        let previousPointer;
        try {
            previousPointer = await readFile(join(base, "backend.json"), "utf8");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
        try {
            await this.store.transact(async (source) => {
                const frozen = structuredClone(source);
                const logical = (s) => digest({
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
            await atomicWrite(join(base, "backend.json"), canonical({
                schemaVersion: 1,
                backend,
                directory,
                migrationId,
                sourceRoot: this.store.options.root,
            }));
            switched = true;
            this.migrationFault?.("after-pointer");
            await target.recover();
            await this.service.close?.();
            this.store = target;
            // Services capture Host, never a stale store handle; restart listeners after backend replacement.
            this.interop.close();
            this.interop = new Interop(this.extension, this.bus, this.key, this.config.disabledIntegrations);
            this.service = this.factory(this);
            await this.service.start?.();
            this.interop.start(this.service.capabilities);
            await sourceStore.close();
            return { migrationId, backend, verified: true, backupPreserved: true };
        }
        catch (e) {
            if (switched) {
                if (previousPointer)
                    await atomicWrite(join(base, "backend.json"), previousPointer);
                else
                    await unlink(join(base, "backend.json"));
            }
            this.store = sourceStore;
            if (sealed)
                await sourceStore.rollbackMigration(root);
            await target.close();
            throw e;
        }
    }
}
export function register(pi, extension, command, factory, tools = []) {
    let host;
    const get = async (ctx) => {
        if (!host || host.cwd !== ctx.cwd) {
            await host?.close();
            host = new Host(extension, factory, ctx.cwd, pi.events, ctx.isProjectTrusted(), pi);
            await host.start();
        }
        await host.start();
        return host;
    };
    const show = (value, feedback) => pi.sendMessage({
        customType: extension,
        content: `${feedback ? `${feedback}\n\n` : ""}${JSON.stringify(redact(value), null, 2)}`,
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
        description: `${extension}: status, explain, config, doctor`,
        handler: async (args, ctx) => {
            const h = await get(ctx);
            let parts = args.trim().split(/\s+/).filter(Boolean);
            if (!parts.length && ctx.mode === "tui" && ctx.hasUI) {
                const groups = h.service.menuGroups ?? {
                    Actions: h.service.menu,
                    Settings: ["config", "doctor", "off"],
                };
                const group = await ctx.ui.select(extension, Object.keys(groups));
                if (!group)
                    return;
                const selected = await ctx.ui.select(group, groups[group] ?? []);
                if (!selected)
                    return;
                parts = selected.split(/\s+/);
                const inputTitle = h.service.menuInputs?.[selected];
                if (inputTitle) {
                    const value = await ctx.ui.input(inputTitle);
                    if (!value?.trim())
                        return;
                    parts.push(value.trim());
                }
            }
            let action = parts.shift() ?? "status";
            let feedback;
            if (action === "config" && ctx.mode === "tui" && ctx.hasUI) {
                const activeAction = !h.config.enabled || h.config.mode === "off"
                    ? "off"
                    : h.config.mode === "observe"
                        ? "observe"
                        : "auto";
                const options = [
                    { action: "auto", label: "Enable automatic mode" },
                    { action: "observe", label: "Observe decisions" },
                    { action: "off", label: "Disable" },
                ];
                const labels = options.map(({ action: optionAction, label }) => `${label}${optionAction === activeAction ? " (current)" : ""}`);
                const currentLabel = options.find((option) => option.action === activeAction)?.label ??
                    "Unknown";
                const setting = await ctx.ui.select(`Settings · current: ${currentLabel}`, labels);
                const selectedIndex = labels.indexOf(setting ?? "");
                if (selectedIndex < 0)
                    return;
                action = options[selectedIndex].action;
                feedback =
                    activeAction === action
                        ? `Settings unchanged. ${currentLabel} is already active.`
                        : `Settings saved. ${options[selectedIndex].label} is now active.`;
            }
            const result = await h.serial(() => h.command(action, parts, {
                cwd: ctx.cwd,
                trusted: ctx.isProjectTrusted(),
                hostContext: ctx,
                commandContext: ctx,
                signal: ctx.signal,
            }));
            show(result, feedback);
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
        if (!h.config.enabled ||
            h.config.mode === "off" ||
            e.messageType !== "user")
            return;
        const value = await h.serial(() => h.service.prompt?.(e.prompt, ctx) ?? Promise.resolve(undefined));
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
            return h.serial(() => h.service.toolCall?.(e, ctx) ?? Promise.resolve(undefined));
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
        if (!h.config.enabled || h.config.mode === "observe")
            return;
        return (await h.serial(() => h.service.settle?.(e, ctx) ?? Promise.resolve(undefined)));
    });
    return { get };
}
