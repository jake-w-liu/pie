# Remote fetch boundaries

Protected HTTP fetching validates the target hostname and every resolved IP, then passes only those approved addresses to the connection's lookup. The URL hostname, HTTP Host and TLS certificate/SNI verification are preserved. Each redirect is checked again; authenticated fetching uses the same transport and refuses cross-origin redirects before obtaining cookies for another URL. `ssrf.allowRanges` explicitly exempts address ranges, including local test or fake-IP proxy networks; use narrow ranges.

## Proxy trust

Local DNS validation cannot constrain a proxy's destination lookup. Protected fetching therefore refuses a selected proxy unless `ssrf.trustEnvProxy` is explicitly `true` in `web-search.json`:

```json
{
  "proxy": "http://127.0.0.1:8080",
  "ssrf": { "trustEnvProxy": true }
}
```

Despite its historical name, `trustEnvProxy` authorizes remote DNS at the **actually selected** HTTP(S) proxy: per-call `proxy`, scoped proxy, configured proxy, or environment proxy. Trust includes that proxy's handling of hostnames resolving to internal addresses. Literal IP targets, localhost restrictions and domain policy are still checked. Do not opt in for an untrusted proxy.

An explicit empty per-call/scoped proxy forces direct connections. Localhost and matching `NO_PROXY` entries bypass proxies and use local address validation/pinning; trust never exempts a bypassed target. Per-call/scoped decisions override configuration and environment. Protected fetching routes a trusted environment proxy itself rather than assuming a global Fetch implementation will honor it. This policy does not add an SSRF gate to unrelated provider API calls through global Fetch.

## Streaming and runtimes

Proxy transport uses the existing Undici dependency, not curl or temporary body files. Bodies remain streaming; extraction readers apply their own decoded-byte caps (including PDF-specific caps). Protected URL/auth and Gemini redirect loops cancel intermediate or rejected responses; extraction also cancels rejected/oversized bodies. Generic Fetch retains its implementation's automatic redirect draining and has no extraction cap. Transfer failure rejects body consumption, rather than returning truncated success. Per-request web transport leases close their dispatchers; generic Fetch callers must consume or cancel final responses. The shared host dispatcher remains host-owned.

Bundled CLI/RPC startup installs the pinned npm Undici Fetch and its Request/Response constructors on both Node and Bun. The public `undici/index.js` package entry avoids Bun's bare-`undici` compatibility shim. Protected URL and authenticated requests invoke that imported npm transport directly, even if global Fetch was replaced. They retain per-redirect validation, proxy selection and DNS pinning.

On Bun, npm Undici's response error propagation is affected by Bun's public Web-stream state APIs. The shared `fetchWithResponseErrors` owner observes public dispatcher errors and request-controller aborts, forwarding actual transport/decompression/abort failures into a native response body and canceling the original reader. It retains npm connection binding, decoding and backpressure without buffering, private runtime patches or a native-network fallback. Clones preserve response metadata, guarded network headers and independent public header properties. Native Fetch calls that do not use the dispatcher are returned unchanged. Request reuse still rejects, but Bun 1.4.2's npm Undici `Request.bodyUsed` can remain false after consumption, just as with the unwrapped library; callers must not rely on that upstream flag on this runtime.

Global proxy wrapping preserves a foreign Request's original body/replay/keepalive metadata through the compatible Fetch captured at installation, including host and extension Undici versions that differ. The wrapper passes both supported routing options: Node/npm Undici honors `dispatcher`, while standalone native Bun honors `proxy`. No body getter, stream conversion or manual replay is used. Generic Fetch callers must create Requests compatible with either that captured Fetch or the extension's own imported Undici.

URL/string and npm Undici requests re-evaluate built-in loopback and `NO_PROXY` bypass on each redirect. A standalone native Bun Request instead retains Bun's native automatic redirect behavior: the wrapper applies built-in localhost bypass initially, and Bun applies environment `NO_PROXY` on redirects. Without a matching `NO_PROXY`, native redirects to localhost remain on the explicitly selected proxy, as in the previous curl transport. Use bundled startup for per-hop built-in loopback bypass; this native-Request distinction never applies to protected URL/auth fetching.

GitHub clones live in private, independently created owner directories under the configured clone base. Session cache cleanup removes only its owner directory, waiting for its pending clones to settle. README, tree and blob paths remain repository-contained.
