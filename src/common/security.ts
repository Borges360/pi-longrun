import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, open, rename, unlink } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonical(value),
    )
    .digest("hex");
export async function canonicalRepoRoot(cwd: string): Promise<string> {
  const start = await realpath(cwd);
  let cursor = start;
  while (true) {
    try {
      await lstat(resolve(cursor, ".git"));
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return start;
    cursor = parent;
  }
}
export const projectKey = async (cwd: string) =>
  digest(await canonicalRepoRoot(cwd)).slice(0, 20);
const secretKey =
  /^(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|private[_-]?key)$/i;
export function redactText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    );
}
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) ? "[REDACTED]" : redact(v),
      ]),
    ) as T;
  return value;
}
export function safeId(value: string): string {
  if (
    [...Object.getOwnPropertyNames(Object.prototype), "prototype"].includes(
      value,
    )
  )
    throw new Error("unsafe-identifier");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value) ||
    value.includes("..") ||
    /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value)
  )
    throw new Error("unsafe-identifier");
  return value;
}
/** Compare link metadata, not path spellings: Windows 8.3 aliases are not links. */
export async function assertNoSymlinkRoot(path: string): Promise<void> {
  let cursor = resolve(path);
  while (true) {
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error("symlink-storage-root");
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
export async function contained(
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../")
  )
    throw new Error("path-escape");
  let cursor = base;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("symlink-escape");
    } catch (e) {
      if (!(allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT"))
        throw e;
    }
  }
  return target;
}
export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + id() + ".tmp";
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
export function bound(text: string, tokens: number): string {
  return redactText(text).slice(0, Math.max(0, tokens) * 3);
}
