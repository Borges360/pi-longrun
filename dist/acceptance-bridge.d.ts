import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Host } from "./common/runtime.js";
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
export declare class AcceptanceGateBridge {
    readonly host: Host;
    private unsubscribe?;
    private projectId;
    private sessionId;
    private seen;
    private latest;
    private binding;
    private pending;
    constructor(host: Host);
    attach(context: ExtensionContext): Promise<void>;
    close(): void;
    bind(runId: string, taskId: string): Promise<{
        instruction: string;
        schemaVersion: 1;
        runId: string;
        taskId: string;
        boundAt: string;
        status: string;
        eventId?: string;
        contractHash?: string;
        evidenceIds?: string[];
    }>;
    unbind(runId: string): Promise<{
        unbound: boolean;
    }>;
    status(runId?: string): Promise<AcceptanceGateBinding | null>;
    ready(runId: string): Promise<boolean>;
    invalidate(runId: string): Promise<void>;
    receive(raw: unknown): Promise<void>;
}
