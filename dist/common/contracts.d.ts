export interface PiExtensionEventV1<T = unknown> {
    schemaVersion: 1;
    eventId: string;
    eventType: string;
    source: string;
    correlationId: string;
    taskId?: string;
    runId?: string;
    projectKey?: string;
    emittedAt: string;
    payload: T;
}
export interface Assessment {
    kind?: string;
    difficulty: "trivial" | "simple" | "moderate" | "complex" | "critical";
    risks: string[];
    confidence: number;
}
export interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export declare function envelope<T>(source: string, eventType: string, payload: T, context?: Partial<Pick<PiExtensionEventV1, "correlationId" | "taskId" | "runId" | "projectKey">>): PiExtensionEventV1<T>;
export declare function isEnvelope(data: unknown, channel?: string): data is PiExtensionEventV1;
export declare class Interop {
    readonly source: string;
    readonly bus: EventBus;
    readonly projectKey: string;
    readonly disabled: string[];
    private seen;
    private latest;
    private unsubscribers;
    failures: number;
    fallbacks: number;
    incompatible: number;
    assessments: Map<string, Assessment>;
    capabilities: Map<string, {
        capabilities: string[];
        expiresAt: number;
    }>;
    constructor(source: string, bus: EventBus, projectKey: string, disabled?: string[]);
    emit<T>(type: string, payload: T, context?: Partial<Pick<PiExtensionEventV1, "correlationId" | "taskId" | "runId">>): PiExtensionEventV1<T>;
    listen(type: string, fn: (e: PiExtensionEventV1) => void | Promise<void>): void;
    start(capabilities: string[]): void;
    healthy(extension: string, capability: string): boolean;
    close(): void;
}
export declare function assess(text: string, paths?: string[]): Assessment;
