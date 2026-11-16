import { type Component } from '@earendil-works/pi-tui';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
export interface PanelChoice {
    value: string;
    label: string;
}
export interface PanelApi {
    input(title: string, value: string): Promise<string | undefined>;
    choose(title: string, choices: PanelChoice[], current?: string): Promise<string | undefined>;
    confirm(title: string): Promise<boolean>;
    report(message: string): void;
    close(action?: string): void;
}
export interface PanelRow {
    id: string;
    label: string;
    value(): string;
    description: string;
    activate(panel: PanelApi, signal: AbortSignal): Promise<void> | void;
}
export interface PanelOptions {
    title: string;
    summary(): string;
    rows: PanelRow[];
    dirty(): boolean;
    signal: AbortSignal;
    save(panel: PanelApi, signal: AbortSignal): Promise<void>;
    formatError?(error: unknown): string;
    copy?: Partial<PanelCopy>;
}
export interface PanelCopy {
    back: string;
    authorize: string;
    operationCanceled: string;
    canceling: string;
    unsaved: string;
    operationFailed: string;
    working: string;
    dialogHints: string;
    footerHints: string;
}
type Factory = Parameters<ExtensionUIContext['custom']>[0];
type Keys = Parameters<Factory>[2];
type Theme = ExtensionUIContext['theme'];
/** Reusable Pi settings shell: draft, explicit commit, inline dialogs and scoped cleanup. */
export declare class SettingsPanel implements Component, PanelApi {
    private readonly options;
    private readonly theme;
    private readonly keys;
    private readonly renderRequest;
    private readonly done;
    private readonly rowsAvailable;
    private selected;
    private status;
    private busy?;
    private closed;
    private discardPending;
    private saveAfterEdit;
    private pending?;
    private dialog?;
    focused: boolean;
    private get copy();
    private readonly abort;
    constructor(options: PanelOptions, theme: Theme, keys: Keys, renderRequest: () => void, done: (action?: string) => void, rowsAvailable?: () => number);
    invalidate(): void;
    dispose(): void;
    close(action?: string): void;
    report(message: string): void;
    input(title: string, value: string): Promise<string | undefined>;
    choose(title: string, choices: PanelChoice[], current?: string): Promise<string | undefined>;
    confirm(title: string): Promise<boolean>;
    drain(): Promise<void>;
    private run;
    private execute;
    handleInput(data: string): void;
    render(width: number): string[];
}
export declare function openSettingsPanel(ui: ExtensionUIContext, options: PanelOptions): Promise<string | undefined>;
export {};
