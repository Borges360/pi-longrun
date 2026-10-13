import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { contained, digest, id, now, redactText } from "./security.js";
import { put } from "./storage.js";
export function testReportPassed(text, format) {
    if (format === "json") {
        const report = JSON.parse(text);
        if (!Number.isInteger(report.tests) ||
            report.tests <= 0 ||
            !Number.isInteger(report.failures) ||
            report.failures < 0 ||
            !Number.isInteger(report.errors ?? 0) ||
            (report.errors ?? 0) < 0 ||
            !Number.isInteger(report.skipped ?? 0) ||
            (report.skipped ?? 0) < 0 ||
            (report.skipped ?? 0) > report.tests)
            throw new Error("malformed-test-report");
        return (report.failures === 0 &&
            (report.errors ?? 0) === 0 &&
            (report.skipped ?? 0) < report.tests);
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
        throw new Error("malformed-test-report");
    const parsed = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        parseAttributeValue: false,
        processEntities: false,
    }).parse(text);
    let tests = 0, failed = 0, suites = 0;
    const walk = (node, key = "") => {
        if (key === "failure" || key === "error")
            failed++;
        if (Array.isArray(node)) {
            for (const child of node)
                walk(child, key);
            return;
        }
        if (!node || typeof node !== "object")
            return;
        const object = node;
        if (key === "testsuite") {
            suites++;
            const count = Number(object["@_tests"]), failures = Number(object["@_failures"] ?? 0), errors = Number(object["@_errors"] ?? 0), skipped = Number(object["@_skipped"] ?? 0);
            if (!Number.isInteger(count) ||
                count < 0 ||
                !Number.isInteger(failures) ||
                failures < 0 ||
                !Number.isInteger(errors) ||
                errors < 0 ||
                !Number.isInteger(skipped) ||
                skipped < 0 ||
                skipped > count)
                throw new Error("malformed-test-report");
            tests += count - skipped;
            failed += failures + errors;
        }
        for (const [name, value] of Object.entries(object))
            if (!name.startsWith("@_"))
                walk(value, name);
    };
    walk(parsed);
    if (!suites)
        throw new Error("malformed-test-report");
    return tests > 0 && failed === 0;
}
export async function runCommand(executable, args, options) {
    const start = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    const cap = options.maxOutputBytes ?? 262144;
    if (options.signal?.aborted)
        throw new Error("cancelled");
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true,
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        const kill = () => {
            if (!child.pid)
                return;
            if (process.platform === "win32")
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                    windowsHide: true,
                    stdio: "ignore",
                }).on("error", () => child.kill("SIGKILL"));
            else {
                try {
                    process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    child.kill("SIGKILL");
                }
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, options.timeoutMs);
        options.signal?.addEventListener("abort", kill, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", kill);
        };
        child.stdout.on("data", (b) => {
            const take = Math.max(0, Math.min(b.length, cap - captured));
            stdout = Buffer.concat([stdout, b.subarray(0, take)]);
            captured += take;
            if (take < b.length)
                truncated = true;
        });
        child.stderr.on("data", (b) => {
            const take = Math.max(0, Math.min(b.length, cap - captured));
            stderr = Buffer.concat([stderr, b.subarray(0, take)]);
            captured += take;
            if (take < b.length)
                truncated = true;
        });
        child.on("error", (e) => {
            cleanup();
            reject(e);
        });
        child.on("close", (code) => {
            cleanup();
            resolve({
                exitCode: code,
                stdout: redactText(stdout.toString("utf8")),
                stderr: redactText(stderr.toString("utf8")),
                durationMs: Date.now() - start,
                timedOut,
                truncated,
            });
        });
    });
}
export function selectProfile(risks, hasSideEffects = true, small = false) {
    return risks.length
        ? "strict"
        : !hasSideEffects
            ? "none"
            : small
                ? "fast"
                : "standard";
}
export function completionAllowed(requirements, results) {
    const required = requirements.filter((r) => r.required);
    if (!required.length)
        return false;
    return required.every((r) => results.some((g) => g.requirementId === r.id &&
        g.evaluated &&
        g.verified &&
        !g.rejected &&
        !!g.evidenceRef &&
        !!g.outputDigest));
}
export class GateVerifier {
    store;
    cwd;
    policy;
    constructor(store, cwd, policy) {
        this.store = store;
        this.cwd = cwd;
        this.policy = policy;
    }
    async verify(requirement, profile, signal, context = {}) {
        const start = Date.now();
        const result = {
            schemaVersion: 1,
            id: id(),
            requirementId: requirement.id,
            profile,
            evaluated: false,
            verified: false,
            rejected: true,
            durationMs: 0,
            taskId: context.taskId,
            attempt: context.attempt,
        };
        let output = "";
        let completedIntent;
        try {
            if (requirement.kind === "command") {
                const approval = this.policy.approvedCommands.find((c) => c.executable === requirement.executable &&
                    JSON.stringify(c.args) === JSON.stringify(requirement.args ?? []));
                if (!requirement.executable || !approval)
                    throw new Error("command-not-approved");
                const scopeId = context.scopeId ?? context.taskId ?? context.runId ?? "standalone";
                const pending = (await this.store.listRecords("gate-intents")).find((intent) => intent.scopeId === scopeId &&
                    intent.requirementId === requirement.id &&
                    !intent.settled &&
                    intent.replay !== "safe");
                if (pending)
                    throw new Error("needs-gate-side-effect-review:" + pending.id);
                const intent = {
                    ...context,
                    id: result.id,
                    requirementId: requirement.id,
                    scopeId,
                    settled: false,
                    replay: approval.replay ?? "never-automatic",
                    createdAt: now(),
                };
                await this.store.putRecord("gate-intents", intent.id, intent);
                const command = await runCommand(requirement.executable, requirement.args ?? [], {
                    cwd: this.cwd,
                    timeoutMs: Math.min(requirement.timeoutMs ?? this.policy.timeoutMs, this.policy.timeoutMs),
                    maxOutputBytes: this.policy.maxOutputBytes,
                    signal,
                });
                output = JSON.stringify(command);
                result.exitCode = command.exitCode ?? undefined;
                result.evaluated = true;
                result.verified =
                    command.exitCode === 0 && !command.timedOut && !signal?.aborted;
                result.reason = command.timedOut ? "timeout" : undefined;
                if ((!command.timedOut &&
                    command.exitCode !== null &&
                    !signal?.aborted) ||
                    intent.replay === "safe") {
                    intent.settled = true;
                    completedIntent = intent;
                }
                else
                    result.reason = "needs-gate-side-effect-review:" + intent.id;
                if (result.verified && requirement.report) {
                    const reportText = await readFile(await contained(this.cwd, requirement.report.path), "utf8");
                    if (Buffer.byteLength(reportText) > this.policy.maxOutputBytes)
                        throw new Error("test-report-too-large");
                    result.verified = testReportPassed(reportText, requirement.report.format);
                    output = JSON.stringify({
                        command,
                        report: {
                            sha256: digest(reportText),
                            format: requirement.report.format,
                            passed: result.verified,
                        },
                    });
                }
            }
            else if (requirement.kind === "artifact") {
                if (!requirement.path || !requirement.sha256)
                    throw new Error("artifact-requires-path-and-expected-hash");
                const data = await readFile(await contained(this.cwd, requirement.path));
                output = JSON.stringify({
                    path: requirement.path,
                    sha256: digest(data),
                    bytes: data.length,
                });
                result.evaluated = true;
                result.verified = digest(data) === requirement.sha256;
            }
            else if (requirement.kind === "human") {
                result.evaluated = true;
                result.verified = this.policy.approvedHumans.includes(requirement.id);
                if (!result.verified)
                    result.reason = "human-approval-required";
                output = JSON.stringify({
                    approval: requirement.id,
                    approved: result.verified,
                });
            }
            else
                throw new Error("unknown-requirement");
        }
        catch (e) {
            result.verified = false;
            result.reason = e.message;
            output = result.reason;
        }
        const blob = await this.store.writeBlob(result.id, Buffer.from(output));
        result.evidenceRef = blob.id;
        result.outputDigest = blob.sha256;
        result.rejected = !result.verified;
        result.durationMs = Date.now() - start;
        await this.store.transact((snapshot) => {
            put(snapshot, "evidence", result.id, {
                ...blob,
                kind: requirement.kind,
                verified: result.verified,
                createdAt: now(),
            });
            put(snapshot, "gates", result.id, result);
            if (completedIntent)
                put(snapshot, "gate-intents", completedIntent.id, completedIntent);
        });
        return result;
    }
}
