import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { register, toolResult } from "./common/runtime.js";
import { createService, Longrun } from "./longrun.js";
import { GateRequirementSchema } from "./gate.js";
const Requirement = GateRequirementSchema;
export default function (pi: ExtensionAPI) {
  const runtime = register(pi, "pi-longrun", "longrun", createService);
  pi.on("session_start", async (_event, context) => {
    const host = await runtime.get(context);
    if (!host.config.disabledIntegrations.includes("pi-acceptance-gate"))
      await (host.service as Longrun).acceptanceGate
        .attach(context)
        .catch(() => {
          host.interop.failures++;
        });
  });
  pi.registerTool({
    name: "longrun_tasks",
    label: "Define tasks",
    description:
      "Define bounded tasks before execution. Evidence requirements are mandatory. Cannot change permissions or budgets.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String(),
          objective: Type.String(),
          dependencies: Type.Array(Type.String()),
          acceptance: Type.Array(Requirement),
          constraints: Type.Optional(Type.Array(Type.String())),
          scope: Type.Optional(
            Type.Object({
              paths: Type.Optional(Type.Array(Type.String())),
              readOnly: Type.Optional(Type.Boolean()),
              capabilities: Type.Optional(Type.Array(Type.String())),
            }),
          ),
        }),
        { minItems: 1, maxItems: 20 },
      ),
      evidenceId: Type.Optional(Type.String()),
    }),
    execute: async (_id, input, _signal, _update, ctx) => {
      const h = await runtime.get(ctx);
      return h.serial(async () =>
        toolResult(
          await (h.service as Longrun).replaceTasks(input.tasks, {
            evidenceId: input.evidenceId,
          }),
        ),
      );
    },
  });
  pi.registerTool({
    name: "longrun_status",
    label: "Run status",
    description: "Inspect verified work state and retrieve a bounded handoff.",
    parameters: Type.Object({}),
    execute: async (_id, _input, _signal, _update, ctx) => {
      const h = await runtime.get(ctx);
      return toolResult(await (h.service as Longrun).handoff());
    },
  });
  pi.registerTool({
    name: "longrun_gate_verify",
    label: "Verify configured objective gates",
    description:
      "Run the user-configured local checks. Cannot approve commands, change requirements or raise the repair budget.",
    parameters: Type.Object({}),
    execute: async (_id, _input, signal, _update, ctx) => {
      const host = await runtime.get(ctx);
      return host.serial(async () =>
        toolResult(await (host.service as Longrun).gates.verify(signal)),
      );
    },
  });
  pi.registerTool({
    name: "longrun_evidence",
    label: "Retrieve verified evidence",
    description: "Read bounded evidence belonging to the current run.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, input, _signal, _update, ctx) => {
      const host = await runtime.get(ctx);
      return toolResult(await (host.service as Longrun).evidence(input.id));
    },
  });
}
