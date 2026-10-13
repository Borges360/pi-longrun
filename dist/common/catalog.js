import { readdir, readFile, realpath, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicWrite, bound, contained, digest, safeId } from "./security.js";
import { fetchPinnedText } from "./fetch.js";
export function audit(text, source) {
    const rules = [
        [
            "instruction-override",
            /ignore (?:all |the )?(?:previous|prior|system) instructions|disregard.*(?:system|safety)/i,
        ],
        [
            "secret-exfiltration",
            /(?:curl|wget|fetch\s*\()[\s\S]{0,160}(?:\.env|api.?key|token|credential)/i,
        ],
        [
            "private-credential-access",
            /(?:\.ssh\/id_|auth\.json|mcp-auth\.json|BEGIN .*PRIVATE KEY)/i,
        ],
        [
            "obfuscated-execution",
            /(?:eval\s*\(|base64\s+-d|Invoke-Expression|iex\s*\()/i,
        ],
        [
            "destructive-command",
            /rm\s+-rf\s+\/|Remove-Item[^\n]*-Recurse[^\n]*["']?[A-Z]:\\["']?\s*$/im,
        ],
    ];
    const findings = rules
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name);
    return {
        schemaVersion: 1,
        sha256: digest(text),
        passed: !findings.length,
        findings,
        source,
    };
}
export function frontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match)
        return { metadata: {}, body: text };
    const metadata = parse(match[1]);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        throw new Error("invalid-frontmatter");
    return {
        metadata: metadata,
        body: text.slice(match[0].length),
    };
}
export async function discoverSkills(roots) {
    const catalog = [];
    const seen = new Set();
    for (const root of roots) {
        let entries;
        try {
            entries = await readdir(root.path, { withFileTypes: true });
        }
        catch (e) {
            if (e.code === "ENOENT")
                continue;
            throw e;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isSymbolicLink())
                continue;
            const path = entry.isDirectory()
                ? join(entry.name, "SKILL.md")
                : entry.name;
            if (!entry.isDirectory() && !/\.md$/i.test(entry.name))
                continue;
            try {
                const file = await contained(root.path, path);
                const stats = await lstat(file);
                if (stats.size > 262144)
                    continue;
                const text = await readFile(file, "utf8");
                const { metadata: m } = frontmatter(text);
                const skillId = String(m.name ??
                    (entry.isDirectory()
                        ? entry.name
                        : entry.name.replace(/\.md$/i, "")));
                safeId(skillId);
                if (seen.has(skillId))
                    continue;
                seen.add(skillId);
                const words = (value) => Array.isArray(value)
                    ? value.map(String)
                    : typeof value === "string"
                        ? value.split(/[, ]+/).filter(Boolean)
                        : [];
                catalog.push({
                    schemaVersion: 1,
                    id: skillId,
                    name: String(m.name ?? skillId),
                    description: String(m.description ?? ""),
                    keywords: words(m.keywords),
                    paths: words(m.paths),
                    stack: words(m.stack),
                    kind: m.kind === "playbook" ? "playbook" : "skill",
                    file,
                    sha256: digest(text),
                    trusted: root.trusted && audit(text, file).passed,
                    provenance: root.path,
                });
            }
            catch (e) {
                if (e.code === "ENOENT")
                    continue;
                if (e.message === "symlink-escape")
                    continue;
                throw e;
            }
        }
    }
    return catalog;
}
export async function discoverAgents(roots) {
    const result = [];
    for (const root of roots) {
        let names;
        try {
            names = await readdir(root.path);
        }
        catch (e) {
            if (e.code === "ENOENT")
                continue;
            throw e;
        }
        for (const name of names.sort()) {
            if (!name.endsWith(".md"))
                continue;
            const file = await contained(root.path, name);
            const text = await readFile(file, "utf8");
            const { metadata: m, body } = frontmatter(text);
            const key = String(m.name ?? name.slice(0, -3));
            safeId(key);
            if (result.some((a) => a.id === key))
                continue;
            result.push({
                schemaVersion: 1,
                id: key,
                description: String(m.description ?? ""),
                instructions: bound(body, 4000),
                readOnly: m.readOnly !== false,
                paths: Array.isArray(m.paths) ? m.paths.map(String) : [],
                provider: typeof m.provider === "string" ? m.provider : undefined,
                model: typeof m.model === "string" ? m.model : undefined,
                trusted: root.trusted && audit(text, file).passed,
            });
        }
    }
    return result;
}
export async function installSkill(source, expectedSha256, targetRoot, skillId) {
    safeId(skillId);
    const sourceFile = source.startsWith("https://")
        ? source
        : await realpath(source);
    const text = source.startsWith("https://")
        ? await fetchPinnedText(source, expectedSha256)
        : await readFile(sourceFile, "utf8");
    const result = audit(text, sourceFile);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) ||
        result.sha256 !== expectedSha256)
        throw new Error("provenance-hash-mismatch");
    if (!result.passed)
        throw new Error("audit-failed:" + result.findings.join(","));
    const { metadata } = frontmatter(text);
    if (!metadata.name ||
        !metadata.description ||
        String(metadata.name) !== skillId)
        throw new Error("skill-metadata-required");
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const directory = await contained(targetRoot, skillId, true);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await contained(targetRoot, join(skillId, "SKILL.md"), true);
    await atomicWrite(file, text);
    await atomicWrite(await contained(targetRoot, join(skillId, "manifest.json"), true), JSON.stringify({
        schemaVersion: 1,
        id: skillId,
        sha256: result.sha256,
        source: sourceFile,
        audited: true,
    }, null, 2));
    return result;
}
