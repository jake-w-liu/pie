import { parseDocument, stringify as stringifyYaml } from "yaml";

/**
 * Normalize a simple-scalar frontmatter list from comma-separated or block-list syntax.
 * Only the standard `- item` marker is removed; ordinary hyphenated values stay intact.
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * Parse YAML frontmatter from agent/chain files.
 * Handles both flat (key: value) and nested block (key: \n  sub: val) values.
 * Block values are stored as single strings with embedded newlines.
 * The indentation of the block content is preserved relative to the key.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };

	// The closing delimiter may start at offset 3, which is the very newline that ends the
	// opening `---` line: an empty frontmatter block has no bytes between the delimiters.
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: {}, body: normalized };

	const block = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	const document = parseDocument(block, {
		schema: "core",
		merge: false,
		uniqueKeys: true,
	});
	if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]!.message}`);
	// maxAliasCount is a toJS option: 0 refuses aliases outright, so an anchor-bomb
	// frontmatter cannot expand exponentially while the document is converted.
	const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
	// An empty or comment-only block is a valid empty mapping, not a malformed file.
	if (parsed === null || parsed === undefined) return { frontmatter: {}, body };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid YAML frontmatter: expected a mapping.");
	}

	const frontmatter: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === null || value === undefined) frontmatter[key] = "";
		else if (typeof value === "string") frontmatter[key] = value;
		else if (typeof value === "number" || typeof value === "boolean") frontmatter[key] = String(value);
		else frontmatter[key] = stringifyYaml(value, { schema: "core" }).trimEnd();
	}
	return { frontmatter, body };
}
