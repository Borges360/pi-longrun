import type { ExtensionStorage, StorageBase, BlobRef } from "./common/storage.js";
import type { RunRecord, LongrunTask, CheckpointRecord } from "./longrun.js";
import type { GateResult } from "./common/gates.js";
export interface EvidenceRecord extends BlobRef {
    schemaVersion?: 1;
    kind: string;
    verified: boolean;
    createdAt: string;
}
/** Typed host API over this extension's own namespace; never exposed as a model tool. */
export interface LongrunStorage extends ExtensionStorage {
    createRun(run: RunRecord): Promise<void>;
    getRun(runId: string): Promise<RunRecord | null>;
    updateRun(run: RunRecord): Promise<void>;
    createTask(task: LongrunTask): Promise<void>;
    getTask(taskId: string): Promise<LongrunTask | null>;
    updateTask(task: LongrunTask): Promise<void>;
    listTasks(runId: string): Promise<LongrunTask[]>;
    saveEvidence(evidence: EvidenceRecord): Promise<void>;
    saveGateResult(result: GateResult): Promise<void>;
    getLatestCheckpoint(taskId: string): Promise<CheckpointRecord | null>;
}
export declare function asLongrunStorage(store: StorageBase): LongrunStorage;
