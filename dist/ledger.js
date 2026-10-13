import { put, append } from "./common/storage.js";
import { digest, id, now, safeId } from "./common/security.js";
export const WORK_STATE_TOOLS = [
    "longrun_status",
    "longrun_evidence",
    "autoplan_update",
    "autoskills_select",
    "mcprouter_select",
];
export function validateLedgerTasks(tasks, limit) {
    if (!Array.isArray(tasks) ||
        !tasks.length ||
        tasks.length > limit ||
        new Set(tasks.map((task) => task.id)).size !== tasks.length)
        throw new Error("invalid-task-count-or-id");
    const graph = new Map(tasks.map((task) => [task.id, task]));
    const visited = new Set(), active = new Set();
    const visit = (key) => {
        if (visited.has(key))
            return;
        if (active.has(key))
            throw new Error("dependency-cycle");
        const task = graph.get(key);
        if (!task)
            throw new Error("missing-dependency");
        active.add(key);
        for (const dep of task.dependencies)
            visit(dep);
        active.delete(key);
        visited.add(key);
    };
    for (const task of tasks) {
        safeId(task.id);
        if (!task.objective?.trim() ||
            !Array.isArray(task.dependencies) ||
            !Array.isArray(task.acceptance) ||
            !task.acceptance.some((requirement) => requirement.required))
            throw new Error("required-acceptance-missing");
        if (new Set(task.acceptance.map((requirement) => requirement.id)).size !==
            task.acceptance.length)
            throw new Error("duplicate-acceptance-id");
        visit(task.id);
    }
}
function definitionHash(task) {
    return digest({
        id: task.id,
        objective: task.objective,
        dependencies: [...task.dependencies].sort(),
        acceptance: [...task.acceptance].sort((a, b) => a.id.localeCompare(b.id)),
        constraints: task.constraints ?? [],
        scope: task.scope ?? {},
        required: task.required !== false,
    });
}
export async function reviseLedger(host, inputs, options = {}) {
    await host.store.transact((snapshot) => {
        const ref = snapshot.records.current?.run?.value;
        const run = ref
            ? snapshot.records.runs?.[ref.id]?.value
            : undefined;
        if (!run || !["active", "blocked"].includes(run.status))
            throw new Error("no-active-run");
        if (run.maxCostUsd !== null && run.spentUsd >= run.maxCostUsd)
            throw new Error("budget-exhausted");
        const existing = Object.values(snapshot.records.tasks ?? {})
            .map((row) => row.value)
            .filter((task) => task.runId === run.id);
        const pending = [
            ...Object.values(snapshot.records.intents ?? {}),
            ...Object.values(snapshot.records["gate-intents"] ?? {}),
        ]
            .map((row) => row.value)
            .filter((intent) => intent.runId === run.id &&
            !intent.settled &&
            !WORK_STATE_TOOLS.includes(intent.toolName ?? ""));
        if (pending.length)
            throw new Error("pending-effect-before-replan");
        const execution = existing.some((task) => task.status === "accepted") ||
            Object.values(snapshot.records.intents ?? {}).some((row) => {
                const intent = row.value;
                return (intent.runId === run.id && !WORK_STATE_TOOLS.includes(intent.toolName));
            });
        const accepted = existing.filter((task) => task.status === "accepted");
        const combined = [...inputs];
        for (const task of accepted)
            if (!combined.some((input) => input.id === task.id))
                combined.push(task);
        for (const input of combined) {
            const prior = snapshot.records.tasks?.[input.id]?.value;
            if ((prior && prior.runId !== run.id) ||
                snapshot.records["retired-tasks"]?.[input.id])
                throw new Error("task-id-already-used");
        }
        const limit = options.bootstrap || (!run.structuredLedger && !execution)
            ? host.config.maxInitialTasks
            : host.config.maxOpenTasks + accepted.length;
        validateLedgerTasks(combined, limit);
        if (combined.filter((task) => !accepted.some((value) => value.id === task.id))
            .length > host.config.maxOpenTasks)
            throw new Error("open-task-limit");
        for (const task of accepted) {
            const next = combined.find((value) => value.id === task.id);
            if (definitionHash(next) !== definitionHash(task))
                throw new Error("accepted-task-immutable");
        }
        const replan = !options.bootstrap && (run.structuredLedger === true || execution);
        let proof;
        if (replan) {
            proof = options.evidenceId
                ? snapshot.records["ledger-evidence"]?.[options.evidenceId]
                    ?.value
                : undefined;
            if (!proof ||
                proof.schemaVersion !== 1 ||
                proof.runId !== run.id ||
                proof.revision !== (run.ledgerRevision ?? 0) ||
                proof.consumed ||
                proof.verified !== true)
                throw new Error("material-ledger-evidence-required");
            if ((run.replans ?? 0) >=
                Math.min(run.maxReplans ?? host.config.maxReplans, host.config.maxReplans))
                throw new Error("ledger-replan-limit");
        }
        const revision = options.bootstrap ? 0 : (run.ledgerRevision ?? 0) + 1;
        for (const task of existing) {
            const next = combined.find((input) => input.id === task.id);
            if (next &&
                definitionHash(next) !== definitionHash(task) &&
                !options.bootstrap &&
                execution)
                throw new Error("executed-task-id-immutable-use-new-id");
            if (next && ["failed", "cancelled"].includes(task.status))
                throw new Error("terminal-task-id-reuse");
            if (!next) {
                put(snapshot, "retired-tasks", task.id, {
                    ...task,
                    retiredAt: now(),
                    ledgerRevision: revision,
                });
                delete snapshot.records.tasks[task.id];
            }
        }
        for (const input of combined) {
            const prior = existing.find((task) => task.id === input.id);
            if (prior && definitionHash(prior) === definitionHash(input))
                continue;
            const task = {
                schemaVersion: 1,
                id: input.id,
                runId: run.id,
                title: input.objective.slice(0, 80),
                objective: input.objective,
                status: "pending",
                required: input.required !== false,
                dependencies: input.dependencies,
                constraints: input.constraints ?? [],
                scope: input.scope ?? {},
                acceptance: input.acceptance,
                budget: prior?.budget ?? {
                    maxAttempts: host.config.maxAttempts,
                    maxToolCalls: host.config.maxToolCalls,
                    maxCostUsd: host.config.maxCostUsd,
                },
                attempt: prior?.attempt ?? 0,
                toolCalls: prior?.toolCalls ?? 0,
                evidenceRefs: prior?.evidenceRefs ?? [],
                artifactRefs: prior?.artifactRefs ?? [],
                createdAt: prior?.createdAt ?? now(),
                updatedAt: now(),
            };
            put(snapshot, "tasks", task.id, task);
        }
        if (proof) {
            proof.consumed = true;
            put(snapshot, "ledger-evidence", proof.id, proof);
            run.replans = (run.replans ?? 0) + 1;
        }
        run.ledgerRevision = revision;
        if (!options.bootstrap)
            run.structuredLedger = true;
        const tasks = Object.values(snapshot.records.tasks ?? {})
            .map((row) => row.value)
            .filter((task) => task.runId === run.id);
        run.requiredBlockers = tasks.filter((task) => task.required && ["blocked", "failed"].includes(task.status)).length;
        run.status = run.requiredBlockers ? "blocked" : "active";
        run.finalGate = "pending";
        run.updatedAt = now();
        put(snapshot, "runs", run.id, run);
        const record = {
            schemaVersion: 1,
            id: run.id + "-" + revision,
            runId: run.id,
            revision,
            replans: run.replans ?? 0,
            taskIds: tasks.map((task) => task.id),
            evidenceId: proof?.id,
            createdAt: now(),
        };
        put(snapshot, "ledger-revisions", record.id, record);
        append(snapshot, {
            schemaVersion: 1,
            eventId: id(),
            eventType: "ledger.revised",
            emittedAt: now(),
            payload: record,
        });
        put(snapshot, "checkpoints", record.id, {
            schemaVersion: 1,
            id: record.id,
            runId: run.id,
            phase: "ledger-revision",
            sequence: Object.keys(snapshot.records.checkpoints ?? {}).length + 1,
            createdAt: now(),
        });
    });
}
