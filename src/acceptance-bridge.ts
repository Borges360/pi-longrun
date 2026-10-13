import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Host } from "./common/runtime.js";
import {
  canonicalRepoRoot,
  digest,
  now,
  redact,
  safeId,
} from "./common/security.js";

export interface AcceptanceGateBinding {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  boundAt: string;
  status: string;
  eventId?: string;
  contractHash?: string;
  evidenceIds?: string[];
}
/** Public suite:event adapter for pi-acceptance-gate 0.3.0. No private state is read. */
export class AcceptanceGateBridge {
  private unsubscribe?: () => void;
  private projectId = "";
  private sessionId = "";
  private seen = new Set<string>();
  private latest = 0;
  private binding: AcceptanceGateBinding | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly host: Host) {}
  async attach(context: ExtensionContext) {
    if (typeof context.sessionManager?.getSessionId !== "function") return;
    const sessionId = context.sessionManager.getSessionId();
    if (this.unsubscribe && this.sessionId === sessionId) return;
    this.close();
    this.sessionId = sessionId;
    const root = await canonicalRepoRoot(this.host.cwd);
    this.projectId = digest(
      process.platform === "win32" ? root.toLowerCase() : root,
    );
    this.unsubscribe = this.host.bus.on("suite:event", (raw) => {
      this.pending = this.pending
        .then(() => this.receive(raw))
        .catch(() => {
          this.host.interop.failures++;
        });
    });
  }
  close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.seen.clear();
    this.latest = 0;
    this.binding = null;
  }
  async bind(runId: string, taskId: string) {
    safeId(taskId);
    this.binding = {
      schemaVersion: 1,
      runId,
      taskId,
      boundAt: now(),
      status: "pending",
    };
    await this.host.store.putRecord(
      "acceptance-gate-bindings",
      runId,
      this.binding,
    );
    return {
      ...this.binding,
      instruction: `Use /gate use ${taskId}, then /gate check with its existing authorization. Local required checks remain mandatory.`,
    };
  }
  async unbind(runId: string) {
    this.binding = null;
    await this.host.store.deleteRecord("acceptance-gate-bindings", runId);
    return { unbound: true };
  }
  async status(runId?: string) {
    if (!runId) return null;
    if (this.binding?.runId === runId) return this.binding;
    const prior = await this.host.store.getRecord<AcceptanceGateBinding>(
      "acceptance-gate-bindings",
      runId,
    );
    // A receipt from an earlier process/session is advisory until checked again.
    this.binding = prior ? { ...prior, status: "pending" } : null;
    return this.binding;
  }
  async ready(runId: string) {
    await this.pending;
    const binding = await this.status(runId);
    return !binding || binding.status === "accepted";
  }
  async invalidate(runId: string) {
    const binding = await this.status(runId);
    if (binding) {
      binding.status = "pending";
      await this.host.store.putRecord(
        "acceptance-gate-bindings",
        runId,
        binding,
      );
    }
  }
  async receive(raw: unknown) {
    const event = raw as {
      schemaVersion: number;
      eventId: string;
      source: string;
      projectId: string;
      sessionId: string;
      occurredAt: string;
      kind: string;
      payload: {
        taskId: string;
        status?: string;
        contractHash?: string;
        evidenceIds?: string[];
        verified?: boolean;
      };
    };
    if (
      !event ||
      event.schemaVersion !== 1 ||
      event.source !== "gate" ||
      event.projectId !== this.projectId ||
      event.sessionId !== this.sessionId ||
      typeof event.eventId !== "string" ||
      this.seen.has(event.eventId) ||
      !event.payload ||
      ![
        "gate.evaluated",
        "gate.invalidated",
        "gate.revision_requested",
        "task.status_changed",
      ].includes(event.kind)
    )
      return;
    const timestamp = Date.parse(event.occurredAt);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < this.latest ||
      timestamp > Date.now() + 5000
    )
      return;
    this.latest = timestamp;
    this.seen.add(event.eventId);
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.values().next().value!);
    const ref = await this.host.store.getRecord<{ id: string }>(
      "current",
      "run",
    );
    const binding = await this.status(ref?.id);
    if (
      !binding ||
      binding.taskId !== event.payload.taskId ||
      timestamp < Date.parse(binding.boundAt)
    )
      return;
    const accepted =
      event.kind === "gate.evaluated" &&
      event.payload.status === "accepted" &&
      event.payload.verified === true &&
      typeof event.payload.contractHash === "string" &&
      /^[a-f0-9]{64}$/.test(event.payload.contractHash) &&
      Array.isArray(event.payload.evidenceIds) &&
      event.payload.evidenceIds.length > 0 &&
      event.payload.evidenceIds.every((value) => typeof value === "string");
    binding.status = accepted
      ? "accepted"
      : (event.payload.status ?? "pending");
    if (binding.status === "accepted" && !accepted) binding.status = "pending";
    binding.eventId = event.eventId;
    binding.contractHash = event.payload.contractHash;
    binding.evidenceIds = event.payload.evidenceIds?.slice(0, 20);
    await this.host.store.putRecord(
      "acceptance-gate-bindings",
      binding.runId,
      redact(binding),
    );
    await this.host.store.putRecord(
      "acceptance-gate-events",
      digest(event.eventId),
      {
        event: redact(event),
        trustedForLocalCompletion: false,
        receivedAt: now(),
      },
    );
  }
}
