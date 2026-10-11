import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			assert: "node:assert",
			buffer: "node:buffer",
			events: "node:events",
			http: "node:http",
			https: "node:https",
			net: "node:net",
			stream: "node:stream",
			string_decoder: "node:string_decoder",
			tls: "node:tls",
			url: "node:url",
			util: "node:util",
			zlib: "node:zlib",
		},
	},
});
