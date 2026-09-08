import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici/index.js";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";

export const mode = process.argv[2];
assert.ok(mode === "native" || mode === "host");
const nativeRequest = globalThis.Request;
export const initialDispatcher = getGlobalDispatcher();
if (mode === "host") {
	configureHttpDispatcher();
	assert.notEqual(globalThis.Request, nativeRequest);
}
