import { Type } from "typebox";
import type { Host, CommandContext } from "./common/runtime.js";
import { type GateProfile, type AcceptanceRequirement, type GatePolicy, type GateResult } from "./common/gates.js";
export declare const GateRequirementSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TUnion<[Type.TLiteral<"command">, Type.TLiteral<"artifact">, Type.TLiteral<"human">]>;
    required: Type.TBoolean;
    executable: Type.TOptional<Type.TString>;
    args: Type.TOptional<Type.TArray<Type.TString>>;
    path: Type.TOptional<Type.TString>;
    sha256: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    report: Type.TOptional<Type.TObject<{
        format: Type.TUnion<[Type.TLiteral<"junit">, Type.TLiteral<"json">]>;
        path: Type.TString;
    }>>;
}>;
export interface GateSet {
    schemaVersion: 1;
    id: string;
    objective: string;
    requirements: AcceptanceRequirement[];
}
export interface GateRun {
    schemaVersion: 1;
    id: string;
    setId: string;
    profile: GateProfile;
    status: "passed" | "failed" | "blocked";
    attempt: number;
    results: GateResult[];
    createdAt: string;
}
export declare function validateGateSet(input: unknown): GateSet;
export declare function profileWithFloor(requested: GateProfile, risks: string[]): GateProfile;
export declare class LocalGate {
    readonly host: Host;
    constructor(host: Host);
    currentSet(): Promise<GateSet | null>;
    last(): Promise<GateRun | null>;
    policy(attempt?: number): Promise<GatePolicy>;
    discover(): Promise<{
        schemaVersion: number;
        source: string;
        trustedProject: boolean;
        requirements: {
            id: string;
            kind: "command";
            required: boolean;
            executable: string;
            args: string[];
        }[];
        execution: string;
    }>;
    verify(signal?: AbortSignal): Promise<GateRun>;
    command(action: string, args: string[], context: CommandContext): Promise<unknown>;
}
