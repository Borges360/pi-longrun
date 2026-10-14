import { readFile } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { GateVerifier, completionAllowed, selectProfile, } from "./common/gates.js";
import { assess } from "./common/contracts.js";
import { put } from "./common/storage.js";
import { id, now, bound, contained, digest } from "./common/security.js";
import { LocalGate } from "./gate.js";
import { AcceptanceGateBridge } from "./acceptance-bridge.js";
import { reviseLedger, validateLedgerTasks, WORK_STATE_TOOLS, } from "./ledger.js";
const transitions = {
    pending: ["ready", "blocked", "cancelled"],
    ready: ["running", "blocked", "cancelled"],
    running: ["verifying", "blocked", "cancelled"],
    verifying: ["accepted", "retrying", "failed", "blocked"],
    retrying: ["running", "blocked", "cancelled"],
    blocked: ["ready", "cancelled"],
    accepted: [],
    failed: [],
    cancelled: [],
};
export function transition(task, next) {
    if (!transitions[task.status].includes(next))
        throw new Error("invalid-transition:" + task.status + "->" + next);
    task.status = next;
    task.updatedAt = now();
}
export function canCompleteRun(run, tasks) {
    return (tasks.some((t) => t.required) &&
        tasks.filter((t) => t.required).every((t) => t.status === "accepted") &&
        run.finalGate === "passed" &&
        run.requiredBlockers === 0);
}
export function validateTasks(tasks, limit) {
    validateLedgerTasks(tasks.map((task) => ({ ...task, objective: task.objective ?? task.id })), limit);
}
function checkpoint(s, runId, taskId, phase) {
    const cp = {
        schemaVersion: 1,
        id: id(),
        runId,
        taskId,
        phase,
        sequence: Object.keys(s.records.checkpoints ?? {}).length + 1,
        createdAt: now(),
    };
    put(s, "checkpoints", cp.id, cp);
}
export class Longrun {
    host;
    menuGroups = {
        Run: ["status", "start", "pause", "resume", "stop"],
        Progress: ["tasks", "inspect", "verify", "gate status", "gate verify"],
        Recovery: ["recover"],
        Settings: ["mode", "doctor", "off"],
    };
    menuInputs = { start: "Goal to complete" };
    capabilities = ["task.ledger.v1", "task.checkpoint.v1", "gate.local.v1"];
    menu = [
        "status",
        "tasks",
        "inspect",
        "verify",
        "pause",
        "resume",
        "recover",
        "explain",
    ];
    contextCompacted = false;
    gates;
    acceptanceGate;
    constructor(host) {
        this.host = host;
        this.gates = new LocalGate(host);
        this.acceptanceGate = new AcceptanceGateBridge(host);
    }
    async close() {
        this.acceptanceGate.close();
    }
    async start() {
        await this.recover();
        this.host.interop.listen("pi.gate.result.v1", async (event) => {
            if (event.source === this.host.extension)
                return;
            const g = event.payload;
            if (g.schemaVersion !== 1 ||
                !g.taskId ||
                !g.evidenceRef ||
                !g.outputDigest)
                return;
            await this.host.store.putRecord("external-gates", g.id, {
                gate: g,
                source: event.source,
                receivedAt: now(),
                trustedForCompletion: false,
            });
        });
        this.host.interop.listen("pi.plan.updated.v1", (event) => this.host.serial(() => this.ingestPlan(event.payload)));
    }
    async ingestPlan(raw) {
        const plan = raw;
        if (!plan ||
            typeof plan.planId !== "string" ||
            !Number.isInteger(plan.revision) ||
            !Array.isArray(plan.tasks))
            return;
        const previous = await this.host.store.getRecord("suggested-plans", plan.planId);
        if (previous && previous.revision >= plan.revision)
            return;
        await this.host.store.putRecord("suggested-plans", plan.planId, {
            ...plan,
            applied: false,
        });
        const run = await this.currentRun();
        if (!run || !["active", "blocked"].includes(run.status))
            return;
        const known = [
            ...run.finalAcceptance,
            ...(await this.tasks(run.id)).flatMap((task) => task.acceptance),
        ];
        try {
            const tasks = plan.tasks.map((task) => {
                if (!Array.isArray(task.acceptance) || !Array.isArray(task.dependsOn))
                    throw new Error("invalid-plan-proposal");
                const acceptance = task.acceptance.map((key) => {
                    const requirement = known.find((value) => value.id === key);
                    if (!requirement)
                        throw new Error("structured-verifiers-required");
                    return requirement;
                });
                return {
                    id: task.id,
                    objective: task.objective,
                    dependencies: task.dependsOn,
                    acceptance,
                    scope: task.scope ? { paths: task.scope } : undefined,
                };
            });
            await this.replaceTasks(tasks, {
                evidenceId: plan.evidence?.evidenceRef,
            });
            await this.host.store.putRecord("suggested-plans", plan.planId, {
                ...plan,
                applied: true,
                runId: run.id,
            });
        }
        catch (error) {
            await this.host.store.putRecord("suggested-plans", plan.planId, {
                ...plan,
                applied: false,
                reason: error.message,
            });
        }
    }
    async currentRun() {
        const r = await this.host.store.getRecord("current", "run");
        return r ? this.host.store.getRecord("runs", r.id) : null;
    }
    async tasks(runId) {
        return (await this.host.store.listRecords("tasks")).filter((t) => !runId || t.runId === runId);
    }
    async currentTask() {
        const run = await this.currentRun();
        if (!run || run.status !== "active")
            return null;
        return ((await this.tasks(run.id)).find((t) => ["running", "verifying", "retrying"].includes(t.status)) ?? null);
    }
    async startRun(goal, requirements = [
        { id: "goal-confirmed", kind: "human", required: true },
    ]) {
        if (!goal.trim())
            throw new Error("goal-required");
        const current = await this.currentRun();
        if (current && !["completed", "cancelled"].includes(current.status))
            throw new Error("run-already-open");
        const run = {
            schemaVersion: 1,
            id: id(),
            goal,
            cwd: this.host.cwd,
            status: "active",
            autoContinuations: 0,
            spentUsd: 0,
            replans: 0,
            maxReplans: this.host.config.maxReplans,
            ledgerRevision: 0,
            structuredLedger: false,
            ledgerCalls: 0,
            maxCostUsd: this.host.config.maxCostUsd,
            requiredBlockers: 0,
            finalGate: "pending",
            finalAcceptance: requirements,
            createdAt: now(),
            updatedAt: now(),
        };
        await this.host.store.transact((s) => {
            put(s, "runs", run.id, run);
            put(s, "current", "run", { id: run.id });
            checkpoint(s, run.id, undefined, "run-start");
        });
        await this.replaceTasks([
            {
                id: id(),
                objective: goal,
                dependencies: [],
                acceptance: requirements,
            },
        ], { bootstrap: true });
        await this.advance();
        return run;
    }
    async replaceTasks(inputs, options = {}) {
        await reviseLedger(this.host, inputs, options);
        await this.advance();
        const run = await this.currentRun();
        return this.tasks(run?.id);
    }
    async advance() {
        const run = await this.currentRun();
        if (!run || run.status !== "active")
            return null;
        const nextTask = await this.host.store.transact((s) => {
            const tasks = Object.values(s.records.tasks ?? {})
                .map((r) => r.value)
                .filter((t) => t.runId === run.id);
            const current = tasks.find((t) => ["running", "verifying", "retrying"].includes(t.status));
            if (current)
                return { task: current, started: false };
            for (const task of tasks)
                if (task.status === "pending" &&
                    task.dependencies.every((dep) => tasks.find((t) => t.id === dep)?.status === "accepted")) {
                    transition(task, "ready");
                    put(s, "tasks", task.id, task);
                }
            const next = tasks.find((t) => t.status === "ready");
            if (!next)
                return { task: null, started: false };
            if (next.attempt >=
                Math.min(next.budget.maxAttempts, this.host.config.maxAttempts)) {
                transition(next, "blocked");
                next.blocker = "attempt-budget-exhausted";
                put(s, "tasks", next.id, next);
                const record = s.records.runs[run.id].value;
                record.status = "blocked";
                record.requiredBlockers = tasks.filter((task) => task.required && ["blocked", "failed"].includes(task.status)).length;
                put(s, "runs", record.id, record);
                return { task: null, started: false };
            }
            transition(next, "running");
            next.attempt++;
            put(s, "tasks", next.id, next);
            checkpoint(s, run.id, next.id, "task-start");
            return { task: next, started: true };
        });
        if (nextTask.started && nextTask.task)
            this.host.interop.emit("pi.task.started.v1", {
                taskId: nextTask.task.id,
                objective: nextTask.task.objective,
                constraints: nextTask.task.constraints,
                capabilities: nextTask.task.scope.capabilities ?? [],
            }, { taskId: nextTask.task.id, runId: run.id, correlationId: run.id });
        return nextTask.task;
    }
    async policy() {
        return ((await this.host.store.getRecord("policy", "gates")) ?? {
            approvedCommands: [],
            approvedHumans: [],
            timeoutMs: this.host.config.gateTimeoutMs,
            maxOutputBytes: 262144,
        });
    }
    async verifier() {
        const policy = await this.policy();
        const run = await this.currentRun();
        policy.approvedHumans = policy.approvedHumans
            .filter((value) => run && value.startsWith(run.id + ":"))
            .map((value) => value.slice(run.id.length + 1));
        return new GateVerifier(this.host.store, run?.cwd ?? this.host.cwd, policy);
    }
    async verify(signal) {
        const run = await this.currentRun();
        let task = await this.currentTask();
        if (!run)
            return { status: "no-running-task", results: [] };
        if (run.status !== "active")
            return { status: run.status, results: [] };
        if (!task) {
            const results = await this.finalize(signal);
            return {
                status: (await this.currentRun())?.status === "completed"
                    ? "completed"
                    : "no-running-task",
                results,
            };
        }
        if (run.maxCostUsd !== null && run.spentUsd >= run.maxCostUsd) {
            await this.block(task.id, "budget-exhausted");
            return { status: "blocked", results: [] };
        }
        if (task.status === "retrying") {
            transition(task, "running");
            task.attempt++;
        }
        if (task.status === "running")
            transition(task, "verifying");
        await this.host.store.putRecord("tasks", task.id, task);
        const verifier = await this.verifier();
        const profile = selectProfile(assess(task.objective).risks);
        const results = [];
        for (const requirement of task.acceptance) {
            const result = await verifier.verify(requirement, profile, signal, {
                runId: run.id,
                taskId: task.id,
                attempt: task.attempt,
            });
            result.taskId = task.id;
            result.attempt = task.attempt;
            results.push(result);
            this.host.interop.emit("pi.gate.result.v1", result, {
                taskId: task.id,
                runId: run.id,
                correlationId: run.id,
            });
        }
        const accepted = completionAllowed(task.acceptance, results);
        await this.host.store.transact((snapshot) => {
            const record = snapshot.records.runs[run.id].value;
            for (const result of results) {
                if (result.verified ||
                    result.reason === "human-approval-required" ||
                    result.reason === "command-not-approved" ||
                    result.reason?.startsWith("needs-gate-side-effect-review"))
                    continue;
                if (result.evaluated || result.reason?.includes("ENOENT")) {
                    const proof = {
                        schemaVersion: 1,
                        id: result.id,
                        runId: run.id,
                        revision: record.ledgerRevision ?? 0,
                        kind: result.evaluated
                            ? "verified-gate-failure"
                            : "dependency-missing",
                        evidenceRef: result.evidenceRef,
                        verified: true,
                        consumed: false,
                        createdAt: now(),
                    };
                    put(snapshot, "ledger-evidence", proof.id, proof);
                }
            }
        });
        const review = results.find((result) => result.reason?.startsWith("needs-gate-side-effect-review:") ||
            result.reason === "command-not-approved" ||
            result.reason === "human-approval-required");
        if (review) {
            await this.block(task.id, review.reason);
            return { status: "blocked", results };
        }
        await this.host.store.transact((s) => {
            const t = s.records.tasks[task.id].value;
            if (t.status !== "verifying")
                throw new Error("verification-state-changed");
            t.evidenceRefs.push(...results.map((g) => g.evidenceRef));
            transition(t, accepted
                ? "accepted"
                : t.attempt <
                    Math.min(t.budget.maxAttempts, this.host.config.maxAttempts, this.host.config.maxRepairAttempts + 1)
                    ? "retrying"
                    : "failed");
            put(s, "tasks", t.id, t);
            if (t.status === "failed") {
                const tasks = Object.values(s.records.tasks ?? {})
                    .map((row) => row.value)
                    .filter((task) => task.runId === run.id);
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const dependent of tasks)
                        if (dependent.status === "pending" &&
                            dependent.dependencies.some((dependency) => tasks.some((value) => value.id === dependency &&
                                ["failed", "blocked"].includes(value.status)))) {
                            transition(dependent, "blocked");
                            dependent.blocker = "dependency-failed:" + t.id;
                            put(s, "tasks", dependent.id, dependent);
                            changed = true;
                        }
                }
                const r = s.records.runs[run.id].value;
                r.status = "blocked";
                r.requiredBlockers = tasks.filter((task) => task.required && ["failed", "blocked"].includes(task.status)).length;
                put(s, "runs", r.id, r);
            }
            checkpoint(s, run.id, t.id, "after-verification");
            if (accepted)
                checkpoint(s, run.id, t.id, "task-end");
        });
        if (accepted) {
            this.host.interop.emit("pi.task.updated.v1", {
                taskId: task.id,
                status: "accepted",
                evidenceRefs: results.map((result) => result.evidenceRef),
            }, { taskId: task.id, runId: run.id, correlationId: run.id });
            await this.advance();
            await this.finalize(signal);
        }
        return { status: accepted ? "accepted" : "failed", results };
    }
    async finalize(signal) {
        const run = await this.currentRun();
        if (!run ||
            !(await this.tasks(run.id))
                .filter((t) => t.required)
                .every((t) => t.status === "accepted"))
            return [];
        if (!(await this.acceptanceGate.ready(run.id)))
            return [];
        if ((run.finalAttempts ?? 0) >= this.host.config.maxRepairAttempts + 1)
            throw new Error("manual-review-required");
        run.finalAttempts = (run.finalAttempts ?? 0) + 1;
        await this.host.store.putRecord("runs", run.id, run);
        const verifier = await this.verifier();
        const gates = [];
        for (const req of run.finalAcceptance)
            gates.push(await verifier.verify(req, selectProfile(assess(run.goal).risks), signal, { runId: run.id, scopeId: run.id + "-final" }));
        await this.host.store.transact((s) => {
            const r = s.records.runs[run.id].value;
            r.finalGate = completionAllowed(r.finalAcceptance, gates)
                ? "passed"
                : "failed";
            const tasks = Object.values(s.records.tasks ?? {})
                .map((v) => v.value)
                .filter((t) => t.runId === r.id);
            r.requiredBlockers = tasks.filter((t) => t.required && t.status === "blocked").length;
            if (canCompleteRun(r, tasks))
                r.status = "completed";
            r.updatedAt = now();
            put(s, "runs", r.id, r);
            checkpoint(s, r.id, undefined, "run-final-gate");
        });
        if (gates.some((gate) => gate.reason?.startsWith("needs-gate-side-effect-review"))) {
            const latest = await this.currentRun();
            if (latest) {
                latest.status = "blocked";
                latest.requiredBlockers = Math.max(1, latest.requiredBlockers);
                await this.host.store.putRecord("runs", latest.id, latest);
            }
        }
        return gates;
    }
    async block(taskId, reason) {
        await this.host.store.transact((s) => {
            const task = s.records.tasks?.[taskId]?.value;
            if (!task)
                return;
            if (task.status === "blocked" && task.blocker === reason)
                return;
            if (task.status !== "blocked")
                transition(task, "blocked");
            task.blocker = reason;
            put(s, "tasks", task.id, task);
            const run = s.records.runs[task.runId].value;
            run.status = "blocked";
            run.requiredBlockers = Object.values(s.records.tasks ?? {})
                .map((row) => row.value)
                .filter((value) => value.runId === run.id &&
                value.required &&
                value.status === "blocked").length;
            put(s, "runs", run.id, run);
            checkpoint(s, run.id, task.id, "blocked");
        });
    }
    async recover() {
        const recovery = await this.host.store.recover();
        const run = await this.currentRun();
        if (!run || ["completed", "cancelled"].includes(run.status))
            return recovery;
        const intents = (await this.host.store.listRecords("intents")).filter((i) => i.runId === run.id && !i.settled);
        for (const intent of intents)
            if (intent.replay === "never-automatic" ||
                (intent.replay === "idempotent-with-key" && !intent.idempotencyKey)) {
                await this.block(intent.taskId, "needs-side-effect-review:" + intent.id);
            }
        const gateIntents = (await this.host.store.listRecords("gate-intents")).filter((intent) => intent.runId === run.id && !intent.settled && intent.replay !== "safe");
        for (const intent of gateIntents) {
            if (intent.taskId)
                await this.block(intent.taskId, "needs-gate-side-effect-review:" + intent.id);
            else {
                run.status = "blocked";
                run.finalGate = "failed";
                run.requiredBlockers = Math.max(1, run.requiredBlockers);
                await this.host.store.putRecord("runs", run.id, run);
            }
        }
        return {
            ...recovery,
            unsafeIntents: intents
                .filter((i) => i.replay !== "safe")
                .map((i) => i.id),
            safeReplay: intents.filter((i) => i.replay === "safe").map((i) => i.id),
            unsafeGateIntents: gateIntents.map((intent) => intent.id),
        };
    }
    async handoff() {
        const run = await this.currentRun();
        if (!run)
            return null;
        const tasks = await this.tasks(run.id);
        const evidence = [];
        for (const t of tasks.filter((t) => t.status === "accepted"))
            for (const ref of t.evidenceRefs.slice(-3)) {
                const e = await this.host.store.getRecord("evidence", ref);
                if (e)
                    evidence.push(e);
            }
        return {
            schemaVersion: 1,
            runId: run.id,
            brief: bound(JSON.stringify({
                goal: bound(run.goal, 250),
                accomplished: tasks
                    .filter((t) => t.status === "accepted")
                    .map((t) => t.title),
                remaining: tasks
                    .filter((t) => t.status !== "accepted")
                    .map((t) => ({
                    id: t.id,
                    objective: bound(t.objective, 80),
                    status: t.status,
                    blocker: t.blocker,
                })),
                evidence: bound(JSON.stringify(evidence), this.host.config.maxEvidenceTokens),
            }), this.host.config.maxHandoffTokens),
        };
    }
    async prompt(_prompt, ctx) {
        const task = await this.currentTask();
        if (!task)
            return undefined;
        const usage = ctx.getContextUsage();
        const ratio = usage?.percent !== null && usage?.percent !== undefined
            ? usage.percent / 100
            : 0;
        if (ratio >= this.host.config.compactAtRatio && !this.contextCompacted) {
            ctx.compact({ customInstructions: JSON.stringify(await this.handoff()) });
            this.contextCompacted = true;
        }
        if (ratio < this.host.config.targetRatio)
            this.contextCompacted = false;
        await this.host.store.putRecord("context-metrics", id(), {
            ratio,
            createdAt: now(),
        });
        return {
            task: this.brief(task),
            workState: await this.handoff(),
            instruction: "Completion requires verified acceptance; assistant claims do not satisfy gates.",
        };
    }
    brief(task) {
        return {
            id: task.id,
            runId: task.runId,
            status: task.status,
            attempt: task.attempt,
            objective: bound(task.objective, 350),
            constraints: task.constraints
                .slice(0, 8)
                .map((value) => bound(value, 40)),
            acceptance: task.acceptance.slice(0, 12).map((requirement) => ({
                id: requirement.id,
                kind: requirement.kind,
                required: requirement.required,
            })),
            scope: {
                readOnly: task.scope.readOnly,
                paths: task.scope.paths?.slice(0, 12),
                capabilities: task.scope.capabilities?.slice(0, 12),
            },
        };
    }
    async evidence(ref) {
        const run = await this.currentRun();
        if (!run)
            throw new Error("no-run");
        const tasks = await this.tasks(run.id);
        const observation = await this.host.store.getRecord("tool-observations", ref);
        if (!tasks.some((task) => task.evidenceRefs.includes(ref) ||
            task.artifactRefs.includes(ref) ||
            task.id === observation?.taskId))
            throw new Error("evidence-outside-current-run");
        const bytes = await this.host.store.readBlob(ref);
        return bytes
            ? {
                id: ref,
                output: bound(Buffer.from(bytes).toString("utf8"), this.host.config.maxEvidenceTokens),
            }
            : null;
    }
    async toolCall(raw) {
        const e = {
            ...raw,
        };
        const metadata = WORK_STATE_TOOLS.includes(e.toolName);
        e.toolCallId = digest(e.toolCallId);
        const run = await this.currentRun();
        if (run &&
            ![
                "read",
                "grep",
                "find",
                "ls",
                "gate_check",
                ...WORK_STATE_TOOLS,
            ].includes(e.toolName))
            await this.acceptanceGate.invalidate(run.id);
        if (e.toolName === "longrun_tasks" && run) {
            const allowed = await this.host.store.transact((snapshot) => {
                const record = snapshot.records.runs[run.id].value;
                const limit = Math.min(this.host.config.maxToolCalls, (record.maxReplans ?? this.host.config.maxReplans) + 1);
                if ((record.ledgerCalls ?? 0) >= limit)
                    return false;
                record.ledgerCalls = (record.ledgerCalls ?? 0) + 1;
                put(snapshot, "runs", record.id, record);
                return true;
            });
            return allowed
                ? undefined
                : { block: true, reason: "ledger-definition-limit" };
        }
        if (run?.status === "blocked" &&
            !["read", "grep", "find", "ls"].includes(e.toolName) &&
            !metadata)
            return {
                block: true,
                reason: "longrun-recovery-review-required",
            };
        const task = await this.currentTask();
        if (!task)
            return undefined;
        const readTools = ["read", "grep", "find", "ls"];
        if (task.scope.readOnly && !readTools.includes(e.toolName) && !metadata)
            return { block: true, reason: "task-read-only" };
        if (task.scope.paths?.length && !metadata) {
            if (![...readTools, "edit", "write"].includes(e.toolName))
                return { block: true, reason: "task-path-scope-unverifiable" };
            if (!e.input?.path)
                return { block: true, reason: "task-path-required" };
            try {
                const cwd = run?.cwd ?? this.host.cwd;
                const path = await contained(cwd, e.input.path, e.toolName === "write");
                let allowed = false;
                for (const scope of task.scope.paths) {
                    const base = await contained(cwd, scope, true);
                    const rel = relative(base, path);
                    if (!isAbsolute(rel) &&
                        rel !== ".." &&
                        !rel.startsWith("..\\") &&
                        !rel.startsWith("../"))
                        allowed = true;
                }
                if (!allowed)
                    return { block: true, reason: "task-path-outside-scope" };
            }
            catch {
                return { block: true, reason: "task-path-outside-scope" };
            }
        }
        if (task.toolCalls >= task.budget.maxToolCalls ||
            (run?.maxCostUsd !== null && run && run.spentUsd >= run.maxCostUsd)) {
            await this.block(task.id, "budget-exhausted");
            return { block: true, reason: "longrun-budget-exhausted" };
        }
        await this.host.store.transact((s) => {
            if (s.records.intents?.[e.toolCallId])
                throw new Error("duplicate-tool-intent");
            const t = s.records.tasks[task.id].value;
            t.toolCalls++;
            put(s, "tasks", t.id, t);
            const intent = {
                id: e.toolCallId,
                toolName: e.toolName,
                taskId: t.id,
                runId: t.runId,
                replay: metadata || ["read", "grep", "find", "ls"].includes(e.toolName)
                    ? "safe"
                    : "never-automatic",
                settled: false,
                createdAt: now(),
            };
            put(s, "intents", e.toolCallId, intent);
            checkpoint(s, t.runId, t.id, "before-tool");
        });
        return undefined;
    }
    async toolResult(raw) {
        const e = raw;
        const intent = await this.host.store.getRecord("intents", digest(e.toolCallId));
        if (!intent)
            return;
        const blob = await this.host.store.writeBlob(id(), Buffer.from(bound(JSON.stringify(e.content), this.host.config.maxEvidenceTokens)));
        await this.host.store.transact((s) => {
            const i = s.records.intents[intent.id].value;
            i.settled = !e.isError || i.replay === "safe";
            i.isError = e.isError;
            put(s, "intents", i.id, i);
            put(s, "tool-observations", blob.id, {
                ...blob,
                toolCallId: i.id,
                taskId: i.taskId,
                isError: e.isError,
                verified: false,
            });
            const run = s.records.runs[i.runId].value;
            const cost = e.usage?.cost?.total;
            if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
                run.spentUsd += cost;
            put(s, "runs", run.id, run);
            checkpoint(s, run.id, i.taskId, "after-side-effect");
        });
        if (e.isError && intent.replay !== "safe")
            await this.block(intent.taskId, "needs-side-effect-review:" + intent.id);
    }
    async messageEnd(raw) {
        const e = raw;
        if (e.message.role !== "assistant")
            return;
        const cost = e.message.usage?.cost?.total;
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
            return;
        const run = await this.currentRun();
        if (!run || run.status !== "active")
            return;
        await this.host.store.transact((s) => {
            const r = s.records.runs[run.id].value;
            r.spentUsd += cost;
            put(s, "runs", r.id, r);
        });
    }
    async settle(raw, ctx) {
        const e = raw;
        const run = await this.currentRun();
        if (!run || run.status !== "active" || e.outcome !== "completed")
            return undefined;
        // The bound acceptance-gate owns pending-check continuations. Never run a
        // second repair loop or accept its summary as local verification evidence.
        if (!(await this.acceptanceGate.ready(run.id)))
            return undefined;
        const verdict = await this.verify();
        const updated = await this.currentRun();
        if (updated?.status === "completed")
            return undefined;
        let current = await this.currentTask();
        if (!current ||
            current.status === "failed" ||
            run.autoContinuations >= this.host.config.maxAutomaticTurns ||
            e.context?.canContinue === false)
            return undefined;
        if (current.status === "retrying") {
            await this.host.store.transact((s) => {
                const task = s.records.tasks[current.id].value;
                if (task.status !== "retrying")
                    throw new Error("retry-state-changed");
                transition(task, "running");
                task.attempt++;
                put(s, "tasks", task.id, task);
                checkpoint(s, task.runId, task.id, "retry-start");
            });
            current = await this.currentTask();
        }
        await this.host.store.transact((s) => {
            const r = s.records.runs[run.id].value;
            r.autoContinuations++;
            put(s, "runs", r.id, r);
        });
        const usage = ctx?.getContextUsage();
        if (usage?.percent !== null &&
            usage?.percent !== undefined &&
            usage.percent / 100 >= this.host.config.handoffAtRatio) {
            const handoff = await this.handoff();
            if (handoff)
                return {
                    continue: true,
                    entries: [
                        {
                            type: "compaction",
                            summary: handoff.brief,
                            firstKeptEntryId: null,
                        },
                    ],
                };
        }
        return {
            continue: true,
            entries: [
                {
                    type: "custom_message",
                    customType: "longrun-continuation",
                    display: false,
                    content: bound(JSON.stringify({
                        task: current ? this.brief(current) : null,
                        verdict: {
                            status: verdict.status,
                            results: verdict.results.map((result) => ({
                                requirementId: result.requirementId,
                                verified: result.verified,
                                reason: result.reason,
                                evidenceRef: result.evidenceRef,
                            })),
                        },
                        handoff: await this.handoff(),
                    }), this.host.config.maxHandoffTokens),
                },
            ],
        };
    }
    async command(action, args, context) {
        if (action === "gate" &&
            ["bind", "unbind", "integration"].includes(args[0] ?? "")) {
            const current = await this.currentRun();
            if (args[0] === "integration")
                return this.acceptanceGate.status(current?.id);
            if (!current || !["active", "blocked"].includes(current.status))
                throw new Error("active-run-required");
            if (args[0] === "unbind")
                return this.acceptanceGate.unbind(current.id);
            if (!args[1])
                throw new Error("acceptance-gate-task-id-required");
            return this.acceptanceGate.bind(current.id, args[1]);
        }
        if (action === "gate")
            return this.gates.command(args[0] ?? "status", args.slice(1), context);
        const run = await this.currentRun();
        if (action === "start")
            return this.startRun(args.join(" "));
        if (action === "revise") {
            if (!run || !args[0])
                throw new Error("run-and-task-file-required");
            const input = JSON.parse(await readFile(await contained(context.cwd, args[0]), "utf8"));
            const evidence = {
                schemaVersion: 1,
                id: id(),
                runId: run.id,
                revision: run.ledgerRevision ?? 0,
                kind: "user-constraint",
                evidenceRef: "user-" + id(),
                verified: true,
                consumed: false,
                createdAt: now(),
            };
            await this.host.store.putRecord("ledger-evidence", evidence.id, evidence);
            return this.replaceTasks(input.tasks, { evidenceId: evidence.id });
        }
        if (action === "status")
            return {
                run,
                tasks: run ? await this.tasks(run.id) : [],
                acceptanceGate: await this.acceptanceGate.status(run?.id),
            };
        if (action === "tasks")
            return run ? this.tasks(run.id) : [];
        if (action === "inspect")
            return args[0]
                ? this.host.store.getRecord("tasks", args[0])
                : this.handoff();
        if (action === "explain")
            return {
                invariant: "required task evidence + final gates + zero blockers",
                run,
                limits: {
                    attempts: this.host.config.maxAttempts,
                    continuations: this.host.config.maxAutomaticTurns,
                },
            };
        if (action === "verify")
            return this.verify(context.signal);
        if (action === "recover")
            return this.recover();
        if (action === "approve-command") {
            if (!args[0])
                throw new Error("command-policy-json-required");
            const input = JSON.parse(await readFile(await contained(context.cwd, args[0]), "utf8"));
            if (typeof input.executable !== "string" ||
                !Array.isArray(input.args) ||
                input.args.some((x) => typeof x !== "string"))
                throw new Error("invalid-command-policy");
            if (input.replay !== undefined &&
                !["safe", "never-automatic"].includes(input.replay))
                throw new Error("invalid-replay-policy");
            const policy = await this.policy();
            policy.approvedCommands.push(input);
            await this.host.store.putRecord("policy", "gates", policy);
            return { approved: input };
        }
        if (action === "approve-human") {
            if (!args[0])
                throw new Error("requirement-id-required");
            const policy = await this.policy();
            if (!run)
                throw new Error("no-run");
            policy.approvedHumans.push(run.id + ":" + args[0]);
            await this.host.store.putRecord("policy", "gates", policy);
            return { approved: args[0] };
        }
        if (action === "resolve") {
            const tool = args[0]
                ? await this.host.store.getRecord("intents", args[0])
                : null;
            const gate = args[0] && !tool
                ? await this.host.store.getRecord("gate-intents", args[0])
                : null;
            const intent = tool ?? gate;
            if (!intent)
                throw new Error("intent-required");
            if (!run || intent.runId !== run.id)
                throw new Error("intent-outside-current-run");
            intent.settled = true;
            await this.host.store.putRecord(tool ? "intents" : "gate-intents", intent.id, intent);
            await this.host.store.transact((s) => {
                const pending = [
                    ...Object.values(s.records.intents ?? {}),
                    ...Object.values(s.records["gate-intents"] ?? {}),
                ]
                    .map((record) => record.value)
                    .some((value) => value.runId === intent.runId &&
                    !value.settled &&
                    value.replay !== "safe");
                const t = intent.taskId
                    ? s.records.tasks[intent.taskId].value
                    : undefined;
                if (!pending && t?.status === "blocked") {
                    transition(t, "ready");
                    delete t.blocker;
                    put(s, "tasks", t.id, t);
                }
                if (!intent.runId)
                    throw new Error("run-intent-required");
                const r = s.records.runs[intent.runId].value;
                r.requiredBlockers = Object.values(s.records.tasks ?? {})
                    .map((record) => record.value)
                    .filter((task) => task.runId === r.id && task.required && task.status === "blocked").length;
                r.status = !pending && r.requiredBlockers === 0 ? "active" : "blocked";
                put(s, "runs", r.id, r);
            });
            return { reviewed: args[0], next: await this.advance() };
        }
        if (!run)
            throw new Error("no-run");
        if (action === "pause" || action === "resume" || action === "stop") {
            if (action === "resume" && run.status === "blocked") {
                const tasks = await this.tasks(run.id);
                const blocked = tasks.filter((task) => task.status === "blocked");
                if (!blocked.length ||
                    blocked.some((task) => !["command-not-approved", "human-approval-required"].includes(task.blocker ?? "")))
                    throw new Error("resolve-blocker-before-resume");
                await this.host.store.transact((snapshot) => {
                    for (const task of blocked) {
                        transition(task, "ready");
                        delete task.blocker;
                        put(snapshot, "tasks", task.id, task);
                    }
                });
                run.requiredBlockers = 0;
            }
            run.status =
                action === "pause"
                    ? "paused"
                    : action === "stop"
                        ? "cancelled"
                        : "active";
            await this.host.store.putRecord("runs", run.id, run);
            if (action === "resume")
                await this.advance();
            if (action === "resume" && args.includes("--fresh")) {
                if (!context.commandContext)
                    throw new Error("fresh-session-requires-pi-command-context");
                const handoff = await this.handoff();
                return context.commandContext.newSession({
                    setup: async (manager) => {
                        manager.appendCustomMessageEntry("longrun-handoff", handoff?.brief ?? "", false);
                    },
                });
            }
            return run;
        }
        throw new Error("unknown-command:" + action);
    }
}
export const createService = (host) => new Longrun(host);
