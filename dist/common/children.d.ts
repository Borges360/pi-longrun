import type { Config } from "./config.js";
import { type StorageBase } from "./storage.js";
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
    finish(request: ChildRequest, path: string, result: ChildResult): Promise<void>;
    remove(path: string): Promise<void>;
}
export type ChildRunner = (request: ChildRequest, config: Config, signal?: AbortSignal) => Promise<ChildResult>;
export declare function delegation(owner: string, objective: string, agents: AgentDefinition[], config: Config, taskId: string, options: {
    cwd: string;
    depth?: number;
    ancestors?: string[];
    independent?: boolean;
    review?: boolean;
    contextChars?: number;
    write?: boolean;
    tightlyCoupled?: boolean;
}): DelegationDecision;
export declare function processRunner(request: ChildRequest, config: Config, signal?: AbortSignal): Promise<ChildResult>;
export declare class ChildDispatcher {
    readonly store: StorageBase;
    readonly config: Config;
    readonly runner: ChildRunner;
    readonly worktrees?: WorktreeAdapter | undefined;
    private active;
    private controllers;
    constructor(store: StorageBase, config: Config, runner?: ChildRunner, worktrees?: WorktreeAdapter | undefined);
    dispatch(request: ChildRequest, signal?: AbortSignal): Promise<ChildResult>;
    close(): void;
}
