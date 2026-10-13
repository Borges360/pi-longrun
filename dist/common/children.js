import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bound, id, now, redact } from "./security.js";
import { put } from "./storage.js";
export function delegation(owner, objective, agents, config, taskId, options) {
    const none = (reason) => ({
        schemaVersion: 1,
        owner,
        mode: "none",
        reason,
        children: [],
    });
    if (!config.enabled || config.mode !== "auto")
        return none("disabled-or-observe");
    if ((options.depth ?? 0) >= config.maxDepth)
        return none("depth-limit");
    if (options.write && (!config.writeAccess || options.tightlyCoupled))
        return none("write-policy");
    if (!options.review &&
        !options.independent &&
        (options.contextChars ?? 0) < 12000)
        return none("parent-context-sufficient");
    const available = agents.filter((a) => a.trusted &&
        !(options.ancestors ?? []).includes(a.id) &&
        (!options.write || !a.readOnly));
    const chosen = available.slice(0, options.independent ? Math.min(2, config.maxParallel) : 1);
    if (!chosen.length)
        return none("no-trusted-specialist");
    return {
        schemaVersion: 1,
        owner,
        mode: chosen.length > 1 ? "parallel" : "single",
        reason: options.review
            ? "independent-review"
            : options.independent
                ? "independent-investigations"
                : "context-isolation",
        children: chosen.map((agent) => ({
            schemaVersion: 1,
            id: id(),
            taskId,
            objective,
            agent,
            depth: (options.depth ?? 0) + 1,
            ancestors: [...(options.ancestors ?? []), agent.id],
            readOnly: !options.write,
            independent: !!options.independent,
            cwd: options.cwd,
        })),
    };
}
export async function processRunner(request, config, signal) {
    const directory = await mkdtemp(join(tmpdir(), "pi-child-"));
    const start = Date.now();
    const base = {
        schemaVersion: 1,
        id: request.id,
        status: "failed",
        summary: "",
        verifiedFacts: [],
        evidenceRefs: [],
        filesRead: [],
        filesChanged: [],
        openQuestions: [],
    };
    const env = {};
    for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "LANG",
    ])
        if (process.env[key])
            env[key] = process.env[key];
    for (const key of config.credentialEnv) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) ||
            /^(NODE_OPTIONS|NODE_PATH|HOME|USERPROFILE|PI_CODING_AGENT_DIR)$/.test(key))
            throw new Error("unsafe-child-env");
        if (process.env[key])
            env[key] = process.env[key];
    }
    env.PI_CODING_AGENT_DIR = directory;
    env.HOME = directory;
    env.USERPROFILE = directory;
    try {
        return await new Promise((resolve) => {
            if (signal?.aborted) {
                resolve({ ...base, status: "blocked", summary: "cancelled" });
                return;
            }
            const adjacentWorker = new URL("./child-worker.js", import.meta.url);
            const worker = existsSync(adjacentWorker)
                ? adjacentWorker
                : new URL("../../dist/common/child-worker.js", import.meta.url);
            const child = fork(fileURLToPath(worker), [], {
                cwd: request.cwd,
                env,
                execArgv: [],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
            });
            let settled = false;
            let timer;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                child.kill("SIGKILL");
                resolve({
                    ...redact(result),
                    summary: bound(result.summary, config.maxChildTokens),
                    durationMs: Date.now() - start,
                });
            };
            const abort = () => finish({ ...base, status: "blocked", summary: "cancelled" });
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => finish({ ...base, status: "blocked", summary: "child-timeout" }), config.childTimeoutMs);
            child.once("message", (message) => {
                const result = message;
                if (result?.schemaVersion !== 1 ||
                    result.id !== request.id ||
                    !["completed", "blocked", "failed"].includes(result.status) ||
                    typeof result.summary !== "string" ||
                    !Array.isArray(result.evidenceRefs)) {
                    finish({ ...base, summary: "invalid-child-result" });
                    return;
                }
                finish(result);
            });
            child.once("error", () => finish({ ...base, summary: "child-start-failed" }));
            child.once("exit", () => finish({ ...base, summary: "child-crashed" }));
            child.send({
                request,
                agentDir: directory,
                maxTokens: config.maxChildTokens,
            });
        });
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export class ChildDispatcher {
    store;
    config;
    runner;
    worktrees;
    active = 0;
    controllers = new Set();
    constructor(store, config, runner = processRunner, worktrees) {
        this.store = store;
        this.config = config;
        this.runner = runner;
        this.worktrees = worktrees;
    }
    async dispatch(request, signal) {
        if (request.depth > this.config.maxDepth ||
            request.depth < 1 ||
            new Set(request.ancestors).size !== request.ancestors.length ||
            request.ancestors.at(-1) !== request.agent.id)
            throw new Error("recursion-or-depth-limit");
        if (!request.agent.trusted)
            throw new Error("untrusted-agent");
        if (!request.readOnly && (!this.config.writeAccess || !this.worktrees))
            throw new Error("isolated-write-unavailable");
        if (this.active >= this.config.maxParallel)
            throw new Error("parallel-limit");
        this.active++;
        try {
            await this.store.transact((s) => {
                const children = Object.values(s.records.children ?? {}).map((r) => r.value);
                if (children.filter((r) => r.taskId === request.taskId).length >=
                    this.config.maxChildrenPerTask)
                    throw new Error("children-per-task-limit");
                if (s.records.children?.[request.id])
                    throw new Error("duplicate-dispatch");
                put(s, "children", request.id, {
                    ...request,
                    status: "running",
                    createdAt: now(),
                });
            });
            const controller = new AbortController();
            this.controllers.add(controller);
            const abort = () => controller.abort();
            signal?.addEventListener("abort", abort, { once: true });
            let worktree;
            let result;
            let archived = false;
            try {
                if (!request.readOnly) {
                    worktree = await this.worktrees.create(request);
                    await this.store.putRecord("children", request.id, {
                        ...request,
                        status: "running",
                        worktree,
                        createdAt: now(),
                    });
                }
                result = await this.runner({ ...request, cwd: worktree ?? request.cwd }, this.config, controller.signal);
                if (result.schemaVersion !== 1 ||
                    result.id !== request.id ||
                    !["completed", "blocked", "failed"].includes(result.status) ||
                    typeof result.summary !== "string")
                    throw new Error("invalid-child-result");
                result.summary = bound(result.summary, this.config.maxChildTokens);
                for (const key of [
                    "verifiedFacts",
                    "evidenceRefs",
                    "filesRead",
                    "filesChanged",
                    "openQuestions",
                ]) {
                    if (!Array.isArray(result[key]) ||
                        result[key].some((value) => typeof value !== "string"))
                        throw new Error("invalid-child-result");
                    result[key] = result[key]
                        .slice(0, 100)
                        .map((value) => bound(value, 200));
                }
                if (worktree && result.status !== "completed") {
                    result.openQuestions.push("Interrupted writes retained for explicit review: " + worktree);
                    await this.store.putRecord("child-results", request.id, result);
                    await this.store.putRecord("children", request.id, {
                        ...request,
                        status: result.status,
                        worktree,
                        needsReview: true,
                        updatedAt: now(),
                    });
                    return result;
                }
                if (worktree)
                    await this.worktrees.finish(request, worktree, result);
                await this.store.putRecord("child-results", request.id, result);
                await this.store.putRecord("children", request.id, {
                    ...request,
                    status: result.status,
                    updatedAt: now(),
                });
                archived = true;
            }
            finally {
                this.controllers.delete(controller);
                signal?.removeEventListener("abort", abort);
                if (worktree && archived)
                    await this.worktrees.remove(worktree);
            }
            return result;
        }
        finally {
            this.active--;
        }
    }
    close() {
        for (const c of this.controllers)
            c.abort();
    }
}
