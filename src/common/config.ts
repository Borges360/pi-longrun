import { Type, type Static } from "typebox";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite, canonical, contained } from "./security.js";
export const CommonConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    enabled: Type.Boolean(),
    mode: Type.Union([
      Type.Literal("auto"),
      Type.Literal("off"),
      Type.Literal("observe"),
    ]),
    storage: Type.Object({
      backend: Type.Union([
        Type.Literal("files"),
        Type.Literal("sqlite"),
        Type.Literal("durable"),
      ]),
      root: Type.String(),
    }),
    disabledIntegrations: Type.Array(Type.String()),
    maxActive: Type.Integer({ minimum: 1, maximum: 20 }),
    minScore: Type.Number({ minimum: 0, maximum: 1 }),
    maxSkillTokens: Type.Integer({ minimum: 100, maximum: 12000 }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
    maxAutomaticTurns: Type.Integer({ minimum: 0, maximum: 20 }),
    maxOpenTasks: Type.Integer({ minimum: 1, maximum: 100 }),
    maxReplans: Type.Integer({ minimum: 0, maximum: 10 }),
    maxInitialTasks: Type.Integer({ minimum: 1, maximum: 30 }),
    maxDependencyDepth: Type.Integer({ minimum: 1, maximum: 20 }),
    maxHandoffTokens: Type.Integer({ minimum: 100, maximum: 8000 }),
    maxEvidenceTokens: Type.Integer({ minimum: 100, maximum: 16000 }),
    compactAtRatio: Type.Number({ minimum: 0.1, maximum: 0.9 }),
    handoffAtRatio: Type.Number({ minimum: 0.2, maximum: 0.95 }),
    targetRatio: Type.Number({ minimum: 0.1, maximum: 0.9 }),
    maxCostUsd: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
    maxToolCalls: Type.Integer({ minimum: 1, maximum: 10000 }),
    maxParallel: Type.Integer({ minimum: 1, maximum: 8 }),
    maxDepth: Type.Integer({ minimum: 0, maximum: 3 }),
    maxChildrenPerTask: Type.Integer({ minimum: 1, maximum: 10 }),
    writeAccess: Type.Boolean(),
    childTimeoutMs: Type.Integer({ minimum: 100, maximum: 600000 }),
    maxChildTokens: Type.Integer({ minimum: 100, maximum: 32000 }),
    credentialEnv: Type.Array(Type.String()),
    skillRoots: Type.Array(Type.String()),
    agentRoots: Type.Array(Type.String()),
    trustedProject: Type.Boolean(),
    maxServersPerTask: Type.Integer({ minimum: 1, maximum: 8 }),
    maxDirectTools: Type.Integer({ minimum: 1, maximum: 50 }),
    defaultAccess: Type.Literal("deny"),
    preferReadOnly: Type.Boolean(),
    requireApproval: Type.Literal(true),
    assistantClaims: Type.Literal(false),
    requireEvidence: Type.Literal(true),
    defaultProfile: Type.Union([
      Type.Literal("standard"),
      Type.Literal("strict"),
    ]),
    maxRepairAttempts: Type.Integer({ minimum: 0, maximum: 3 }),
    gateTimeoutMs: Type.Integer({ minimum: 10, maximum: 600000 }),
  },
  { additionalProperties: false },
);
export type Config = Static<typeof CommonConfigSchema>;
export function defaults(extension: string): Config {
  const root = resolve(
    process.env.PI_ECOSYSTEM_STATE_ROOT ??
      join(homedir(), ".pi", "agent", "state"),
    extension,
  );
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "auto",
    storage: { backend: "files", root },
    disabledIntegrations: [],
    maxActive: 3,
    minScore: 0.55,
    maxSkillTokens: 2400,
    maxAttempts: 3,
    maxAutomaticTurns: 4,
    maxOpenTasks: 20,
    maxReplans: 2,
    maxInitialTasks: 12,
    maxDependencyDepth: 6,
    maxHandoffTokens: 1200,
    maxEvidenceTokens: 8000,
    compactAtRatio: 0.6,
    handoffAtRatio: 0.75,
    targetRatio: 0.45,
    maxCostUsd: null,
    maxToolCalls: 100,
    maxParallel: 2,
    maxDepth: 1,
    maxChildrenPerTask: 3,
    writeAccess: false,
    childTimeoutMs: 300000,
    maxChildTokens: 2000,
    credentialEnv: [],
    skillRoots: [join(homedir(), ".pi", "agent", "skills")],
    agentRoots: [join(homedir(), ".pi", "agent", "agents")],
    trustedProject: false,
    maxServersPerTask: 2,
    maxDirectTools: 12,
    defaultAccess: "deny",
    preferReadOnly: true,
    requireApproval: true,
    assistantClaims: false,
    requireEvidence: true,
    defaultProfile: "standard",
    maxRepairAttempts: 3,
    gateTimeoutMs: 600000,
  };
}
function check(
  schema: Record<string, unknown>,
  value: unknown,
  path = "config",
): void {
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(path + ":invalid-constant");
  if (Array.isArray(schema.anyOf)) {
    if (
      !schema.anyOf.some((s) => {
        try {
          check(s as Record<string, unknown>, value, path);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error(path + ":invalid-union");
    return;
  }
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(path + ":expected-object");
    const v = value as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const k of (schema.required as string[]) ?? [])
      if (!(k in v)) throw new Error(path + "." + k + ":required");
    for (const [k, val] of Object.entries(v)) {
      if (!props[k]) {
        if (schema.additionalProperties === false)
          throw new Error(path + "." + k + ":unknown");
      } else check(props[k], val, path + "." + k);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) throw new Error(path + ":expected-array");
    for (const v of value)
      check(schema.items as Record<string, unknown>, v, path);
  } else if (type === "null") {
    if (value !== null) throw new Error(path + ":expected-null");
  } else if (type === "integer" || type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value)) ||
      (schema.minimum !== undefined && value < (schema.minimum as number)) ||
      (schema.maximum !== undefined && value > (schema.maximum as number))
    )
      throw new Error(path + ":invalid-number");
  } else if (type && typeof value !== type)
    throw new Error(path + ":invalid-type");
}
export function validateConfig(c: unknown): Config {
  check(CommonConfigSchema as unknown as Record<string, unknown>, c);
  const config = c as Config;
  if (!(
    config.targetRatio < config.compactAtRatio &&
    config.compactAtRatio < config.handoffAtRatio
  ))
    throw new Error("context-threshold-order");
  return config;
}
export async function loadConfig(
  extension: string,
  cwd: string,
  trusted = false,
  override: Partial<Config> = {},
): Promise<Config> {
  const d = defaults(extension);
  let user: Partial<Config> = {};
  let project: Partial<Config> = {};
  try {
    user = JSON.parse(
      await readFile(join(d.storage.root, "config.json"), "utf8"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (trusted) {
    try {
      project = JSON.parse(
        await readFile(
          await contained(cwd, ".pi/" + extension + ".json", true),
          "utf8",
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  // Executable policy and privilege ceilings come only from user config or a user command.
  for (const key of [
    "storage",
    "credentialEnv",
    "skillRoots",
    "agentRoots",
    "writeAccess",
    "trustedProject",
    "maxCostUsd",
    "maxToolCalls",
    "maxAttempts",
    "maxAutomaticTurns",
    "maxParallel",
    "maxDepth",
    "maxChildrenPerTask",
    "requireApproval",
    "assistantClaims",
    "requireEvidence",
  ] as const)
    delete project[key];
  const ceilings = { ...d, ...user };
  for (const [key, value] of Object.entries(project)) {
    const ceiling = ceilings[key as keyof Config];
    if (
      key.startsWith("max") &&
      typeof ceiling === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      Object.assign(project, { [key]: Math.min(value, ceiling) });
  }
  project.disabledIntegrations = [
    ...new Set([
      ...(user.disabledIntegrations ?? []),
      ...(project.disabledIntegrations ?? []),
    ]),
  ];
  return validateConfig({
    ...d,
    ...user,
    ...project,
    ...override,
    storage: { ...d.storage, ...user.storage, ...override.storage },
  });
}
export async function saveConfig(extension: string, config: Config) {
  validateConfig(config);
  await atomicWrite(
    join(defaults(extension).storage.root, "config.json"),
    canonical(config),
  );
}
