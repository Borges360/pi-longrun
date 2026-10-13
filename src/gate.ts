import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type } from "typebox";
import type { Host, CommandContext } from "./common/runtime.js";
import {
  GateVerifier,
  completionAllowed,
  selectProfile,
  type GateProfile,
  type AcceptanceRequirement,
  type GatePolicy,
  type GateResult,
  type GateIntent,
} from "./common/gates.js";
import { assess } from "./common/contracts.js";
import { contained, id, now, digest, bound } from "./common/security.js";
export const GateRequirementSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  kind: Type.Union([
    Type.Literal("command"),
    Type.Literal("artifact"),
    Type.Literal("human"),
  ]),
  required: Type.Boolean(),
  executable: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  path: Type.Optional(Type.String()),
  sha256: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 10, maximum: 600000 })),
  report: Type.Optional(
    Type.Object({
      format: Type.Union([Type.Literal("junit"), Type.Literal("json")]),
      path: Type.String(),
    }),
  ),
});
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
export function validateGateSet(input: unknown): GateSet {
  const set = input as GateSet;
  if (
    set?.schemaVersion !== 1 ||
    typeof set.id !== "string" ||
    !/^[-a-zA-Z0-9_]+$/.test(set.id) ||
    typeof set.objective !== "string" ||
    !set.objective.trim() ||
    !Array.isArray(set.requirements) ||
    !set.requirements.length ||
    set.requirements.length > 20 ||
    !set.requirements.some((r) => r.required)
  )
    throw new Error("invalid-gate-set");
  if (
    new Set(set.requirements.map((r) => r.id)).size !== set.requirements.length
  )
    throw new Error("duplicate-gate-requirement");
  for (const requirement of set.requirements) {
    if (
      typeof requirement.id !== "string" ||
      !/^[-a-zA-Z0-9_]+$/.test(requirement.id) ||
      typeof requirement.required !== "boolean" ||
      !["command", "artifact", "human"].includes(requirement.kind)
    )
      throw new Error("invalid-gate-requirement");
    if (
      requirement.kind === "command" &&
      (!requirement.executable ||
        !Array.isArray(requirement.args) ||
        requirement.args.some((arg) => typeof arg !== "string"))
    )
      throw new Error("invalid-command-requirement");
    if (
      requirement.kind === "artifact" &&
      (!requirement.path ||
        !requirement.sha256 ||
        !/^[a-f0-9]{64}$/.test(requirement.sha256))
    )
      throw new Error("invalid-artifact-requirement");
    if (
      requirement.report &&
      (!["json", "junit"].includes(requirement.report.format) ||
        typeof requirement.report.path !== "string")
    )
      throw new Error("invalid-report-requirement");
  }
  return set;
}
export function profileWithFloor(
  requested: GateProfile,
  risks: string[],
): GateProfile {
  return risks.length ? "strict" : requested;
}
export class LocalGate {
  constructor(readonly host: Host) {}
  async currentSet() {
    return this.host.store.getRecord<GateSet>("gate-settings", "requirements");
  }
  async last() {
    const ref = await this.host.store.getRecord<{ id: string }>(
      "gate-settings",
      "last",
    );
    return ref ? this.host.store.getRecord<GateRun>("gate-runs", ref.id) : null;
  }
  async policy(attempt?: number): Promise<GatePolicy> {
    const set = await this.currentSet();
    const key = set ? digest(set) : "none";
    const prior = await this.host.store.getRecord<{ attempt: number }>(
      "gate-attempts",
      key,
    );
    const prefix =
      "standalone:" + key + ":" + (attempt ?? (prior?.attempt ?? 0) + 1) + ":";
    const policy = (await this.host.store.getRecord<GatePolicy>(
      "policy",
      "gates",
    )) ?? {
      approvedCommands: [],
      approvedHumans: [],
      timeoutMs: this.host.config.gateTimeoutMs,
      maxOutputBytes: 262144,
    };
    return {
      ...policy,
      approvedHumans: policy.approvedHumans
        .filter((value) => value.startsWith(prefix))
        .map((value) => value.slice(prefix.length)),
    };
  }
  async discover() {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(
        await readFile(await contained(this.host.cwd, "package.json"), "utf8"),
      );
      scripts = pkg.scripts ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const npmCli = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    let hasNpmCli = false;
    try {
      await readFile(npmCli);
      hasNpmCli = true;
    } catch {}
    const names = [
      "lint",
      "typecheck",
      "test",
      "test:unit",
      "test:integration",
      "test:security",
    ].filter((name) => typeof scripts[name] === "string");
    return {
      schemaVersion: 1,
      source: "package.json",
      trustedProject: this.host.trusted,
      requirements: names.map((name) => ({
        id: name.replace(/:/g, "-"),
        kind: "command" as const,
        required: true,
        executable: hasNpmCli ? process.execPath : "npm",
        args: hasNpmCli ? [npmCli, "run", name] : ["run", name],
      })),
      execution:
        "Requires explicit command approvals; discovery never runs project scripts.",
    };
  }
  async verify(signal?: AbortSignal): Promise<GateRun> {
    const set = await this.currentSet();
    if (!set) throw new Error("configure-gate-requirements-first");
    const requested =
      (await this.host.store.getRecord<GateProfile>(
        "gate-settings",
        "profile",
      )) ?? this.host.config.defaultProfile;
    const profile = profileWithFloor(requested, assess(set.objective).risks);
    const key = digest(set);
    const prior = await this.host.store.getRecord<{ attempt: number }>(
      "gate-attempts",
      key,
    );
    const attempt = (prior?.attempt ?? 0) + 1;
    if (attempt > this.host.config.maxRepairAttempts + 1)
      throw new Error("manual-review-required");
    await this.host.store.putRecord("gate-attempts", key, { attempt });
    const verifier = new GateVerifier(
      this.host.store,
      this.host.cwd,
      await this.policy(attempt),
    );
    const results: GateResult[] = [];
    for (const requirement of set.requirements) {
      const result = await verifier.verify(requirement, profile, signal, {
        scopeId: "standalone-" + set.id,
        attempt,
      });
      results.push(result);
      this.host.interop.emit("pi.gate.result.v1", result, {
        correlationId: set.id,
      });
    }
    const blocked = results.some(
      (result) =>
        !result.evaluated ||
        result.reason?.includes("approval-required") ||
        result.reason?.startsWith("needs-gate-side-effect-review"),
    );
    const run: GateRun = {
      schemaVersion: 1,
      id: id(),
      setId: set.id,
      profile,
      status: completionAllowed(set.requirements, results)
        ? "passed"
        : blocked
          ? "blocked"
          : "failed",
      attempt,
      results,
      createdAt: now(),
    };
    await this.host.store.putRecord("gate-runs", run.id, run);
    await this.host.store.putRecord("gate-settings", "last", { id: run.id });
    return run;
  }
  async command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown> {
    if (action === "status")
      return { requirements: await this.currentSet(), last: await this.last() };
    if (action === "discover") return this.discover();
    if (action === "configure") {
      if (!args[0]) throw new Error("gate-set-json-required");
      const set = validateGateSet(
        JSON.parse(
          await readFile(await contained(context.cwd, args[0]), "utf8"),
        ),
      );
      await this.host.store.putRecord("gate-settings", "requirements", set);
      return set;
    }
    if (action === "verify") return this.verify(context.signal);
    if (action === "profile") {
      if (args[0]) {
        if (!["none", "fast", "standard", "strict"].includes(args[0]))
          throw new Error("unknown-gate-profile");
        await this.host.store.putRecord("gate-settings", "profile", args[0]);
      }
      const requested =
        (await this.host.store.getRecord<GateProfile>(
          "gate-settings",
          "profile",
        )) ?? this.host.config.defaultProfile;
      const set = await this.currentSet();
      return {
        requested,
        effective: profileWithFloor(
          requested,
          set ? assess(set.objective).risks : [],
        ),
      };
    }
    if (action === "explain")
      return {
        invariant:
          "Required objective evidence; assistant claims never pass a gate.",
        last: await this.last(),
        profile: await this.command("profile", [], context),
      };
    if (action === "evidence") {
      if (!args[0]) return this.host.store.listRecords("evidence");
      const bytes = await this.host.store.readBlob(args[0]);
      return bytes
        ? {
            id: args[0],
            output: bound(
              Buffer.from(bytes).toString("utf8"),
              this.host.config.maxEvidenceTokens,
            ),
          }
        : null;
    }
    if (action === "resolve") {
      if (!args[0]) throw new Error("gate-intent-required");
      const intent = await this.host.store.getRecord<GateIntent>(
        "gate-intents",
        args[0],
      );
      if (!intent || !intent.scopeId.startsWith("standalone-"))
        throw new Error("standalone-gate-intent-required");
      intent.settled = true;
      await this.host.store.putRecord("gate-intents", intent.id, intent);
      return { reviewed: intent.id };
    }
    if (action === "approve-human") {
      if (!args[0]) throw new Error("requirement-id-required");
      const policy = (await this.host.store.getRecord<GatePolicy>(
        "policy",
        "gates",
      )) ?? {
        approvedCommands: [],
        approvedHumans: [],
        timeoutMs: this.host.config.gateTimeoutMs,
        maxOutputBytes: 262144,
      };
      const set = await this.currentSet();
      if (!set) throw new Error("configure-gate-requirements-first");
      const key = digest(set);
      const prior = await this.host.store.getRecord<{ attempt: number }>(
        "gate-attempts",
        key,
      );
      policy.approvedHumans.push(
        "standalone:" + key + ":" + ((prior?.attempt ?? 0) + 1) + ":" + args[0],
      );
      await this.host.store.putRecord("policy", "gates", policy);
      return { approved: args[0] };
    }
    if (action === "doctor" || action === "config")
      return this.host.command(action, args, context);
    throw new Error("unknown-gate-command:" + action);
  }
}
