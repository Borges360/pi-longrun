export declare const id: () => `${string}-${string}-${string}-${string}-${string}`;
export declare const now: () => string;
export declare function canonical(value: unknown): string;
export declare const digest: (value: unknown) => string;
export declare function canonicalRepoRoot(cwd: string): Promise<string>;
export declare const projectKey: (cwd: string) => Promise<string>;
export declare function redactText(text: string): string;
export declare function redact<T>(value: T): T;
export declare function safeId(value: string): string;
/** Compare link metadata, not path spellings: Windows 8.3 aliases are not links. */
export declare function assertNoSymlinkRoot(path: string): Promise<void>;
export declare function contained(root: string, path: string, allowMissing?: boolean): Promise<string>;
export declare function atomicWrite(path: string, data: string | Uint8Array): Promise<void>;
export declare function bound(text: string, tokens: number): string;
