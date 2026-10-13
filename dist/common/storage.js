import { mkdir, readFile, open, unlink, stat, realpath, } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { atomicWrite, canonical, contained, digest, id, now, redact, safeId, assertNoSymlinkRoot, } from "./security.js";
const empty = (extension) => ({
    schemaVersion: 1,
    metadata: { schemaVersion: 1, extension, createdBy: "0.1.0" },
    revision: 0,
    records: {},
    events: [],
    blobs: {},
    leases: {},
});
const clone = (x) => structuredClone(x);
export function validateSnapshot(s, extension, validateBlobs = true) {
    if (s.schemaVersion !== 1 ||
        s.metadata.schemaVersion !== 1 ||
        s.metadata.extension !== extension ||
        !Number.isInteger(s.revision) ||
        s.revision < 0 ||
        !s.records ||
        !Array.isArray(s.events) ||
        !s.blobs ||
        !s.leases)
        throw new Error("unsupported-or-corrupt-schema");
    const seen = new Set();
    s.events.forEach((e, i) => {
        if (e.sequence !== i + 1 ||
            !e.eventId ||
            seen.has(e.eventId) ||
            e.schemaVersion !== 1)
            throw new Error("corrupt-event-sequence");
        seen.add(e.eventId);
    });
    for (const [collection, rows] of Object.entries(s.records)) {
        safeId(collection);
        for (const [key, row] of Object.entries(rows)) {
            safeId(key);
            if (!Number.isInteger(row.version) || row.version < 1)
                throw new Error("corrupt-record-version");
        }
    }
    for (const [key, base64] of Object.entries(s.blobs)) {
        safeId(key);
        const ref = s.records.blobrefs?.[key]?.value;
        if (validateBlobs &&
            ref &&
            digest(Buffer.from(base64, "base64")) !== ref.sha256)
            throw new Error("corrupt-blob");
    }
}
export class StorageBase {
    options;
    opened = false;
    mutations = Promise.resolve();
    constructor(options) {
        this.options = options;
    }
    transact(fn) {
        const work = this.mutations.then(() => this.commitMutation((s) => {
            if (s.metadata.migratedTo)
                throw new Error("storage-migrated-reopen");
            return fn(s);
        }));
        this.mutations = work.catch(() => { });
        return work;
    }
    async rollbackMigration(target) {
        return this.commitMutation((s) => {
            if (s.metadata.migratedTo !== target)
                throw new Error("migration-ownership-mismatch");
            delete s.metadata.migratedTo;
            delete s.metadata.migrationPid;
            delete s.metadata.migrationHost;
        });
    }
    assertOpen() {
        if (!this.opened)
            throw new Error("storage-closed");
    }
    async getMetadata() {
        return (await this.exportSnapshot()).metadata;
    }
    async setMetadata(m) {
        await this.transact((s) => {
            s.metadata = m;
        });
    }
    async getRecord(c, k) {
        safeId(c);
        safeId(k);
        return clone((await this.exportSnapshot()).records[c]?.[k]?.value ?? null);
    }
    async listRecords(c) {
        safeId(c);
        return Object.entries((await this.exportSnapshot()).records[c] ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, r]) => clone(r.value));
    }
    async putRecord(c, k, v, o) {
        safeId(c);
        safeId(k);
        await this.transact((s) => put(s, c, k, v, o?.expectedVersion));
    }
    async deleteRecord(c, k) {
        safeId(c);
        safeId(k);
        await this.transact((s) => {
            if (s.records[c])
                delete s.records[c][k];
        });
    }
    async appendEvent(e) {
        await this.transact((s) => append(s, e));
    }
    async writeBlob(k, data) {
        safeId(k);
        const clean = Buffer.from(data);
        const ref = { id: k, sha256: digest(clean), bytes: clean.length };
        await this.transact((s) => {
            if (s.blobs[k] && s.blobs[k] !== clean.toString("base64"))
                throw new Error("immutable-blob");
            s.blobs[k] = clean.toString("base64");
            put(s, "blobrefs", k, ref);
        });
        return ref;
    }
    async readBlob(k) {
        safeId(k);
        const s = await this.exportSnapshot();
        const b = s.blobs[k];
        if (b === undefined)
            return null;
        const data = Buffer.from(b, "base64");
        const ref = s.records.blobrefs?.[k]?.value;
        if (!ref || digest(data) !== ref.sha256)
            throw new Error("corrupt-blob");
        return data;
    }
    async acquireLease(resource, ttlMs) {
        safeId(resource);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
            throw new Error("invalid-lease-ttl");
        return this.transact((s) => {
            const prior = s.leases[resource];
            if (prior && prior.expiresAt > Date.now())
                throw new Error("lease-held");
            const lease = { resource, owner: id(), expiresAt: Date.now() + ttlMs };
            s.leases[resource] = lease;
            return lease;
        });
    }
    async releaseLease(lease) {
        await this.transact((s) => {
            if (s.leases[lease.resource]?.owner === lease.owner)
                delete s.leases[lease.resource];
        });
    }
    async checkpoint(value) {
        await this.putRecord("checkpoints", value.id, value);
    }
    async importSnapshot(s) {
        validateSnapshot(s, this.options.extension);
        await this.transact((target) => {
            if (target.revision || Object.keys(target.records).length)
                throw new Error("destination-not-empty");
            Object.assign(target, clone(s));
        });
    }
}
export function put(s, c, k, value, expectedVersion) {
    safeId(c);
    safeId(k);
    const rows = (s.records[c] ??= {});
    const previous = rows[k];
    if (expectedVersion !== undefined &&
        (previous?.version ?? 0) !== expectedVersion)
        throw new Error("version-conflict");
    rows[k] = {
        version: (previous?.version ?? 0) + 1,
        value: redact(clone(value)),
    };
}
export function append(s, e) {
    if (e.schemaVersion !== 1 || !e.eventId || !e.eventType)
        throw new Error("invalid-event");
    if (s.events.some((x) => x.eventId === e.eventId))
        return;
    s.events.push({ ...redact(clone(e)), sequence: s.events.length + 1 });
}
export class FileStorage extends StorageBase {
    root = "";
    async pack(state) {
        const packed = clone(state);
        for (const [key, base64] of Object.entries(state.blobs)) {
            const bytes = Buffer.from(base64, "base64");
            const hash = digest(bytes);
            const path = await contained(this.root, "blobs/" + safeId(key) + ".blob", true);
            try {
                await stat(path);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                await atomicWrite(path, bytes);
            }
            packed.blobs[key] = "blob:" + hash;
        }
        return packed;
    }
    async hydrate(state) {
        const hydrated = clone(state);
        for (const [key, value] of Object.entries(state.blobs)) {
            if (!value.startsWith("blob:"))
                continue;
            const bytes = await readFile(await contained(this.root, "blobs/" + safeId(key) + ".blob"));
            if (digest(bytes) !== value.slice(5))
                throw new Error("corrupt-blob");
            hydrated.blobs[key] = bytes.toString("base64");
        }
        validateSnapshot(hydrated, this.options.extension);
        return hydrated;
    }
    async open() {
        await assertNoSymlinkRoot(this.options.root);
        await mkdir(this.options.root, { recursive: true, mode: 0o700 });
        // Reject symlinked namespace roots instead of following them into another extension.
        await assertNoSymlinkRoot(this.options.root);
        this.root = await realpath(this.options.root);
        this.opened = true;
        try {
            await this.recover();
        }
        catch (e) {
            this.opened = false;
            throw e;
        }
    }
    async close() {
        this.opened = false;
    }
    async lock() {
        const file = await contained(this.root, "writer.lock", true);
        const owner = {
            id: id(),
            pid: process.pid,
            host: hostname(),
            createdAt: now(),
        };
        for (let n = 0; n < 2; n++) {
            try {
                const h = await open(file, "wx", 0o600);
                try {
                    await h.writeFile(JSON.stringify(owner));
                    await h.sync();
                }
                finally {
                    await h.close();
                }
                return async () => {
                    const current = JSON.parse(await readFile(file, "utf8"));
                    if (current.id !== owner.id)
                        throw new Error("writer-ownership-lost");
                    await unlink(file);
                };
            }
            catch (e) {
                if (e.code !== "EEXIST")
                    throw e;
                const reaper = await contained(this.root, "reaper.lock", true);
                let guard;
                try {
                    guard = await open(reaper, "wx", 0o600);
                }
                catch {
                    throw new Error("writer-busy");
                }
                try {
                    const text = await readFile(file, "utf8");
                    let stale;
                    try {
                        stale = JSON.parse(text);
                    }
                    catch {
                        throw new Error("invalid-writer-lock-review-required");
                    }
                    if (stale.host !== hostname() ||
                        !Number.isInteger(stale.pid) ||
                        stale.pid <= 0)
                        throw new Error("foreign-writer-review-required");
                    let alive = true;
                    try {
                        process.kill(stale.pid, 0);
                    }
                    catch (err) {
                        if (err.code === "ESRCH")
                            alive = false;
                    }
                    if (alive)
                        throw new Error("writer-busy");
                    if ((await readFile(file, "utf8")) !== text)
                        throw new Error("writer-lock-changed");
                    await unlink(file);
                }
                finally {
                    await guard.close();
                    await unlink(reaper);
                }
            }
        }
        throw new Error("writer-busy");
    }
    async load(repair = false) {
        const snapshotPath = await contained(this.root, "snapshot.json", true);
        const journalPath = await contained(this.root, "events.jsonl", true);
        let state = empty(this.options.extension);
        let snapshotExists = false;
        try {
            const wrapper = JSON.parse(await readFile(snapshotPath, "utf8"));
            if (wrapper.sha256 !== digest(wrapper.state))
                throw new Error("snapshot-checksum");
            state = wrapper.state;
            snapshotExists = true;
            validateSnapshot(state, this.options.extension, false);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw new Error("corrupt-snapshot-read-only", { cause: e });
        }
        let journal = "";
        try {
            journal = await readFile(journalPath, "utf8");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
        const lines = journal.split("\n");
        let previousHash = "";
        let revision = 0;
        let latest;
        let repairedTail = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (i === lines.length - 1 && line === "")
                break;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch (e) {
                if (i === lines.length - 1 &&
                    !journal.endsWith("\n") &&
                    repair &&
                    revision >= state.revision) {
                    await atomicWrite(join(this.root, "truncated-tail." + id() + ".txt"), line);
                    await atomicWrite(journalPath, lines.slice(0, i).join("\n") + (i ? "\n" : ""));
                    repairedTail = true;
                    break;
                }
                throw new Error("corrupt-journal", { cause: e });
            }
            if (entry.previousHash !== previousHash ||
                entry.sha256 !==
                    digest({ previousHash: entry.previousHash, state: entry.state }) ||
                entry.state.revision !== revision + 1)
                throw new Error("journal-checksum-or-sequence");
            validateSnapshot(entry.state, this.options.extension, false);
            revision = entry.state.revision;
            previousHash = entry.sha256;
            latest = entry.state;
            if (revision === state.revision && digest(entry.state) !== digest(state))
                throw new Error("snapshot-journal-divergence");
        }
        if (state.revision > revision)
            throw new Error("missing-authoritative-journal");
        const recoveredCommits = Math.max(0, revision - state.revision);
        if (latest && latest.revision > state.revision)
            state = latest;
        if (repair && (recoveredCommits || !snapshotExists))
            await atomicWrite(snapshotPath, canonical({ state, sha256: digest(state) }));
        return { state: await this.hydrate(state), recoveredCommits, repairedTail };
    }
    async recover() {
        this.assertOpen();
        const release = await this.lock();
        try {
            const r = await this.load(true);
            return {
                ok: true,
                ...r,
                state: undefined,
                revision: r.state.revision,
            };
        }
        finally {
            await release();
        }
    }
    async exportSnapshot() {
        this.assertOpen();
        return clone((await this.load()).state);
    }
    async commitMutation(fn) {
        this.assertOpen();
        const release = await this.lock();
        try {
            const { state } = await this.load(true);
            const oldRevision = state.revision;
            const result = await fn(state);
            state.revision = oldRevision + 1;
            validateSnapshot(state, this.options.extension);
            const journal = await contained(this.root, "events.jsonl", true);
            let previousHash = "";
            try {
                const rows = (await readFile(journal, "utf8")).trim().split("\n");
                if (rows[0])
                    previousHash = JSON.parse(rows.at(-1)).sha256;
            }
            catch (e) {
                if (e.code !== "ENOENT")
                    throw e;
            }
            this.options.fault?.("before-journal");
            const packed = await this.pack(state);
            const entry = {
                state: packed,
                previousHash,
                sha256: digest({ state: packed, previousHash }),
            };
            const h = await open(journal, "a", 0o600);
            try {
                await h.writeFile(canonical(entry) + "\n");
                await h.sync();
            }
            finally {
                await h.close();
            }
            this.options.fault?.("after-journal");
            this.options.fault?.("before-snapshot");
            await atomicWrite(await contained(this.root, "snapshot.json", true), canonical({ state: packed, sha256: digest(packed) }));
            this.options.fault?.("after-snapshot");
            return clone(result);
        }
        finally {
            await release();
        }
    }
}
export class SqliteStorage extends StorageBase {
    db;
    async open() {
        await assertNoSymlinkRoot(this.options.root);
        await mkdir(this.options.root, { recursive: true, mode: 0o700 });
        await assertNoSymlinkRoot(this.options.root);
        const { DatabaseSync } = await import("node:sqlite");
        const path = await contained(this.options.root, "state.sqlite", true);
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${Math.min(5000, this.options.busyTimeoutMs ?? 5000)}; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL, sha256 TEXT NOT NULL);`);
        const s = empty(this.options.extension);
        this.db
            .prepare("INSERT OR IGNORE INTO state VALUES(1,?,?,?)")
            .run(0, canonical(s), digest(s));
        this.opened = true;
        try {
            await this.exportSnapshot();
        }
        catch (e) {
            await this.close();
            throw e;
        }
    }
    async close() {
        this.db?.close();
        this.db = undefined;
        this.opened = false;
    }
    async exportSnapshot() {
        this.assertOpen();
        const row = this.db.prepare("SELECT * FROM state WHERE id=1").get();
        const s = JSON.parse(row.value);
        if (digest(s) !== row.sha256 || s.revision !== row.revision)
            throw new Error("corrupt-sqlite-state");
        validateSnapshot(s, this.options.extension);
        return s;
    }
    async commitMutation(fn) {
        this.assertOpen();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const s = await this.exportSnapshot();
            const revision = s.revision;
            const result = await fn(s);
            s.revision = revision + 1;
            validateSnapshot(s, this.options.extension);
            this.options.fault?.("before-journal");
            this.db.prepare("UPDATE state SET revision=?,value=?,sha256=? WHERE id=1 AND revision=?").run(s.revision, canonical(s), digest(s), revision);
            this.options.fault?.("before-snapshot");
            this.db.exec("COMMIT");
            return clone(result);
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    async recover() {
        const s = await this.exportSnapshot();
        return {
            ok: true,
            recoveredCommits: 0,
            repairedTail: false,
            revision: s.revision,
        };
    }
}
