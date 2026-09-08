interface OAuthTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope?: string;
}

/** Validate successful token responses before a login/refresh can publish credentials. */
export function parseOAuthTokenResponse(value: unknown, operation: string): OAuthTokenResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${operation} response has invalid token fields`);
	}
	const data = value as Record<string, unknown>;
	if (
		typeof data.access_token !== "string" ||
		data.access_token.trim().length === 0 ||
		typeof data.refresh_token !== "string" ||
		data.refresh_token.trim().length === 0 ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0 ||
		!Number.isFinite(Date.now() + data.expires_in * 1000) ||
		(data.scope !== undefined && typeof data.scope !== "string")
	) {
		// Do not echo the response: even a malformed response may contain usable secrets.
		throw new Error(`${operation} response has invalid token fields`);
	}
	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
		...(data.scope !== undefined ? { scope: data.scope } : {}),
	};
}
