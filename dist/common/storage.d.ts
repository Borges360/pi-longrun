export interface StoredEvent {
    eventId: string;
    eventType: string;
    schemaVersion: 1;
    emittedAt: string;
    payload: unknown;
    correlationId?: string;
    sequence?: number;
}
export interface Lease {
    resource: string;
    owner: string;
    expiresAt: number;
}
export interface StorageMetadata {
    schemaVersion: 1;
    extension: string;
    createdBy: string;
    migratedTo?: string;
    migrationPid?: number;
    migrationHost?: string;
}
export interface BlobRef {
    id: string;
    sha256: string;
    bytes: number;
}
export interface RecordEntry {
    version: number;
    value: unknown;
}
export interface PortableSnapshot {
    schemaVersion: 1;
    metadata: StorageMetadata;
    revision: number;
    records: Record<string, Record<string, RecordEntry>>;
    events: StoredEvent[];
    blobs: Record<string, string>;
    leases: Record<string, Lease>;
}
export interface RecoveryReport {
    ok: boolean;
    recoveredCommits: number;
    repairedTail: boolean;
    revision: number;
}
export interface ExtensionStorage {
    open(): Promise<void>;
    close(): Promise<void>;
    getMetadata(): Promise<StorageMetadata>;
    setMetadata(value: StorageMetadata): Promise<void>;
    getRecord<T>(collection: string, id: string): Promise<T | null>;
    putRecord<T>(collection: string, id: string, value: T, options?: {
        expectedVersion?: number;
    }): Promise<void>;
    deleteRecord(collection: string, id: string): Promise<void>;
    listRecords<T>(collection: string): Promise<T[]>;
    appendEvent(event: StoredEvent): Promise<void>;
    writeBlob(id: string, data: Uint8Array): Promise<BlobRef>;
    readBlob(id: string): Promise<Uint8Array | null>;
    acquireLease(resource: string, ttlMs: number): Promise<Lease>;
    releaseLease(lease: Lease): Promise<void>;
    checkpoint(value: {
        id: string;
        [key: string]: unknown;
    }): Promise<void>;
    recover(): Promise<RecoveryReport>;
    exportSnapshot(): Promise<PortableSnapshot>;
}
export type FaultPoint = "before-journal" | "after-journal" | "before-snapshot" | "after-snapshot";
export interface StoreOptions {
    root: string;
    extension: string;
    fault?: (point: FaultPoint) => void;
    busyTimeoutMs?: number;
}
export declare function validateSnapshot(s: PortableSnapshot, extension: string, validateBlobs?: boolean): void;
export declare abstract class StorageBase implements ExtensionStorage {
    readonly options: StoreOptions;
    protected opened: boolean;
    private mutations;
    constructor(options: StoreOptions);
    abstract open(): Promise<void>;
    abstract close(): Promise<void>;
    protected abstract commitMutation<T>(fn: (s: PortableSnapshot) => T | Promise<T>): Promise<T>;
    transact<T>(fn: (s: PortableSnapshot) => T | Promise<T>): Promise<T>;
    rollbackMigration(target: string): Promise<void>;
    abstract exportSnapshot(): Promise<PortableSnapshot>;
    abstract recover(): Promise<RecoveryReport>;
    protected assertOpen(): void;
    getMetadata(): Promise<StorageMetadata>;
    setMetadata(m: StorageMetadata): Promise<void>;
    getRecord<T>(c: string, k: string): Promise<T | null>;
    listRecords<T>(c: string): Promise<T[]>;
    putRecord<T>(c: string, k: string, v: T, o?: {
        expectedVersion?: number;
    }): Promise<void>;
    deleteRecord(c: string, k: string): Promise<void>;
    appendEvent(e: StoredEvent): Promise<void>;
    writeBlob(k: string, data: Uint8Array): Promise<BlobRef>;
    readBlob(k: string): Promise<Buffer<ArrayBuffer> | null>;
    acquireLease(resource: string, ttlMs: number): Promise<{
        resource: string;
        owner: `${string}-${string}-${string}-${string}-${string}`;
        expiresAt: number;
    }>;
    releaseLease(lease: Lease): Promise<void>;
    checkpoint(value: {
        id: string;
        [key: string]: unknown;
    }): Promise<void>;
    importSnapshot(s: PortableSnapshot): Promise<void>;
}
export declare function put(s: PortableSnapshot, c: string, k: string, value: unknown, expectedVersion?: number): void;
export declare function append(s: PortableSnapshot, e: StoredEvent): void;
export declare class FileStorage extends StorageBase {
    private root;
    private pack;
    private hydrate;
    open(): Promise<void>;
    close(): Promise<void>;
    private lock;
    private load;
    recover(): Promise<RecoveryReport>;
    exportSnapshot(): Promise<PortableSnapshot>;
    protected commitMutation<T>(fn: (s: PortableSnapshot) => T | Promise<T>): Promise<T>;
}
export declare class SqliteStorage extends StorageBase {
    private db?;
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
