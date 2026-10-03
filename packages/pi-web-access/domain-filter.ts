/**
 * Domain filtering for search results.
 *
 * Only a few adapters implemented this locally, so a `domainFilter` that reached
 * Gemini, Kagi, AnySearch, Ollama or any other adapter without a local check was
 * silently ignored and excluded/off-domain results were returned anyway. Every
 * adapter now shares this implementation, and the search tool applies it centrally so
 * the filter holds regardless of which provider answered.
 */
export interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

export function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	return input || null;
}

export function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	for (const entry of domainFilter ?? []) {
		if (typeof entry !== "string") continue;
		const domain = normalizeDomain(entry);
		if (!domain) continue;
		const target = entry.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

export function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;

	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}

	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatchesDomain(hostname, domain))) {
		return false;
	}
	return !filters.blocked.some((domain) => hostMatchesDomain(hostname, domain));
}