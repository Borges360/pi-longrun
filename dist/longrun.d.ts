import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Host, Service, CommandContext } from "./common/runtime.js";
import { GateVerifier, type AcceptanceRequirement, type GateResult, type GatePolicy } from "./common/gates.js";
import { LocalGate } from "./gate.js";
import { AcceptanceGateBridge } from "./acceptance-bridge.js";
import { type TaskDefinition } from "./ledger.js";
export type TaskStatus = "pending" | "ready" | "running" | "verifying" | "retrying" | "blocked" | "accepted" | "failed" | "cancelled";
export interface LongrunTask {
    schemaVersion: 1;
    id: string;
    runId: string;
    title: string;
    objective: string;
    status: TaskStatus;
    required: boolean;
    dependencies: string[];
    constraints: string[];
    scope: {
        paths?: string[];
        readOnly?: boolean;
        capabilities?: string[];
    };
    acceptance: AcceptanceRequirement[];
    budget: {
        maxAttempts: number;
        maxToolCalls: number;
        maxCostUsd: number | null;
    };
    attempt: number;
    toolCalls: number;
    evidenceRefs: string[];
    artifactRefs: string[];
    createdAt: string;
    updatedAt: string;
    blocker?: string;
}
export interface RunRecord {
    schemaVersion: 1;
    id: string;
    goal: string;
    cwd?: string;
    status: "active" | "paused" | "blocked" | "completed" | "cancelled";
    autoContinuations: number;
    spentUsd: number;
    maxCostUsd: number | null;
    requiredBlockers: number;
    finalGate: "pending" | "passed" | "failed";
    finalAcceptance: AcceptanceRequirement[];
    finalAttempts?: number;
    ledgerRevision?: number;
    structuredLedger?: boolean;
    replans?: number;
    maxReplans?: number;
    ledgerCalls?: number;
    createdAt: string;
    updatedAt: string;
}
export interface CheckpointRecord {
    schemaVersion: 1;
    id: string;
    runId: string;
    taskId?: string;
    phase: string;
    sequence: number;
    createdAt: string;
}
export interface SideEffectPolicy {
    replay: "safe" | "idempotent-with-key" | "never-automatic";
    idempotencyKey?: string;
}
export interface ToolIntent extends SideEffectPolicy {
    id: string;
    runId: string;
    taskId: string;
    toolName: string;
    settled: boolean;
    isError?: boolean;
    createdAt: string;
}
export declare function transition(task: LongrunTask, next: TaskStatus): void;
export declare function canCompleteRun(run: RunRecord, tasks: LongrunTask[]): boolean;
export declare function validateTasks(tasks: Array<{
    id: string;
    dependencies: string[];
    acceptance: AcceptanceRequirement[];
    objective?: string;
}>, limit: number): void;
export declare class Longrun implements Service {
    readonly host: Host;
    menuGroups: {
        Execução: string[];
        Progresso: string[];
        Recuperação: string[];
        Configurações: string[];
    };
    menuInputs: {
        start: string;
    };
    capabilities: string[];
    menu: string[];
    private contextCompacted;
    readonly gates: LocalGate;
    readonly acceptanceGate: AcceptanceGateBridge;
    constructor(host: Host);
    close(): Promise<void>;
    start(): Promise<void>;
    ingestPlan(raw: unknown): Promise<void>;
    currentRun(): Promise<RunRecord | null>;
    tasks(runId?: string): Promise<LongrunTask[]>;
    currentTask(): Promise<LongrunTask | null>;
    startRun(goal: string, requirements?: AcceptanceRequirement[]): Promise<RunRecord>;
    replaceTasks(inputs: TaskDefinition[], options?: {
        bootstrap?: boolean;
        evidenceId?: string;
    }): Promise<LongrunTask[]>;
    advance(): Promise<LongrunTask | null>;
    policy(): Promise<GatePolicy>;
    verifier(): Promise<GateVerifier>;
    verify(signal?: AbortSignal): Promise<{
        status: string;
        results: GateResult[];
    }>;
    private finalize;
    block(taskId: string, reason: string): Promise<void>;
    recover(): Promise<import("./common/storage.js").RecoveryReport | {
        unsafeIntents: string[];
        safeReplay: string[];
        unsafeGateIntents: string[];
        ok: boolean;
        recoveredCommits: number;
        repairedTail: boolean;
        revision: number;
    }>;
    handoff(): Promise<{
        schemaVersion: number;
        runId: string;
        brief: string;
    } | null>;
    prompt(_prompt: string, ctx: ExtensionContext): Promise<{
        task: {
            id: string;
            runId: string;
            status: TaskStatus;
            attempt: number;
            objective: string;
            constraints: string[];
            acceptance: {
                id: string;
                kind: "command" | "artifact" | "human";
                required: boolean;
            }[];
            scope: {
                readOnly: boolean | undefined;
                paths: string[] | undefined;
                capabilities: string[] | undefined;
            };
        };
        workState: {
            schemaVersion: number;
            runId: string;
            brief: string;
        } | null;
        instruction: string;
    } | undefined>;
    brief(task: LongrunTask): {
        id: string;
        runId: string;
        status: TaskStatus;
        attempt: number;
        objective: string;
        constraints: string[];
        acceptance: {
            id: string;
            kind: "command" | "artifact" | "human";
            required: boolean;
        }[];
        scope: {
            readOnly: boolean | undefined;
            paths: string[] | undefined;
            capabilities: string[] | undefined;
        };
    };
    evidence(ref: string): Promise<{
        id: string;
        output: string;
    } | null>;
    toolCall(raw: unknown): Promise<{
        block: true;
        reason: string;
    } | undefined>;
    toolResult(raw: unknown): Promise<void>;
    messageEnd(raw: unknown): Promise<void>;
    settle(raw: unknown, ctx?: ExtensionContext): Promise<{
        continue: boolean;
        entries: {
            type: string;
            summary: string;
            firstKeptEntryId: null;
        }[];
    } | {
        continue: boolean;
        entries: {
            type: string;
            customType: string;
            display: boolean;
            content: string;
        }[];
    } | undefined>;
    command(action: string, args: string[], context: CommandContext): Promise<unknown>;
}
export declare const createService: (host: Host) => Longrun;
