import { readFile } from "node:fs/promises";
import { atomicWrite, canonical, contained } from "./security.js";

export const UI_LANGUAGES = ["en", "pt-BR"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

const english = {
  appName: "Longrun",
  groupExecution: "Execution",
  groupProgress: "Progress",
  groupRecovery: "Recovery",
  groupSettings: "Settings",
  groupActions: "Actions",
  actionStatus: "Status",
  actionStart: "Start",
  actionPause: "Pause",
  actionResume: "Resume",
  actionStop: "Stop",
  actionTasks: "Tasks",
  actionInspect: "Inspect",
  actionVerify: "Verify",
  actionGateStatus: "Gate status",
  actionGateVerify: "Gate verify",
  actionRecover: "Recover",
  actionMode: "Mode",
  actionDoctor: "Doctor",
  actionLanguage: "Language",
  modeAuto: "Automatic",
  modeObserve: "Observe",
  modeOff: "Off",
  modeAutoDescription:
    "Continue eligible runs within saved budgets and acceptance gates.",
  modeObserveDescription:
    "Show Longrun decisions without continuing runs automatically.",
  modeOffDescription: "Disable automatic Longrun behavior.",
  menuActionsCount: "{count} actions",
  menuOpenGroup: "Open {group} actions.",
  menuSummary: "Mode: {mode} · Language: {language}{draft}",
  menuDraftSuffix: " → draft {value}",
  inputGoal: "Goal to complete",
  modeTitle: "{app} / Settings / Mode",
  modeCurrent: "{app} / Settings / Mode — current: {mode}",
  modeDraft: "Mode draft: {mode}. Ctrl+S saves the change.",
  modeDraftTitle: "Mode draft: {mode}",
  modeSaveDraft: "Save draft",
  modeDiscardDraft: "Discard draft",
  modeNoUnsaved: "No unsaved settings.",
  modeSaved: "Saved: {mode}.",
  modeSaveError:
    "Could not save the mode. The draft is still available. Try again.",
  modeSaveNotice: "Could not save the mode draft. It is still available.",
  languageTitle: "{app} / Settings / Language",
  languageCurrent: "{app} / Settings / Language — current: {language}",
  languageEnglish: "English",
  languagePortuguese: "Português (Brasil)",
  languageDraft: "Language draft: {language}. Ctrl+S saves the change.",
  languageDraftTitle: "Language draft: {language}",
  languageSaved: "Language saved for this project: {language}.",
  settingsSaved: "Settings saved.",
  languageSaveNotice:
    "Could not save the language. The draft is still available.",
  languageSaveError:
    "Could not save the language. The draft is still available. Try again.",
  languageWarningInvalid: "Invalid project language; using English.",
  languageWarningUnavailable:
    "A translation is missing; English text is shown for that item.",
  languageTrustedOnly:
    "Language preferences can only be saved for a trusted project.",
  languageProjectOnly: "This preference applies only to the current project.",
  completed: "{action} completed; its result is shown above.",
  panelBack: "Back",
  panelAuthorize: "Authorize",
  panelOperationCanceled: "Operation canceled.",
  panelCanceling: "Canceling…",
  panelUnsaved:
    "Unsaved changes. Ctrl+S saves; press Esc again to discard.",
  panelOperationFailed: "Operation failed. Try again.",
  panelWorking: "Working… Esc cancels the operation.",
  panelDialogHints: "↑↓ choose · Enter confirm · Esc back",
  panelFooterHints: "↑↓ navigate · Enter edit/open · Ctrl+S save · Esc close",
  fallbackSelect: "Select",
} as const;

const portuguese: Record<keyof typeof english, string> = {
  appName: "Longrun",
  groupExecution: "Execução",
  groupProgress: "Progresso",
  groupRecovery: "Recuperação",
  groupSettings: "Configurações",
  groupActions: "Ações",
  actionStatus: "Status",
  actionStart: "Iniciar",
  actionPause: "Pausar",
  actionResume: "Retomar",
  actionStop: "Parar",
  actionTasks: "Tarefas",
  actionInspect: "Inspecionar",
  actionVerify: "Verificar",
  actionGateStatus: "Status das barreiras",
  actionGateVerify: "Verificar barreiras",
  actionRecover: "Recuperar",
  actionMode: "Modo",
  actionDoctor: "Diagnóstico",
  actionLanguage: "Idioma",
  modeAuto: "Automático",
  modeObserve: "Observar",
  modeOff: "Desativado",
  modeAutoDescription:
    "Continua execuções elegíveis dentro dos limites salvos e das barreiras de aceitação.",
  modeObserveDescription:
    "Mostra decisões do Longrun sem continuar execuções automaticamente.",
  modeOffDescription: "Desativa o comportamento automático do Longrun.",
  menuActionsCount: "{count} ações",
  menuOpenGroup: "Abrir ações de {group}.",
  menuSummary: "Modo: {mode} · Idioma: {language}{draft}",
  menuDraftSuffix: " → rascunho {value}",
  inputGoal: "Objetivo a concluir",
  modeTitle: "{app} / Configurações / Modo",
  modeCurrent: "{app} / Configurações / Modo — atual: {mode}",
  modeDraft: "Rascunho do modo: {mode}. Ctrl+S salva a alteração.",
  modeDraftTitle: "Rascunho do modo: {mode}",
  modeSaveDraft: "Salvar rascunho",
  modeDiscardDraft: "Descartar rascunho",
  modeNoUnsaved: "Não há configurações pendentes.",
  modeSaved: "Salvo: {mode}.",
  modeSaveError:
    "Não foi possível salvar o modo. O rascunho continua disponível. Tente novamente.",
  modeSaveNotice:
    "Não foi possível salvar o rascunho do modo. Ele continua disponível.",
  languageTitle: "{app} / Configurações / Idioma",
  languageCurrent: "{app} / Configurações / Idioma — atual: {language}",
  languageEnglish: "English",
  languagePortuguese: "Português (Brasil)",
  languageDraft: "Rascunho do idioma: {language}. Ctrl+S salva a alteração.",
  languageDraftTitle: "Rascunho do idioma: {language}",
  languageSaved: "Idioma salvo para este projeto: {language}.",
  settingsSaved: "Configurações salvas.",
  languageSaveNotice:
    "Não foi possível salvar o idioma. O rascunho continua disponível.",
  languageSaveError:
    "Não foi possível salvar o idioma. O rascunho continua disponível. Tente novamente.",
  languageWarningInvalid: "Idioma do projeto inválido; usando inglês.",
  languageWarningUnavailable:
    "Falta uma tradução; o texto em inglês será mostrado neste item.",
  languageTrustedOnly:
    "A preferência de idioma só pode ser salva em um projeto confiável.",
  languageProjectOnly: "Esta preferência vale somente para o projeto atual.",
  completed: "{action} concluído; o resultado está acima.",
  panelBack: "Voltar",
  panelAuthorize: "Autorizar",
  panelOperationCanceled: "Operação cancelada.",
  panelCanceling: "Cancelando…",
  panelUnsaved:
    "Há alterações não salvas. Ctrl+S salva; pressione Esc novamente para descartar.",
  panelOperationFailed: "A operação falhou. Tente novamente.",
  panelWorking: "Em andamento… Esc cancela a operação.",
  panelDialogHints: "↑↓ escolher · Enter confirmar · Esc voltar",
  panelFooterHints: "↑↓ navegar · Enter editar/abrir · Ctrl+S salvar · Esc fechar",
  fallbackSelect: "Selecionar",
};

export type MessageKey = keyof typeof english;
export type MessageParams = Record<string, string | number>;
export type Catalog = Record<MessageKey, string>;

const catalogs: Record<UiLanguage, Catalog> = {
  en: english,
  "pt-BR": portuguese,
};

const placeholders = (value: string) =>
  [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((match) => match[1]!)
    .sort();

export function catalogParity(): { keys: boolean; placeholders: boolean } {
  const englishKeys = Object.keys(english).sort();
  const portugueseKeys = Object.keys(portuguese).sort();
  const keys =
    englishKeys.length === portugueseKeys.length &&
    englishKeys.every((key, index) => key === portugueseKeys[index]);
  const samePlaceholders = englishKeys.every((key) =>
    placeholders(english[key as MessageKey]).join("\0") ===
    placeholders(portuguese[key as MessageKey]).join("\0"),
  );
  return { keys, placeholders: keys && samePlaceholders };
}

export function resolveMessage(
  language: UiLanguage,
  key: MessageKey,
  params: MessageParams = {},
  source: Partial<Record<UiLanguage, Partial<Catalog>>> = catalogs,
): { text: string; usedFallback: boolean } {
  const requested = source[language]?.[key];
  const fallback = source.en?.[key] ?? english[key];
  const usedFallback = typeof requested !== "string";
  const template = typeof requested === "string" ? requested : fallback;
  const text = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
  return { text, usedFallback };
}

export const translate = (
  language: UiLanguage,
  key: MessageKey,
  params: MessageParams = {},
) => resolveMessage(language, key, params).text;

export function parseUiLanguage(value: unknown): UiLanguage | undefined {
  return value === "en" || value === "pt-BR" ? value : undefined;
}

export async function loadProjectLanguage(
  extension: string,
  cwd: string,
  trusted: boolean,
): Promise<{ language: UiLanguage; warning?: "invalid" }> {
  if (!trusted) return { language: "en" };
  const path = await contained(cwd, `.pi/${extension}.json`, true);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { language: "en" };
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return { language: "en", warning: "invalid" };
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    return { language: "en", warning: "invalid" };
  const language = parseUiLanguage((config as Record<string, unknown>).uiLanguage);
  if (language) return { language };
  return Object.hasOwn(config, "uiLanguage")
    ? { language: "en", warning: "invalid" }
    : { language: "en" };
}

export async function saveProjectLanguage(
  extension: string,
  cwd: string,
  trusted: boolean,
  language: UiLanguage,
): Promise<void> {
  if (!trusted) throw new Error("project-not-trusted");
  if (!parseUiLanguage(language)) throw new Error("invalid-ui-language");
  const path = await contained(cwd, `.pi/${extension}.json`, true);
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid-project-config");
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(path, canonical({ ...current, uiLanguage: language }));
}

