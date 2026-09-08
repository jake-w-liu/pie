/** Release a response abandoned before body iteration, preserving the original request failure. */
export async function cancelResponseBody(response: { body?: unknown } | undefined): Promise<void> {
	try {
		const body = response?.body;
		if (!body || typeof body !== "object") return;
		if ("cancel" in body && typeof body.cancel === "function") await body.cancel();
		else if ("destroy" in body && typeof body.destroy === "function") body.destroy();
	} catch {
		// SDK iterators may already have cancelled/errored the body or still own its reader.
	}
}
