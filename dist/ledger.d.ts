import type { Host } from "./common/runtime.js";
import type { AcceptanceRequirement } from "./common/gates.js";
import type { LongrunTask } from "./longrun.js";
export interface TaskDefinition {
    id: string;
    objective: string;
    dependencies: string[];
    acceptance: AcceptanceRequirement[];
    constraints?: string[];
    scope?: LongrunTask["scope"];
    required?: boolean;
}
export declare const WORK_STATE_TOOLS: string[];
export interface LedgerEvidence {
    schemaVersion: 1;
    id: string;
    runId: string;
    revision: number;
    kind: "verified-gate-failure" | "dependency-missing" | "user-constraint";
    evidenceRef: string;
    verified: true;
    consumed: boolean;
    createdAt: string;
}
export interface LedgerRevision {
    schemaVersion: 1;
    id: string;
    runId: string;
    revision: number;
    replans: number;
    taskIds: string[];
    evidenceId?: string;
    createdAt: string;
}
export declare function validateLedgerTasks(tasks: TaskDefinition[], limit: number): void;
export declare function reviseLedger(host: Host, inputs: TaskDefinition[], options?: {
    bootstrap?: boolean;
    evidenceId?: string;
}): Promise<void>;
