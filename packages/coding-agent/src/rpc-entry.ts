#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { pinInstallation } from "./core/installation-pin.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
pinInstallation();
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
