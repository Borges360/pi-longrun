import { digest } from "./security.js";
export async function fetchPinnedText(url, sha256, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        throw new Error("https-source-without-credentials-required");
    if (!/^[a-f0-9]{64}$/.test(sha256))
        throw new Error("expected-sha256-required");
    const response = await (options.fetch ?? fetch)(url, {
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
    });
    if (!response.ok || !response.body)
        throw new Error("source-fetch-failed");
    const max = options.maxBytes ?? 262144;
    if (Number(response.headers.get("content-length")) > max)
        throw new Error("source-too-large");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > max)
                throw new Error("source-too-large");
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel();
    }
    const data = Buffer.concat(chunks);
    if (digest(data) !== sha256)
        throw new Error("provenance-hash-mismatch");
    return data.toString("utf8");
}
