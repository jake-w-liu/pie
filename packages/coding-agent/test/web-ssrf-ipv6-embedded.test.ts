import { describe, expect, it, vi } from "vitest";
import { validateRemoteUrl } from "../../pi-web-access/ssrf-protection.ts";

// The guard resolves ssrf.allowRanges from a config file path captured at import
// time, so point it at a directory that holds no web-search.json before the
// module under test loads. Nothing is written there, so there is nothing to clean.
vi.hoisted(() => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/pie-ssrf-guard-${process.pid}-${Date.now()}`;
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PIE_CODING_AGENT_DIR", dir);
	for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
		vi.stubEnv(key, "");
	}
});

type LookupAnswers = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Validate with the transport proxy forced off so only the address guard decides. */
function validate(url: string, lookup?: LookupAnswers): Promise<URL> {
	return validateRemoteUrl(url, { proxy: "", ...(lookup ? { lookup } : {}) });
}

describe("SSRF guard IPv4-embedded IPv6 literals", () => {
	it.each([
		["IPv4-mapped loopback ::ffff:a.b.c.d (RFC 4291)", "http://[::ffff:127.0.0.1]/"],
		["IPv4-mapped link-local ::ffff:a.b.c.d", "http://[::ffff:169.254.169.254]/"],
		["IPv4-compatible loopback ::a.b.c.d (RFC 4291)", "http://[::127.0.0.1]/"],
		["IPv4-compatible link-local ::a.b.c.d", "http://[::169.254.169.254]/"],
		["NAT64 well-known 64:ff9b::/96 loopback", "http://[64:ff9b::7f00:1]/"],
		["NAT64 well-known 64:ff9b::/96 link-local", "http://[64:ff9b::a9fe:a9fe]/"],
		["NAT64 well-known 64:ff9b::/96 private", "http://[64:ff9b::c0a8:101]/"],
		["NAT64 local-use 64:ff9b:1::/48 link-local", "http://[64:ff9b:1:a9fe:a9fe::]/"],
		["6to4 2002::/16 loopback", "http://[2002:7f00:1::]/"],
		["6to4 2002::/16 link-local", "http://[2002:a9fe:a9fe::]/"],
		["Teredo 2001::/32 server loopback", "http://[2001:0:7f00:1::]/"],
		["Teredo 2001::/32 server link-local", "http://[2001:0:a9fe:a9fe::]/"],
		["IPv4-translatable ::ffff:0:0:0/96 loopback (RFC 6145)", "http://[::ffff:0:7f00:1]/"],
		["IPv4-translatable ::ffff:0:0:0/96 link-local", "http://[::ffff:0:a9fe:a9fe]/"],
		["IPv4-translatable ::ffff:0:0:0/96 private", "http://[::ffff:0:c0a8:101]/"],
		["multicast ff02::1", "http://[ff02::1]/"],
		["multicast ff0e::1", "http://[ff0e::1]/"],
		["deprecated site-local fec0::1", "http://[fec0::1]/"],
		["discard-only 100::1", "http://[100::1]/"],
		["documentation 2001:db8::1", "http://[2001:db8::1]/"],
	])("blocks %s", async (_form, url) => {
		await expect(validate(url)).rejects.toThrow("Blocked internal address");
	});

	it.each([
		["IPv4-compatible public", "http://[::808:808]/"],
		["NAT64 well-known public", "http://[64:ff9b::808:808]/"],
		["NAT64 local-use public", "http://[64:ff9b:1:808:808::]/"],
		["6to4 public", "http://[2002:808:808::]/"],
		["Teredo public server", "http://[2001:0:808:808::]/"],
		["unrelated IPv6", "http://[2001:4860:4860::8888]/"],
		["IPv4-translatable public", "http://[::ffff:0:808:808]/"],
		["ordinary global unicast", "http://[2a00:1450:4001:81f::200e]/"],
	])("allows %s", async (_form, url) => {
		await expect(validate(url)).resolves.toBeInstanceOf(URL);
	});

	it("blocks a resolved AAAA answer that embeds an internal IPv4", async () => {
		const lookup = async () => [{ address: "64:ff9b::7f00:1", family: 6 }];
		await expect(validate("http://translated.invalid/", lookup)).rejects.toThrow("Blocked internal address");
	});

	it("still honours ssrf.allowRanges per literal form", async () => {
		const allowed = validateRemoteUrl("http://[64:ff9b::7f00:1]/", { proxy: "", allowRanges: ["64:ff9b::/96"] });
		await expect(allowed).resolves.toBeInstanceOf(URL);
		const wrongRange = validateRemoteUrl("http://[64:ff9b::7f00:1]/", { proxy: "", allowRanges: ["2002::/16"] });
		await expect(wrongRange).rejects.toThrow("Blocked internal address");
	});
});
