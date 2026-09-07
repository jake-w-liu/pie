/**
 * Build-boundary declarations for the vendored built-in extensions.
 *
 * Referenced ONLY by `tsconfig.build.json` (emit build) via its `paths`
 * mapping. The dev config (`tsconfig.json`) excludes this directory so editor
 * checks and `tsgo --noEmit` keep resolving the real workspace sources, and
 * the bundler ignores `tsconfig` paths entirely (`tsconfigRaw: {}`), so
 * `esbuild` follows the literal dynamic imports in `./index.ts` and emits
 * the packages as transpiled chunks. The declared shapes must stay in sync
 * with each package's default export; `test/builtin-extensions.test.ts`
 * loads every entry and asserts the registrations.
 */
declare module "@earendil-works/pi-ext-fff" {
	import type { ExtensionFactory } from "../core/extensions/types.ts";
	const factory: ExtensionFactory;
	export default factory;
}

declare module "@earendil-works/pi-ext-subagents" {
	import type { ExtensionFactory } from "../core/extensions/types.ts";
	const factory: ExtensionFactory;
	export default factory;
}

declare module "@earendil-works/pi-ext-web-access" {
	import type { ExtensionFactory } from "../core/extensions/types.ts";
	const factory: ExtensionFactory;
	export default factory;
}
