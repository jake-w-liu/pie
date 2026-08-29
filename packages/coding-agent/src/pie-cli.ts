#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.PIE_CODING_AGENT = "true";
process.env.AI_AGENT = "pie";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(process.argv.slice(2));
