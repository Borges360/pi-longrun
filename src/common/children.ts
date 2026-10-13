import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { bound, id, now, redact } from "./security.js";
import { put, type StorageBase } from "./storage.js";
export interface AgentDefinition {
  schemaVersion: 1;
  id: string;
  description: string;
  instructions: string;
  readOnly: boolean;
  paths: string[];
  provider?: string;
  model?: string;
  trusted: boolean;
}
export interface ChildRequest {
  schemaVersion: 1;
  id: string;
  taskId: string;
  objective: string;
  agent: AgentDefinition;
  depth: number;
  ancestors: string[];
  readOnly: boolean;
  independent: boolean;
  cwd: string;
}
export interface ChildResult {
  schemaVersion: 1;
  id: string;
  status: "completed" | "blocked" | "failed";
  summary: string;
  verifiedFacts: string[];
  evidenceRefs: string[];
  filesRead: string[];
  filesChanged: string[];
  openQuestions: string[];
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
}
export interface DelegationDecision {
  schemaVersion: 1;
  owner: string;
  mode: "none" | "single" | "parallel";
  reason: string;
  children: ChildRequest[];
}
export interface WorktreeAdapter {
  create(request: ChildRequest): Promise<string>;
  finish(
    request: ChildRequest,
    path: string,
    result: ChildResult,
  ): Promise<void>;
  remove(path: string): Promise<void>;
}
export type ChildRunner = (
  request: ChildRequest,
  config: Config,
  signal?: AbortSignal,
) => Promise<ChildResult>;
export function delegation(
  owner: string,
  objective: string,
  agents: AgentDefinition[],
  config: Config,
  taskId: string,
  options: {
    cwd: string;
    depth?: number;
    ancestors?: string[];
    independent?: boolean;
    review?: boolean;
    contextChars?: number;
    write?: boolean;
    tightlyCoupled?: boolean;
  },
): DelegationDecision {
  const none = (reason: string): DelegationDecision => ({
    schemaVersion: 1,
    owner,
    mode: "none",
    reason,
    children: [],
  });
  if (!config.enabled || config.mode !== "auto")
    return none("disabled-or-observe");
  if ((options.depth ?? 0) >= config.maxDepth) return none("depth-limit");
  if (options.write && (!config.writeAccess || options.tightlyCoupled))
    return none("write-policy");
  if (
    !options.review &&
    !options.independent &&
    (options.contextChars ?? 0) < 12000
  )
    return none("parent-context-sufficient");
  const available = agents.filter(
    (a) =>
      a.trusted &&
      !(options.ancestors ?? []).includes(a.id) &&
      (!options.write || !a.readOnly),
  );
  const chosen = available.slice(
    0,
    options.independent ? Math.min(2, config.maxParallel) : 1,
  );
  if (!chosen.length) return none("no-trusted-specialist");
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
export async function processRunner(
  request: ChildRequest,
  config: Config,
  signal?: AbortSignal,
): Promise<ChildResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-child-"));
  const start = Date.now();
  const base: ChildResult = {
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
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
  ])
    if (process.env[key]) env[key] = process.env[key];
  for (const key of config.credentialEnv) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      /^(NODE_OPTIONS|NODE_PATH|HOME|USERPROFILE|PI_CODING_AGENT_DIR)$/.test(
        key,
      )
    )
      throw new Error("unsafe-child-env");
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PI_CODING_AGENT_DIR = directory;
  env.HOME = directory;
  env.USERPROFILE = directory;
  try {
    return await new Promise<ChildResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ ...base, status: "blocked", summary: "cancelled" });
        return;
      }
      const child = fork(
        fileURLToPath(new URL("./child-worker.js", import.meta.url)),
        [],
        {
          cwd: request.cwd,
          env,
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: ChildResult) => {
        if (settled) return;
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
      const abort = () =>
        finish({ ...base, status: "blocked", summary: "cancelled" });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => finish({ ...base, status: "blocked", summary: "child-timeout" }),
        config.childTimeoutMs,
      );
      child.once("message", (message: unknown) => {
        const result = message as ChildResult;
        if (
          result?.schemaVersion !== 1 ||
          result.id !== request.id ||
          !["completed", "blocked", "failed"].includes(result.status) ||
          typeof result.summary !== "string" ||
          !Array.isArray(result.evidenceRefs)
        ) {
          finish({ ...base, summary: "invalid-child-result" });
          return;
        }
        finish(result);
      });
      child.once("error", () =>
        finish({ ...base, summary: "child-start-failed" }),
      );
      child.once("exit", () => finish({ ...base, summary: "child-crashed" }));
      child.send({
        request,
        agentDir: directory,
        maxTokens: config.maxChildTokens,
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export class ChildDispatcher {
  private active = 0;
  private controllers = new Set<AbortController>();
  constructor(
    readonly store: StorageBase,
    readonly config: Config,
    readonly runner: ChildRunner = processRunner,
    readonly worktrees?: WorktreeAdapter,
  ) {}
  async dispatch(
    request: ChildRequest,
    signal?: AbortSignal,
  ): Promise<ChildResult> {
    if (
      request.depth > this.config.maxDepth ||
      request.depth < 1 ||
      new Set(request.ancestors).size !== request.ancestors.length ||
      request.ancestors.at(-1) !== request.agent.id
    )
      throw new Error("recursion-or-depth-limit");
    if (!request.agent.trusted) throw new Error("untrusted-agent");
    if (!request.readOnly && (!this.config.writeAccess || !this.worktrees))
      throw new Error("isolated-write-unavailable");
    if (this.active >= this.config.maxParallel)
      throw new Error("parallel-limit");
    this.active++;
    try {
      await this.store.transact((s) => {
        const children = Object.values(s.records.children ?? {}).map(
          (r) => r.value as ChildRequest,
        );
        if (
          children.filter((r) => r.taskId === request.taskId).length >=
          this.config.maxChildrenPerTask
        )
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
      let worktree: string | undefined;
      let result: ChildResult;
      let archived = false;
      try {
        if (!request.readOnly) {
          worktree = await this.worktrees!.create(request);
          await this.store.putRecord("children", request.id, {
            ...request,
            status: "running",
            worktree,
            createdAt: now(),
          });
        }
        result = await this.runner(
          { ...request, cwd: worktree ?? request.cwd },
          this.config,
          controller.signal,
        );
        if (
          result.schemaVersion !== 1 ||
          result.id !== request.id ||
          !["completed", "blocked", "failed"].includes(result.status) ||
          typeof result.summary !== "string"
        )
          throw new Error("invalid-child-result");
        result.summary = bound(result.summary, this.config.maxChildTokens);
        for (const key of [
          "verifiedFacts",
          "evidenceRefs",
          "filesRead",
          "filesChanged",
          "openQuestions",
        ] as const) {
          if (
            !Array.isArray(result[key]) ||
            result[key].some((value) => typeof value !== "string")
          )
            throw new Error("invalid-child-result");
          result[key] = result[key]
            .slice(0, 100)
            .map((value) => bound(value, 200));
        }
        if (worktree && result.status !== "completed") {
          result.openQuestions.push(
            "Interrupted writes retained for explicit review: " + worktree,
          );
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
        if (worktree) await this.worktrees!.finish(request, worktree, result);
        await this.store.putRecord("child-results", request.id, result);
        await this.store.putRecord("children", request.id, {
          ...request,
          status: result.status,
          updatedAt: now(),
        });
        archived = true;
      } finally {
        this.controllers.delete(controller);
        signal?.removeEventListener("abort", abort);
        if (worktree && archived) await this.worktrees!.remove(worktree);
      }
      return result;
    } finally {
      this.active--;
    }
  }
  close() {
    for (const c of this.controllers) c.abort();
  }
}
