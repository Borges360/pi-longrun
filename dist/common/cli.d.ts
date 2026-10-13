import { type ServiceFactory } from "./runtime.js";
import type { EventBus } from "./contracts.js";
export declare function localBus(): EventBus;
export declare function cli(extension: string, factory: ServiceFactory, args?: string[]): Promise<void>;
