import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Session, SessionDocToken } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  StorageBase,
  validateSnapshot,
  type PortableSnapshot,
  type StoreOptions,
} from "./storage.js";
import { canonical, contained, digest, id } from "./security.js";
type Document = { snapshot: string; sha256: string };
/** Optional adapter pinned to Pi Durable 1.2.0. No agent loop or model is created. */
export class DurableStorage extends StorageBase {
  private session?: Session;
  private token?: SessionDocToken<Document>;
  private context?: Context;
  private owner?: string;
  constructor(options: StoreOptions) {
    super(options);
  }
  async open() {
    if (this.opened) return;
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const ownerPath = await contained(
      this.options.root,
      "durable-owner.lock",
      true,
    );
    this.owner = id();
    const arbiterPath = await contained(
      this.options.root,
      "durable-arbitrator.lock",
      true,
    );
    let arbiter;
    try {
      arbiter = await open(arbiterPath, "wx", 0o600);
    } catch {
      throw new Error("durable-owner-arbitration-busy");
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await open(ownerPath, "wx", 0o600);
          try {
            await handle.writeFile(
              canonical({ id: this.owner, pid: process.pid, host: hostname() }),
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          const prior = JSON.parse(await readFile(ownerPath, "utf8"));
          if (!Number.isInteger(prior.pid) || prior.pid <= 0)
            throw new Error("durable-owner-invalid");
          if (prior.host !== hostname())
            throw new Error("durable-foreign-owner");
          let dead = false;
          try {
            process.kill(prior.pid, 0);
          } catch (err) {
            dead = (err as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (!dead || attempt) throw new Error("durable-owner-busy");
          await unlink(ownerPath);
        }
      }
    } finally {
      await arbiter.close();
      await unlink(arbiterPath);
    }
    try {
      const [
        { createSession, defineDoc },
        { openNodeJsonlStorage },
        { BACKGROUND_CONTEXT },
      ] = await Promise.all([
        import("@earendil-works/pi-durable"),
        import("@earendil-works/pi-durable/storage/jsonl/node"),
        import("@earendil-works/chord/context"),
      ]);
      this.context = BACKGROUND_CONTEXT;
      const initial: PortableSnapshot = {
        schemaVersion: 1,
        metadata: {
          schemaVersion: 1,
          extension: this.options.extension,
          createdBy: "0.1.0",
        },
        revision: 0,
        records: {},
        events: [],
        blobs: {},
        leases: {},
      };
      this.token = defineDoc<Document>({
        kind: this.options.extension + ".state",
        version: 1,
        scope: "session",
        initial: () => ({
          snapshot: canonical(initial),
          sha256: digest(initial),
        }),
      });
      this.session = createSession(
        await openNodeJsonlStorage(
          join(this.options.root, "documents"),
          BACKGROUND_CONTEXT,
          { fsync: true },
        ),
      );
      await this.session.commit(
        (tx) => tx.doc(this.token!),
        BACKGROUND_CONTEXT,
      );
      this.opened = true;
      await this.exportSnapshot();
    } catch (e) {
      await this.close();
      throw new Error("durable-adapter-unavailable-or-corrupt", { cause: e });
    }
  }
  async close() {
    if (this.session && this.context) await this.session.close(this.context);
    this.session = undefined;
    this.opened = false;
    if (this.owner) {
      const path = join(this.options.root, "durable-owner.lock");
      const prior = JSON.parse(await readFile(path, "utf8"));
      if (prior.id === this.owner) await unlink(path);
      this.owner = undefined;
    }
  }
  async exportSnapshot() {
    this.assertOpen();
    const doc = await this.session!.snapshot(this.token!, this.context!);
    if (!doc) throw new Error("durable-document-missing");
    const s = JSON.parse(doc.snapshot) as PortableSnapshot;
    if (digest(s) !== doc.sha256) throw new Error("durable-checksum");
    validateSnapshot(s, this.options.extension);
    return s;
  }
  protected async commitMutation<T>(
    fn: (s: PortableSnapshot) => T | Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    return this.session!.commit(async (tx) => {
      const doc = await tx.doc(this.token!);
      const s = JSON.parse(doc.snapshot) as PortableSnapshot;
      if (digest(s) !== doc.sha256) throw new Error("durable-checksum");
      validateSnapshot(s, this.options.extension);
      const previous = s.revision;
      const result = await fn(s);
      s.revision = previous + 1;
      validateSnapshot(s, this.options.extension);
      this.options.fault?.("before-journal");
      doc.snapshot = canonical(s);
      doc.sha256 = digest(s);
      this.options.fault?.("before-snapshot");
      return structuredClone(result);
    }, this.context!);
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
