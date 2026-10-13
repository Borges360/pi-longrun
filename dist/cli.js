#!/usr/bin/env node
import { cli } from "./common/cli.js";
import { createService } from "./longrun.js";
await cli("pi-longrun", createService);
