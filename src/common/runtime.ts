import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { loadConfig, saveConfig, type Config } from "./config.js";
import {
  FileStorage,
  SqliteStorage,
  type StorageBase,
  type PortableSnapshot,
} from "./storage.js";
import { DurableStorage } from "./durable.js";
import { Interop, type EventBus } from "./contracts.js";
import {
  loadProjectLanguage,
  resolveMessage,
  saveProjectLanguage,
  translate,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
} from "./i18n.js";
import {
  atomicWrite,
  canonical,
  digest,
  projectKey,
  redact,
} from "./security.js";
import {
  openSettingsPanel,
  type PanelCopy,
  type PanelOptions,
  type PanelRow,
} from "./settings-panel.js";

export interface CommandContext {
  cwd: string;
  trusted: boolean;
  signal?: AbortSignal;
  hostContext?: ExtensionContext;
  commandContext?: ExtensionCommandContext;
}
export interface Service {
  capabilities: string[];
  menu: string[];
  menuGroups?: Record<string, string[]>;
  menuInputs?: Record<string, string>;
  modeDescriptions?: Partial<Record<"auto" | "observe" | "off", string>>;
  command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown>;
  start?(): Promise<void>;
  close?(): Promise<void>;
  prompt?(prompt: string, context: ExtensionContext): Promise<unknown>;
  toolCall?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined>;
  toolResult?(event: unknown, context: ExtensionContext): Promise<void>;
  messageEnd?(event: unknown, context: ExtensionContext): Promise<void>;
  settle?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ continue?: boolean; entries?: unknown[] } | undefined>;
}
export type ServiceFactory = (host: Host) => Service;
export const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redact(value)) }],
  details: redact(value),
});
export class Host {
  config!: Config;
  uiLanguage: UiLanguage = "en";
  uiLanguageWarning?: "invalid" | "unavailable";
  store!: StorageBase;
  interop!: Interop;
  service!: Service;
  key = "";
  private started = false;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  migrationFault?: (phase: "after-seal" | "after-pointer") => void;
  constructor(
    readonly extension: string,
    readonly factory: ServiceFactory,
    readonly cwd: string,
    readonly bus: EventBus,
    readonly trusted = false,
    readonly api?: ExtensionAPI,
  ) {}
  async start() {
    if (this.started) return;
    if (!this.starting)
      this.starting = this.initialize().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async initialize() {
    try {
      await this.initializeResources();
    } catch (error) {
      this.interop?.close();
      await this.service?.close?.().catch(() => {});
      await this.store?.close().catch(() => {});
      throw error;
    }
  }
  private async initializeResources() {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted);
    if (this.extension === "pi-longrun") {
      const preference = await loadProjectLanguage(
        this.extension,
        this.cwd,
        this.trusted,
      );
      this.uiLanguage = preference.language;
      this.uiLanguageWarning = preference.warning;
    }
    this.key = await projectKey(this.cwd);
    const base = join(this.config.storage.root, "projects", this.key);
    await mkdir(base, { recursive: true, mode: 0o700 });
    let backend = this.config.storage.backend;
    let root = base;
    try {
      const pointer = JSON.parse(
        await readFile(join(base, "backend.json"), "utf8"),
      );
      if (
        !["files", "sqlite", "durable"].includes(pointer.backend) ||
        !/^migration-[a-zA-Z0-9-]+$/.test(pointer.directory)
      )
        throw new Error("invalid-backend-pointer");
      backend = pointer.backend;
      root = join(base, pointer.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.store =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await this.store.open();
    const metadata = await this.store.getMetadata();
    if (metadata.migratedTo) {
      // An old backend is only selected when the pointer switch did not commit.
      // Its own journal is still authoritative, so rollback never replays effects.
      if (metadata.migrationHost !== hostname() || !metadata.migrationPid)
        throw new Error("migration-owner-review-required");
      let dead = false;
      try {
        process.kill(metadata.migrationPid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) throw new Error("migration-in-progress");
      await this.store.rollbackMigration(metadata.migratedTo);
    }
    this.interop = new Interop(
      this.extension,
      this.bus,
      this.key,
      this.config.disabledIntegrations,
    );
    this.service = this.factory(this);
    await this.service.start?.();
    this.interop.start(this.service.capabilities);
    this.started = true;
  }
  async close() {
    await this.starting?.catch(() => {});
    if (!this.started) return;
    this.interop.close();
    await this.service.close?.();
    await this.store.close();
    this.started = false;
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async configure(patch: Partial<Config>) {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted, {
      ...this.config,
      ...patch,
    });
    await saveConfig(this.extension, this.config);
    return this.config;
  }
  async saveUiLanguage(language: UiLanguage) {
    if (this.extension !== "pi-longrun")
      throw new Error("language-setting-not-supported");
    await saveProjectLanguage(this.extension, this.cwd, this.trusted, language);
    this.uiLanguage = language;
    this.uiLanguageWarning = undefined;
  }
  async doctor() {
    const recovery = await this.store.recover();
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return {
      extension: this.extension,
      version:
        typeof manifest.version === "string" ? manifest.version : "unknown",
      pi: "1.2.0",
      node: process.versions.node,
      enabled: this.config.enabled,
      mode: this.config.mode,
      storage: this.store.constructor.name,
      recovery,
      integrations: {
        failures: this.interop.failures,
        fallbacks: this.interop.fallbacks,
        incompatible: this.interop.incompatible,
      },
      standalone: true,
    };
  }
  async command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown> {
    if (action === "doctor") return this.doctor();
    if (action === "config") return this.config;
    if (action === "off" || action === "auto" || action === "observe")
      return this.configure({ enabled: action !== "off", mode: action });
    if (action === "storage")
      return args[0] === "migrate"
        ? this.migrate(args[1])
        : {
            backend: this.store.constructor.name,
            root: this.store.options.root,
          };
    return this.service.command(action, args, context);
  }
  async migrate(backend?: string) {
    if (backend !== "files" && backend !== "sqlite" && backend !== "durable")
      throw new Error("supported-backends: files, sqlite, durable");
    const activeChildren = await this.store.listRecords<{ status: string }>(
      "children",
    );
    const activeRuns = await this.store.listRecords<{ status: string }>("runs");
    if (
      activeChildren.some((c) => c.status === "running") ||
      activeRuns.some((r) => r.status === "active")
    )
      throw new Error("pause-active-work-before-migration");
    const sourceStore = this.store;
    const migrationId = crypto.randomUUID();
    const base = join(this.config.storage.root, "projects", this.key);
    const directory = "migration-" + migrationId;
    const root = join(base, directory);
    const target =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await target.open();
    let switched = false;
    let sealed = false;
    let previousPointer: string | undefined;
    try {
      previousPointer = await readFile(join(base, "backend.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      await this.store.transact(async (source) => {
        const frozen = structuredClone(source);
        const logical = (s: PortableSnapshot) =>
          digest({
            metadata: s.metadata,
            records: s.records,
            events: s.events,
            blobs: s.blobs,
          });
        await target.importSnapshot(frozen);
        if (logical(await target.exportSnapshot()) !== logical(frozen))
          throw new Error("migration-parity-failed");
        await target.recover();
        source.metadata.migratedTo = root;
        source.metadata.migrationPid = process.pid;
        source.metadata.migrationHost = hostname();
      });
      sealed = true;
      this.migrationFault?.("after-seal");
      await atomicWrite(
        join(base, "backend.json"),
        canonical({
          schemaVersion: 1,
          backend,
          directory,
          migrationId,
          sourceRoot: this.store.options.root,
        }),
      );
      switched = true;
      this.migrationFault?.("after-pointer");
      await target.recover();
      await this.service.close?.();
      this.store = target;
      // Services capture Host, never a stale store handle; restart listeners after backend replacement.
      this.interop.close();
      this.interop = new Interop(
        this.extension,
        this.bus,
        this.key,
        this.config.disabledIntegrations,
      );
      this.service = this.factory(this);
      await this.service.start?.();
      this.interop.start(this.service.capabilities);
      await sourceStore.close();
      return { migrationId, backend, verified: true, backupPreserved: true };
    } catch (e) {
      if (switched) {
        if (previousPointer)
          await atomicWrite(join(base, "backend.json"), previousPointer);
        else await unlink(join(base, "backend.json"));
      }
      this.store = sourceStore;
      if (sealed) await sourceStore.rollbackMigration(root);
      await target.close();
      throw e;
    }
  }
}
export function register(
  pi: ExtensionAPI,
  extension: string,
  command: string,
  factory: ServiceFactory,
  tools: ToolDefinition[] = [],
) {
  let host: Host | undefined;
  const get = async (ctx: ExtensionContext) => {
    if (
      !host ||
      host.cwd !== ctx.cwd ||
      (extension === "pi-longrun" && host.trusted !== ctx.isProjectTrusted())
    ) {
      await host?.close();
      host = new Host(
        extension,
        factory,
        ctx.cwd,
        pi.events,
        ctx.isProjectTrusted(),
        pi,
      );
      await host.start();
    }
    await host.start();
    return host;
  };
  const show = (value: unknown, feedback?: string) =>
    pi.sendMessage({
      customType: extension,
      content: `${feedback ? `${feedback}\n\n` : ""}${JSON.stringify(
        redact(value),
        null,
        2,
      )}`,
      display: true,
    });
  pi.on("session_start", async (_e, ctx) => {
    await get(ctx);
  });
  pi.on("session_shutdown", async () => {
    await host?.close();
    host = undefined;
  });
  pi.registerCommand(command, {
    description: `${extension}: status, explain, mode/config, doctor`,
    handler: async (args, ctx) => {
      const h = await get(ctx);
      const interactive = ctx.mode === "tui" && ctx.hasUI;
      const localized = extension === "pi-longrun";
      let uiLanguage = localized ? h.uiLanguage : "en";
      const t = (key: MessageKey, params: MessageParams = {}) => {
        if (!localized) return translate("en", key, params);
        const message = resolveMessage(uiLanguage, key, params);
        if (message.usedFallback) h.uiLanguageWarning = "unavailable";
        return message.text;
      };
      const displayNames: Record<string, string> = {
        longrun: "Longrun",
        autoskills: "AutoSkills",
        autoplan: "AutoPlan",
        subagents: "Subagent Router",
        mcprouter: "MCP Router",
      };
      const displayName = localized
        ? t("appName")
        : displayNames[command] ?? extension;
      const sourceGroups = h.service.menuGroups ?? {
        Actions: h.service.menu,
        Settings: ["mode", "doctor"],
      };
      const groups = Object.fromEntries(
        Object.entries(sourceGroups).map(([group, actions]) => [group, [...actions]]),
      );
      const hasLanguageSetting = localized && h.trusted;
      if (localized && groups.Settings && hasLanguageSetting && !groups.Settings.includes("language"))
        groups.Settings.push("language");
      const groupKeys: Record<string, MessageKey> = {
        Execution: "groupExecution",
        Progress: "groupProgress",
        Recovery: "groupRecovery",
        Settings: "groupSettings",
        Actions: "groupActions",
      };
      const actionKeys: Record<string, MessageKey> = {
        status: "actionStatus",
        start: "actionStart",
        pause: "actionPause",
        resume: "actionResume",
        stop: "actionStop",
        tasks: "actionTasks",
        inspect: "actionInspect",
        verify: "actionVerify",
        "gate status": "actionGateStatus",
        "gate verify": "actionGateVerify",
        recover: "actionRecover",
        mode: "actionMode",
        doctor: "actionDoctor",
        language: "actionLanguage",
      };
      const groupLabel = (group: string) =>
        localized && groupKeys[group] ? t(groupKeys[group]!) : group;
      const actionLabel = (action: string) =>
        localized && actionKeys[action] ? t(actionKeys[action]!) : action;
      const appTitle = displayName;
      const modes = ["auto", "observe", "off"] as const;
      type Mode = "auto" | "observe" | "off";
      const currentMode = (): Mode =>
        !h.config.enabled || h.config.mode === "off"
          ? "off"
          : h.config.mode === "observe"
            ? "observe"
            : "auto";
      const modeLabel = (mode: string) =>
        mode === "observe"
          ? t("modeObserve")
          : mode === "off"
            ? t("modeOff")
            : t("modeAuto");
      const modeOptions = () =>
        modes.map((action) => ({
          action,
          label: modeLabel(action),
          description:
            action === "auto"
              ? localized
                ? t("modeAutoDescription")
                : h.service.modeDescriptions?.auto ??
                  "Continue eligible runs within saved budgets and acceptance gates."
              : action === "observe"
                ? localized
                  ? t("modeObserveDescription")
                  : h.service.modeDescriptions?.observe ??
                    "Show Longrun decisions without continuing runs automatically."
                : localized
                  ? t("modeOffDescription")
                  : h.service.modeDescriptions?.off ??
                    "Disable Longrun automatic behavior.",
        }));
      const languageOptions = () =>
        ([
          { value: "en" as const, label: t("languageEnglish") },
          { value: "pt-BR" as const, label: t("languagePortuguese") },
        ]) as { value: UiLanguage; label: string }[];
      const languageLabel = (language: UiLanguage) =>
        language === "pt-BR" ? t("languagePortuguese") : t("languageEnglish");
      const warningText = () =>
        h.uiLanguageWarning === "invalid"
          ? t("languageWarningInvalid")
          : h.uiLanguageWarning === "unavailable"
            ? t("languageWarningUnavailable")
            : "";
      const panelCopy = (): PanelCopy => ({
        back: t("panelBack"),
        authorize: t("panelAuthorize"),
        operationCanceled: t("panelOperationCanceled"),
        canceling: t("panelCanceling"),
        unsaved: t("panelUnsaved"),
        operationFailed: t("panelOperationFailed"),
        working: t("panelWorking"),
        dialogHints: t("panelDialogHints"),
        footerHints: t("panelFooterHints"),
      });
      const inputTitleFor = (action: string) =>
        localized && action === "start"
          ? t("inputGoal")
          : h.service.menuInputs?.[action];
      const commandContext = (signal?: AbortSignal) => ({
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        hostContext: ctx,
        commandContext: ctx,
        signal,
      });

      const saveModeDraft = async (mode: Mode, signal: AbortSignal) => {
        await h.serial(() => h.command(mode, [], commandContext(signal)));
      };

      const fallbackModePanel = async () => {
        while (true) {
          const savedMode = currentMode();
          const options = modeOptions();
          const selected = await ctx.ui.select(
            localized
              ? t("modeCurrent", { app: appTitle, mode: modeLabel(savedMode) })
              : `${displayName} / Settings / Mode — current: ${modeLabel(savedMode)}`,
            options.map((option) => option.label),
          );
          if (!selected) return;
          const draft = options.find((option) => option.label === selected);
          if (!draft) return;
          const decision = await ctx.ui.select(
            localized
              ? t("modeDraftTitle", { mode: draft.label })
              : `Mode draft: ${draft.label}`,
            localized
              ? [t("modeSaveDraft"), t("modeDiscardDraft")]
              : ["Save draft", "Discard draft"],
          );
          if (decision !== (localized ? t("modeSaveDraft") : "Save draft"))
            continue;
          try {
            await saveModeDraft(
              draft.action as Mode,
              ctx.signal ?? new AbortController().signal,
            );
            return;
          } catch {
            ctx.ui.notify(
              localized
                ? t("modeSaveNotice")
                : "Could not save the mode draft. It is still available.",
            );
          }
        }
      };

      const fallbackLanguagePanel = async () => {
        if (!hasLanguageSetting) return;
        const options = languageOptions();
        const selected = await ctx.ui.select(
          t("languageCurrent", {
            app: appTitle,
            language: options.find((option) => option.value === h.uiLanguage)?.label ?? options[0]!.label,
          }),
          options.map((option) => option.label),
        );
        const draft = options.find((option) => option.label === selected);
        if (!draft) return;
        const decision = await ctx.ui.select(
          t("languageDraftTitle", { language: draft.label }),
          [t("modeSaveDraft"), t("modeDiscardDraft")],
        );
        if (decision !== t("modeSaveDraft")) return;
        try {
          await h.saveUiLanguage(draft.value);
          uiLanguage = draft.value;
          ctx.ui.notify(t("languageSaved", { language: draft.label }));
        } catch {
          ctx.ui.notify(t("languageSaveNotice"));
        }
      };

      const runFallbackMenu = async (initialGroup?: string) => {
        let group = initialGroup;
        while (true) {
          if (!group) {
            const rootTitle = warningText()
              ? `${displayName} — ${warningText()}`
              : displayName;
            const selectedGroup = await ctx.ui.select(
              rootTitle,
              Object.keys(groups).map(groupLabel),
            );
            if (!selectedGroup) return;
            group = Object.keys(groups).find(
              (candidate) => groupLabel(candidate) === selectedGroup,
            );
            if (!group) return;
          }
          const selected = await ctx.ui.select(
            `${displayName} / ${groupLabel(group)}`,
            (groups[group] ?? []).map(actionLabel),
          );
          if (!selected) {
            group = undefined;
            continue;
          }
          const selectedAction = (groups[group] ?? []).find(
            (candidate) => actionLabel(candidate) === selected,
          );
          if (!selectedAction) continue;
          if (selectedAction === "mode" || selectedAction === "config") {
            await fallbackModePanel();
            continue;
          }
          if (selectedAction === "language") {
            await fallbackLanguagePanel();
            continue;
          }
          const parts = selectedAction.split(/\s+/);
          const inputTitle = inputTitleFor(selectedAction);
          if (inputTitle) {
            const value = await ctx.ui.input(inputTitle);
            if (!value?.trim()) continue;
            parts.push(value.trim());
          }
          const action = parts.shift() ?? "status";
          const result = await h.serial(() =>
            h.command(action, parts, commandContext(ctx.signal)),
          );
          show(result);
        }
      };

      const showDashboard = async (initialGroup?: string) => {
        if (typeof ctx.ui.custom !== "function") {
          await runFallbackMenu(initialGroup);
          return;
        }
        let draftMode: Mode = currentMode();
        let savedMode: Mode = draftMode;
        let draftLanguage = h.uiLanguage;
        let savedLanguage = draftLanguage;
        const menuGroups = initialGroup
          ? { [initialGroup]: groups[initialGroup] ?? [] }
          : groups;
        const rows: PanelRow[] = [];
        const refreshRows = () => {
          const nextRows: PanelRow[] = Object.entries(menuGroups).map(
            ([group, actions]) => ({
              id: `group:${group}`,
              label: groupLabel(group),
              value: () =>
                localized
                  ? t("menuActionsCount", { count: actions.length })
                  : `${actions.length} actions`,
              description: localized
                ? t("menuOpenGroup", { group: groupLabel(group).toLowerCase() })
                : `Open ${group.toLowerCase()} actions.`,
            activate: async (panel, signal) => {
              const selected = await panel.choose(
                `${displayName} / ${groupLabel(group)}`,
                actions.map((action) => ({ value: action, label: actionLabel(action) })),
              );
              if (!selected) return;
              if (selected === "mode" || selected === "config") {
                const options = modeOptions();
                const mode = await panel.choose(
                  localized
                    ? t("modeTitle", { app: appTitle })
                    : `${displayName} / Settings / Mode`,
                  options.map((option) => ({
                    value: option.action,
                    label: option.label,
                  })),
                  draftMode,
                );
                if (!mode) return;
                draftMode = mode as Mode;
                panel.report(
                  localized
                    ? t("modeDraft", { mode: modeLabel(draftMode) })
                    : `Mode draft: ${modeLabel(draftMode)}. Ctrl+S saves the change.`,
                );
                return;
              }
              if (selected === "language" && hasLanguageSetting) {
                const options = languageOptions();
                const selectedLanguage = await panel.choose(
                  t("languageTitle", { app: appTitle }),
                  options,
                  draftLanguage,
                );
                if (!selectedLanguage) return;
                draftLanguage = selectedLanguage as UiLanguage;
                uiLanguage = draftLanguage;
                refreshRows();
                settings.copy = panelCopy();
                settings.title = initialGroup
                  ? `${displayName} / ${groupLabel(initialGroup)}`
                  : displayName;
                panel.report(
                  t("languageDraft", {
                    language:
                      options.find((option) => option.value === draftLanguage)?.label ??
                      draftLanguage,
                  }),
                );
                return;
              }
              const parts = selected.split(/\s+/);
              const inputTitle = inputTitleFor(selected);
              if (inputTitle) {
                const value = await panel.input(inputTitle, "");
                if (!value?.trim() || signal.aborted) return;
                parts.push(value.trim());
              }
              const action = parts.shift() ?? "status";
              const result = await h.serial(() =>
                h.command(action, parts, commandContext(signal)),
              );
              if (signal.aborted) return;
              show(result);
              panel.report(
                localized
                  ? t("completed", { action: actionLabel(selected) })
                  : `${selected} completed; its result is shown above.`,
              );
            },
            }),
          );
          rows.splice(0, rows.length, ...nextRows);
        };
        refreshRows();
        const settings: PanelOptions = {
          title: initialGroup
            ? `${displayName} / ${groupLabel(initialGroup)}`
            : displayName,
          summary: () => {
            const drafts: string[] = [];
            if (draftMode !== savedMode)
              drafts.push(t("menuDraftSuffix", { value: modeLabel(draftMode) }));
            if (draftLanguage !== savedLanguage)
              drafts.push(
                t("menuDraftSuffix", { value: languageLabel(draftLanguage) }),
              );
            const summary = localized
              ? t("menuSummary", {
                  mode: modeLabel(savedMode),
                  language: languageLabel(savedLanguage),
                  draft: drafts.join(" "),
                })
              : `Mode: ${modeLabel(savedMode)}${draftMode !== savedMode ? ` → draft ${modeLabel(draftMode)}` : ""}`;
            const warning = warningText();
            return warning ? `${summary} · ${warning}` : summary;
          },
          rows,
          dirty: () => draftMode !== savedMode || draftLanguage !== savedLanguage,
          signal: ctx.signal ?? new AbortController().signal,
          ...(localized ? { copy: panelCopy() } : {}),
          save: async (panel, signal) => {
            if (draftMode === savedMode && draftLanguage === savedLanguage) {
              panel.report(localized ? t("modeNoUnsaved") : "No unsaved settings.");
              return;
            }
            const languageChanged = draftLanguage !== savedLanguage;
            const modeChanged = draftMode !== savedMode;
            if (languageChanged) {
              await h.saveUiLanguage(draftLanguage);
              savedLanguage = draftLanguage;
              uiLanguage = draftLanguage;
              h.uiLanguageWarning = undefined;
              settings.copy = panelCopy();
              refreshRows();
            }
            const next = draftMode;
            if (modeChanged) {
              await saveModeDraft(next, signal);
              savedMode = next;
            }
            panel.report(
              localized
                ? languageChanged && modeChanged
                  ? t("settingsSaved")
                  : languageChanged
                    ? t("languageSaved", { language: languageLabel(savedLanguage) })
                    : t("modeSaved", { mode: modeLabel(savedMode) })
                : `Saved: ${modeLabel(savedMode)}.`,
            );
          },
          formatError: () =>
            localized
              ? draftLanguage !== savedLanguage
                ? t("languageSaveError")
                : t("modeSaveError")
              : "Could not save the mode. The draft is still available. Try again.",
        };
        await openSettingsPanel(ctx.ui, settings);
      };

      let parts = args.trim().split(/\s+/).filter(Boolean);
      if (interactive && parts.length === 0) {
        await showDashboard();
        return;
      }
      let action = parts.shift() ?? "status";
      if (action === "mode") action = "config";
      if (action === "config" && interactive) {
        await showDashboard("Settings");
        return;
      }
      const result = await h.serial(() =>
        h.command(action, parts, {
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
          hostContext: ctx,
          commandContext: ctx,
          signal: ctx.signal,
        }),
      );
      show(result);
    },
  });
  for (const t of tools)
    pi.registerTool({
      ...t,
      execute: async (callId, input, signal, onUpdate, ctx) => {
        await get(ctx);
        return t.execute(callId, input, signal, onUpdate, ctx);
      },
    });
  pi.on("before_agent_start", async (e, ctx) => {
    const h = await get(ctx);
    if (
      !h.config.enabled ||
      h.config.mode === "off" ||
      e.messageType !== "user"
    )
      return;
    const value = await h.serial(
      () => h.service.prompt?.(e.prompt, ctx) ?? Promise.resolve(undefined),
    );
    if (value !== undefined)
      return {
        message: {
          customType: extension,
          content: JSON.stringify(redact(value)),
          display: false,
        },
      };
  });
  pi.on("tool_call", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      return h.serial(
        () => h.service.toolCall?.(e, ctx) ?? Promise.resolve(undefined),
      );
  });
  pi.on("tool_result", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      await h.serial(() => h.service.toolResult?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("message_end", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      await h.serial(() => h.service.messageEnd?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("agent_before_settle", async (e, ctx) => {
    const h = await get(ctx);
    if (!h.config.enabled || h.config.mode === "observe") return;
    return (await h.serial(
      () => h.service.settle?.(e, ctx) ?? Promise.resolve(undefined),
    )) as { continue?: boolean } | undefined;
  });
  return { get };
}
