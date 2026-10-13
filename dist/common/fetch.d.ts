export declare function fetchPinnedText(url: string, sha256: string, options?: {
    timeoutMs?: number;
    maxBytes?: number;
    fetch?: typeof fetch;
}): Promise<string>;
