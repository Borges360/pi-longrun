import type {
  ExtensionStorage,
  StorageBase,
  BlobRef,
} from "./common/storage.js";
import { put } from "./common/storage.js";
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
export function asLongrunStorage(store: StorageBase): LongrunStorage {
  const write = async (
    collection: string,
    value: { id: string; schemaVersion: 1 },
    create: boolean,
  ) => {
    if (value.schemaVersion !== 1)
      throw new Error("unsupported-longrun-schema");
    await store.transact((snapshot) => {
      const exists = !!snapshot.records[collection]?.[value.id];
      if (create === exists)
        throw new Error(create ? "record-already-exists" : "record-not-found");
      put(snapshot, collection, value.id, value);
    });
  };
  const methods = {
    createRun: (run: RunRecord) => write("runs", run, true),
    getRun: (key: string) => store.getRecord<RunRecord>("runs", key),
    updateRun: (run: RunRecord) => write("runs", run, false),
    createTask: (task: LongrunTask) => write("tasks", task, true),
    getTask: (key: string) => store.getRecord<LongrunTask>("tasks", key),
    updateTask: (task: LongrunTask) => write("tasks", task, false),
    listTasks: async (runId: string) =>
      (await store.listRecords<LongrunTask>("tasks")).filter(
        (task) => task.runId === runId,
      ),
    saveEvidence: (evidence: EvidenceRecord) =>
      store.putRecord("evidence", evidence.id, evidence),
    saveGateResult: (result: GateResult) =>
      store.putRecord("gates", result.id, result),
    getLatestCheckpoint: async (taskId: string) =>
      (await store.listRecords<CheckpointRecord>("checkpoints"))
        .filter((checkpoint) => checkpoint.taskId === taskId)
        .sort((a, b) => b.sequence - a.sequence)[0] ?? null,
  };
  return new Proxy(store, {
    get(target, key) {
      if (key in methods) return methods[key as keyof typeof methods];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as LongrunStorage;
}
