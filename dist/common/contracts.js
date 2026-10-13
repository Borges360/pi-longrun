import { id, now, redact } from "./security.js";
export function envelope(source, eventType, payload, context = {}) {
    return {
        ...context,
        schemaVersion: 1,
        eventId: id(),
        eventType,
        source,
        correlationId: context.correlationId ?? id(),
        emittedAt: now(),
        payload: redact(payload),
    };
}
export function isEnvelope(data, channel) {
    if (!data || typeof data !== "object")
        return false;
    const e = data;
    return (e.schemaVersion === 1 &&
        typeof e.eventId === "string" &&
        typeof e.source === "string" &&
        typeof e.correlationId === "string" &&
        typeof e.emittedAt === "string" &&
        Number.isFinite(Date.parse(e.emittedAt)) &&
        (!channel || e.eventType === channel) &&
        e.payload !== undefined);
}
export class Interop {
    source;
    bus;
    projectKey;
    disabled;
    seen = new Set();
    latest = new Map();
    unsubscribers = [];
    failures = 0;
    fallbacks = 0;
    incompatible = 0;
    assessments = new Map();
    capabilities = new Map();
    constructor(source, bus, projectKey, disabled = []) {
        this.source = source;
        this.bus = bus;
        this.projectKey = projectKey;
        this.disabled = disabled;
    }
    emit(type, payload, context = {}) {
        const e = envelope(this.source, type, payload, {
            ...context,
            projectKey: this.projectKey,
        });
        try {
            this.bus.emit(type, e);
        }
        catch {
            this.failures++;
        }
        return e;
    }
    listen(type, fn) {
        if (this.disabled.includes(type))
            return;
        this.unsubscribers.push(this.bus.on(type, (data) => {
            if (!isEnvelope(data, type)) {
                this.incompatible++;
                return;
            }
            if (data.projectKey && data.projectKey !== this.projectKey)
                return;
            if (this.seen.has(data.eventId))
                return;
            const key = type + ":" + data.source + ":" + (data.taskId ?? data.correlationId);
            const stamp = Date.parse(data.emittedAt);
            if (stamp < (this.latest.get(key) ?? 0))
                return;
            this.latest.set(key, stamp);
            this.seen.add(data.eventId);
            if (this.seen.size > 10000)
                this.seen.delete(this.seen.values().next().value);
            // EventBus.emit is synchronous. Keep exceptions and rejected asynchronous handlers local.
            try {
                void Promise.resolve(fn(data)).catch(() => {
                    this.failures++;
                });
            }
            catch {
                this.failures++;
            }
        }));
    }
    start(capabilities) {
        this.listen("pi.assessment.available.v1", (e) => {
            const p = e.payload;
            if (["trivial", "simple", "moderate", "complex", "critical"].includes(p.difficulty) &&
                Array.isArray(p.risks) &&
                p.risks.every((risk) => typeof risk === "string") &&
                typeof p.confidence === "number" &&
                Number.isFinite(p.confidence) &&
                p.confidence <= 1 &&
                p.confidence >= 0.65)
                this.assessments.set(e.taskId ?? e.correlationId, p);
        });
        this.listen("pi.ecosystem.capability.v1", (e) => {
            const p = e.payload;
            if (p.extension === e.source &&
                Array.isArray(p.capabilities) &&
                /^0\.|^1\./.test(p.version))
                this.capabilities.set(p.extension, {
                    capabilities: p.capabilities,
                    expiresAt: Date.now() + 60000,
                });
        });
        this.listen("pi.ecosystem.discover.v1", () => {
            this.emit("pi.ecosystem.capability.v1", {
                extension: this.source,
                version: "0.1.0",
                capabilities,
            });
        });
        this.emit("pi.ecosystem.discover.v1", {});
        this.emit("pi.ecosystem.capability.v1", {
            extension: this.source,
            version: "0.1.0",
            capabilities,
        });
    }
    healthy(extension, capability) {
        const p = this.capabilities.get(extension);
        return (!!p && p.expiresAt > Date.now() && p.capabilities.includes(capability));
    }
    close() {
        for (const u of this.unsubscribers.splice(0))
            u();
    }
}
export function assess(text, paths = []) {
    const risks = [
        "security",
        "production",
        "database",
        "data-loss",
        "concurrency",
    ].filter((r) => new RegExp({
        security: "security|auth|credential|seguran",
        production: "production|deploy|produ",
        database: "database|migration|schema|banco",
        "data-loss": "delete|drop|destroy|excluir|apagar",
        concurrency: "concurren|race|parallel write",
    }[r], "i").test(text));
    const count = text
        .split(/\n|;|\bthen\b|\bdepois\b/)
        .filter((x) => x.trim()).length;
    const difficulty = risks.length
        ? "critical"
        : paths.length > 4 || count > 4
            ? "complex"
            : paths.length > 1 || count > 2 || text.length > 500
                ? "moderate"
                : text.length < 100
                    ? "trivial"
                    : "simple";
    return { difficulty, risks, confidence: 0.75 };
}
