import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Config } from "./config.js";
import { type StorageBase } from "./storage.js";
import { Interop, type EventBus } from "./contracts.js";
export interface CommandContext {
    cwd: string;
    trusted: boolean;
    signal?: AbortSignal;
    hostContext?: ExtensionContext;
    commandContext?: ExtensionCommandContext;
}
export interface Service {
    capabilities: string[];
    menu: string[];
    menuGroups?: Record<string, string[]>;
    menuInputs?: Record<string, string>;
    modeDescriptions?: Partial<Record<"auto" | "observe" | "off", string>>;
    command(action: string, args: string[], context: CommandContext): Promise<unknown>;
    start?(): Promise<void>;
    close?(): Promise<void>;
    prompt?(prompt: string, context: ExtensionContext): Promise<unknown>;
    toolCall?(event: unknown, context: ExtensionContext): Promise<{
        block: true;
        reason: string;
    } | undefined>;
    toolResult?(event: unknown, context: ExtensionContext): Promise<void>;
    messageEnd?(event: unknown, context: ExtensionContext): Promise<void>;
    settle?(event: unknown, context: ExtensionContext): Promise<{
        continue?: boolean;
        entries?: unknown[];
    } | undefined>;
}
export type ServiceFactory = (host: Host) => Service;
export declare const toolResult: (value: unknown) => {
    content: {
        type: "text";
        text: string;
    }[];
    details: unknown;
};
export declare class Host {
    readonly extension: string;
    readonly factory: ServiceFactory;
    readonly cwd: string;
    readonly bus: EventBus;
    readonly trusted: boolean;
    readonly api?: ExtensionAPI | undefined;
    config: Config;
    store: StorageBase;
    interop: Interop;
    service: Service;
    key: string;
    private started;
    private starting?;
    private queue;
    migrationFault?: (phase: "after-seal" | "after-pointer") => void;
    constructor(extension: string, factory: ServiceFactory, cwd: string, bus: EventBus, trusted?: boolean, api?: ExtensionAPI | undefined);
    start(): Promise<void>;
    private initialize;
    private initializeResources;
    close(): Promise<void>;
    serial<T>(fn: () => Promise<T>): Promise<T>;
    configure(patch: Partial<Config>): Promise<{
        schemaVersion: 1;
        enabled: boolean;
        mode: "auto" | "off" | "observe";
        storage: {
            backend: "files" | "sqlite" | "durable";
            root: string;
        };
        disabledIntegrations: string[];
        maxActive: number;
        minScore: number;
        maxSkillTokens: number;
        maxAttempts: number;
        maxAutomaticTurns: number;
        maxOpenTasks: number;
        maxReplans: number;
        maxInitialTasks: number;
        maxDependencyDepth: number;
        maxHandoffTokens: number;
        maxEvidenceTokens: number;
        compactAtRatio: number;
        handoffAtRatio: number;
        targetRatio: number;
        maxCostUsd: number | null;
        maxToolCalls: number;
        maxParallel: number;
        maxDepth: number;
        maxChildrenPerTask: number;
        writeAccess: boolean;
        childTimeoutMs: number;
        maxChildTokens: number;
        credentialEnv: string[];
        skillRoots: string[];
        agentRoots: string[];
        trustedProject: boolean;
        maxServersPerTask: number;
        maxDirectTools: number;
        defaultAccess: "deny";
        preferReadOnly: boolean;
        requireApproval: true;
        assistantClaims: false;
        requireEvidence: true;
        defaultProfile: "standard" | "strict";
        maxRepairAttempts: number;
        gateTimeoutMs: number;
    }>;
    doctor(): Promise<{
        extension: string;
        version: string;
        pi: string;
        node: string;
        enabled: boolean;
        mode: "auto" | "off" | "observe";
        storage: string;
        recovery: import("./storage.js").RecoveryReport;
        integrations: {
            failures: number;
            fallbacks: number;
            incompatible: number;
        };
        standalone: boolean;
    }>;
    command(action: string, args: string[], context: CommandContext): Promise<unknown>;
    migrate(backend?: string): Promise<{
        migrationId: `${string}-${string}-${string}-${string}-${string}`;
        backend: string;
        verified: boolean;
        backupPreserved: boolean;
    }>;
}
export declare function register(pi: ExtensionAPI, extension: string, command: string, factory: ServiceFactory, tools?: ToolDefinition[]): {
    get: (ctx: ExtensionContext) => Promise<Host>;
};
