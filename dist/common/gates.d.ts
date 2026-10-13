import { type StorageBase } from "./storage.js";
export type GateProfile = "none" | "fast" | "standard" | "strict";
export interface AcceptanceRequirement {
    id: string;
    kind: "command" | "artifact" | "human";
    required: boolean;
    executable?: string;
    args?: string[];
    path?: string;
    sha256?: string;
    timeoutMs?: number;
    report?: {
        format: "junit" | "json";
        path: string;
    };
}
export interface GateResult {
    schemaVersion: 1;
    id: string;
    requirementId: string;
    profile: GateProfile;
    evaluated: boolean;
    verified: boolean;
    rejected: boolean;
    exitCode?: number;
    durationMs: number;
    evidenceRef?: string;
    outputDigest?: string;
    reason?: string;
    taskId?: string;
    attempt?: number;
}
export interface GatePolicy {
    approvedCommands: Array<{
        executable: string;
        args: string[];
        replay?: "safe" | "never-automatic";
    }>;
    approvedHumans: string[];
    timeoutMs: number;
    maxOutputBytes: number;
}
export interface CapturedCommand {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated?: boolean;
}
export interface GateIntent {
    id: string;
    requirementId: string;
    runId?: string;
    taskId?: string;
    attempt?: number;
    scopeId: string;
    settled: boolean;
    replay: "safe" | "never-automatic";
    createdAt: string;
}
export interface GateContext {
    runId?: string;
    taskId?: string;
    attempt?: number;
    scopeId?: string;
}
export declare function testReportPassed(text: string, format: "junit" | "json"): boolean;
export declare function runCommand(executable: string, args: string[], options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
}): Promise<CapturedCommand>;
export declare function selectProfile(risks: string[], hasSideEffects?: boolean, small?: boolean): GateProfile;
export declare function completionAllowed(requirements: AcceptanceRequirement[], results: GateResult[]): boolean;
export declare class GateVerifier {
    readonly store: StorageBase;
    readonly cwd: string;
    readonly policy: GatePolicy;
    constructor(store: StorageBase, cwd: string, policy: GatePolicy);
    verify(requirement: AcceptanceRequirement, profile: GateProfile, signal?: AbortSignal, context?: GateContext): Promise<GateResult>;
}
