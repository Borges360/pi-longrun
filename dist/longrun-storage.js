import { put } from "./common/storage.js";
export function asLongrunStorage(store) {
    const write = async (collection, value, create) => {
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
        createRun: (run) => write("runs", run, true),
        getRun: (key) => store.getRecord("runs", key),
        updateRun: (run) => write("runs", run, false),
        createTask: (task) => write("tasks", task, true),
        getTask: (key) => store.getRecord("tasks", key),
        updateTask: (task) => write("tasks", task, false),
        listTasks: async (runId) => (await store.listRecords("tasks")).filter((task) => task.runId === runId),
        saveEvidence: (evidence) => store.putRecord("evidence", evidence.id, evidence),
        saveGateResult: (result) => store.putRecord("gates", result.id, result),
        getLatestCheckpoint: async (taskId) => (await store.listRecords("checkpoints"))
            .filter((checkpoint) => checkpoint.taskId === taskId)
            .sort((a, b) => b.sequence - a.sequence)[0] ?? null,
    };
    return new Proxy(store, {
        get(target, key) {
            if (key in methods)
                return methods[key];
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
