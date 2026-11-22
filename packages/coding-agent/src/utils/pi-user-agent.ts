function userAgent(product: string, version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `${product}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

export function getPiUserAgent(version: string): string {
	return userAgent("pi", version);
}

/**
 * User agent for the pi.dev model catalog.
 *
 * pi.dev content-negotiates catalogs on the `pi/<version>` token: it returns a
 * frozen snapshot to older Pi releases and the current catalog to clients that
 * do not claim a `pi/` version. Pie restarts versioning at 0.1, so a `pi/`
 * claim is either rejected outright or pins the fork to a snapshot older than
 * its own bundled catalog. Identify as Pie instead; the fetched entries are
 * validated against the checked-out model schema before use.
 */
export function getPiCatalogUserAgent(version: string): string {
	return userAgent("pie", version);
}
