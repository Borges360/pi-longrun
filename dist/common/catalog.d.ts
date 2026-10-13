import type { AgentDefinition } from "./children.js";
export interface SkillMetadata {
    schemaVersion: 1;
    id: string;
    name: string;
    description: string;
    keywords: string[];
    paths: string[];
    stack: string[];
    kind: "skill" | "playbook";
    file: string;
    sha256: string;
    trusted: boolean;
    provenance: string;
}
export interface AuditResult {
    schemaVersion: 1;
    sha256: string;
    passed: boolean;
    findings: string[];
    source: string;
}
export declare function audit(text: string, source: string): AuditResult;
export declare function frontmatter(text: string): {
    metadata: Record<string, unknown>;
    body: string;
};
export declare function discoverSkills(roots: Array<{
    path: string;
    trusted: boolean;
}>): Promise<SkillMetadata[]>;
export declare function discoverAgents(roots: Array<{
    path: string;
    trusted: boolean;
}>): Promise<AgentDefinition[]>;
export declare function installSkill(source: string, expectedSha256: string, targetRoot: string, skillId: string): Promise<AuditResult>;
