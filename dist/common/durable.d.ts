import { StorageBase, type PortableSnapshot, type StoreOptions } from "./storage.js";
/** Optional adapter pinned to Pi Durable 1.2.0. No agent loop or model is created. */
export declare class DurableStorage extends StorageBase {
    private session?;
    private token?;
    private context?;
    private owner?;
    constructor(options: StoreOptions);
    open(): Promise<void>;
    close(): Promise<void>;
    exportSnapshot(): Promise<PortableSnapshot>;
    protected commitMutation<T>(fn: (s: PortableSnapshot) => T | Promise<T>): Promise<T>;
    recover(): Promise<{
        ok: boolean;
        recoveredCommits: number;
        repairedTail: boolean;
        revision: number;
    }>;
}
