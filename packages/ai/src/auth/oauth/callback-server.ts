import { formatThrownValue } from "../../utils/diagnostics.ts";

/**
 * A fixed-port OAuth callback server could not be started, e.g. because
 * something else already listens on the provider-registered callback port
 * (`EADDRINUSE`) or the host cannot be bound.
 *
 * Distinct from other login failures on purpose: the caller can report the real
 * reason, and flows that accept a pasted redirect URL or authorization code can
 * still finish without the local server.
 */
export class OAuthCallbackServerError extends Error {
	/** The redirect URI the local server was supposed to serve. */
	readonly callbackUrl: string;

	constructor(callbackUrl: string, cause: unknown) {
		super(`Could not start the OAuth callback server on ${callbackUrl}: ${formatThrownValue(cause)}`, { cause });
		this.name = "OAuthCallbackServerError";
		this.callbackUrl = callbackUrl;
	}
}
