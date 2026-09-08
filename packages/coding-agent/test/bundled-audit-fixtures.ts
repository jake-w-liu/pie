import type dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";

export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Socket/listen lookup boundary; these APIs always supply LookupOptions. */
export function fixtureLookup(addressFor: (hostname: string) => string): typeof dns.lookup {
	const lookup: LookupFunction = (hostname, options, callback) => {
		const address = addressFor(hostname);
		const family = isIP(address);
		if (options.all) callback(null, [{ address, family }]);
		else callback(null, address, family);
	};
	// Vitest retains only dns.lookup's last overload, not its options overloads.
	return lookup as typeof dns.lookup;
}
