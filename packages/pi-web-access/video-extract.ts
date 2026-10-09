import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, extname, basename, join, dirname } from "node:path";
import { activityMonitor } from "./activity.ts";
import { canAttachImages } from "./feature-config.ts";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { queryGeminiApiWithVideo, getApiKey, fetchGeminiApi, getVersionedApiBase, getUploadBase, redactGeminiApiResponse } from "./gemini-api.ts";
import { extractHeadingTitle, type ExtractedContent, type ExtractOptions, type FrameResult } from "./extract.ts";
import { readExecError, trimErrorText, mapFfmpegError, getWebSearchConfigPath, jsonParseDiagnostic, proxyChildEnv } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

const DEFAULT_VIDEO_PROMPT = `Extract the complete content of this video. Include:
1. Video title (infer from content if not explicit), duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const VIDEO_EXTENSIONS: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3gpp": "video/3gpp",
};

function shouldRethrow(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("Failed to parse ");
}

interface VideoFileInfo {
	absolutePath: string;
	mimeType: string;
	sizeBytes: number;
	maxSizeBytes: number;
	withinUploadLimit: boolean;
}

interface VideoConfig {
	enabled: boolean;
	preferredModel: string;
	maxSizeMB: number;
	/** Bound on upload + polling + analysis for one video, in milliseconds. */
	flowTimeoutMs: number;
}

function normalizePreferredModel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

// Upload + poll + analysis for one video. Exposed through `video.flowTimeoutMs` so a
// caller (and a test) can bound it without waiting out the default.
const DEFAULT_VIDEO_FLOW_TIMEOUT_MS = 120000;

function normalizeFlowTimeoutMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	// Below one second a slow upload would abort before it can make progress.
	return value >= 1_000 ? Math.floor(value) : fallback;
}

function normalizeMaxSizeMB(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

const VIDEO_CONFIG_DEFAULTS: VideoConfig = {
	enabled: true,
	preferredModel: "gemini-3.6-flash",
	maxSizeMB: 50,
	flowTimeoutMs: DEFAULT_VIDEO_FLOW_TIMEOUT_MS,
};

let cachedVideoConfig: VideoConfig | null = null;

function loadVideoConfig(): VideoConfig {
	if (cachedVideoConfig) return cachedVideoConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedVideoConfig = { ...VIDEO_CONFIG_DEFAULTS };
		return cachedVideoConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { video?: { enabled?: boolean; preferredModel?: string; maxSizeMB?: number; flowTimeoutMs?: number } };
	try {
		raw = JSON.parse(rawText) as { video?: { enabled?: boolean; preferredModel?: string; maxSizeMB?: number; flowTimeoutMs?: number } };
	} catch (err) {
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${jsonParseDiagnostic(err)}`);
	}

	const v = raw.video ?? {};
	cachedVideoConfig = {
		enabled: normalizeEnabled(v.enabled, VIDEO_CONFIG_DEFAULTS.enabled),
		preferredModel: normalizePreferredModel(v.preferredModel, VIDEO_CONFIG_DEFAULTS.preferredModel),
		maxSizeMB: normalizeMaxSizeMB(v.maxSizeMB, VIDEO_CONFIG_DEFAULTS.maxSizeMB),
		flowTimeoutMs: normalizeFlowTimeoutMs(v.flowTimeoutMs, VIDEO_CONFIG_DEFAULTS.flowTimeoutMs),
	};
	return cachedVideoConfig;
}

export function isVideoFile(input: string): VideoFileInfo | null {
	const config = loadVideoConfig();
	if (!config.enabled) return null;

	const isFilePath = input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith("file://");
	if (!isFilePath) return null;

	let filePath = input;
	if (input.startsWith("file://")) {
		try {
			filePath = decodeURIComponent(new URL(input).pathname);
		} catch {
			return null;
		}
	}

	const ext = extname(filePath).toLowerCase();
	const mimeType = VIDEO_EXTENSIONS[ext];
	if (!mimeType) return null;

	const absolutePath = resolveFilePath(filePath);
	if (!absolutePath) return null;

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolutePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;

	const maxBytes = config.maxSizeMB * 1024 * 1024;
	return {
		absolutePath,
		mimeType,
		sizeBytes: stat.size,
		maxSizeBytes: maxBytes,
		withinUploadLimit: stat.size <= maxBytes,
	};
}

function resolveFilePath(filePath: string): string | null {
	const absolutePath = resolve(filePath);
	if (existsSync(absolutePath)) return absolutePath;

	const dir = dirname(absolutePath);
	const base = basename(absolutePath);
	if (!existsSync(dir)) return null;

	try {
		const normalizedBase = normalizeSpaces(base);
		const match = readdirSync(dir).find(f => normalizeSpaces(f) === normalizedBase);
		return match ? join(dir, match) : null;
	} catch {
		return null;
	}
}

function normalizeSpaces(s: string): string {
	return s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

export async function extractVideo(
	info: VideoFileInfo,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const config = loadVideoConfig();
	const effectivePrompt = options?.prompt ?? DEFAULT_VIDEO_PROMPT;
	const effectiveModel = options?.model ?? config.preferredModel;
	const displayName = basename(info.absolutePath);
	if (!info.withinUploadLimit) {
		const sizeMB = (info.sizeBytes / 1024 / 1024).toFixed(1);
		const maxSizeMB = (info.maxSizeBytes / 1024 / 1024).toFixed(1);
		const error = `Local video ${displayName} is ${sizeMB} MiB, above configured video.maxSizeMB (${maxSizeMB} MiB) for Gemini analysis. Use timestamp/frames for ffmpeg frame extraction, increase video.maxSizeMB, or compress the file.`;
		return { url: info.absolutePath, title: displayName, content: error, error };
	}
	const activityId = activityMonitor.logStart({ type: "fetch", url: `video:${displayName}` });

	const result = await tryVideoGeminiApi(info, effectivePrompt, effectiveModel, signal)
		?? await tryVideoGeminiWeb(info, effectivePrompt, effectiveModel, signal);

	if (result) {
		if (canAttachImages()) {
			const thumbnail = await extractVideoFrame(info.absolutePath, 1, signal);
			if (!("error" in thumbnail)) {
				result.thumbnail = thumbnail;
			}
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, "all video extraction paths failed");
	return null;
}

function mapFfprobeError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffprobe is not installed. Install ffmpeg which includes ffprobe";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffprobe failed: ${snippet}` : "ffprobe failed";
}

const execFileAsync = promisify(execFile);

export async function extractVideoFrame(filePath: string, seconds: number = 1, signal?: AbortSignal): Promise<FrameResult> {
	try {
		const { stdout } = await execFileAsync("ffmpeg", [
			"-ss", String(seconds), "-i", filePath,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
		], { maxBuffer: 5 * 1024 * 1024, timeout: 10000, env: proxyChildEnv(), ...(signal ? { signal } : {}) });
		const buffer = typeof stdout === "string" ? Buffer.from(stdout) : stdout;
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		if (signal?.aborted) return { error: "Aborted" };
		return { error: mapFfmpegError(err) };
	}
}

export async function getLocalVideoDuration(filePath: string, signal?: AbortSignal): Promise<number | { error: string }> {
	try {
		const { stdout } = await execFileAsync("ffprobe", [
			"-v", "quiet",
			"-show_entries", "format=duration",
			"-of", "csv=p=0",
			filePath,
		], { timeout: 10000, encoding: "utf-8", ...(signal ? { signal } : {}) });
		const output = stdout.trim();
		const duration = Number.parseFloat(output);
		if (!Number.isFinite(duration)) return { error: "ffprobe failed: invalid duration output" };
		return duration;
	} catch (err) {
		if (signal?.aborted) return { error: "Aborted" };
		return { error: mapFfprobeError(err) };
	}
}

async function tryVideoGeminiWeb(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		const cookies = await isGeminiWebAvailable();
		if (!cookies) return null;
		if (signal?.aborted) return null;

		const text = await queryWithCookies(prompt, cookies, {
			files: [info.absolutePath],
			...(model !== "gemini-3.6-flash" ? { model } : {}),
			signal,
			timeoutMs: 180000,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	}
}

function remainingMs(deadline: number): number {
	const remaining = deadline - Date.now();
	// A non-positive `AbortSignal.timeout` fires immediately, which is the intent: the
	// deadline has passed and the caller must see a timeout rather than start new work.
	return Math.max(1, remaining);
}

async function tryVideoGeminiApi(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) return null;
	if (signal?.aborted) return null;

	let fileName: string | null = null;
	// One deadline covers upload, polling and the analysis request. The caller signal
	// alone is not a bound: `fetch` only returns when the peer responds, so a hung
	// upload or a hung poll request would outlive `timeoutMs` before the poll loop ever
	// rechecked its deadline.
	const flowTimeoutMs = loadVideoConfig().flowTimeoutMs;
	const deadline = Date.now() + flowTimeoutMs;
	const deadlineSignal = (): AbortSignal => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remainingMs(deadline))]);
	try {
		const uploaded = await uploadToFilesApi(info, apiKey, deadlineSignal());
		fileName = uploaded.name;

		await pollFileState(fileName, apiKey, deadlineSignal(), flowTimeoutMs);

		const text = await queryGeminiApiWithVideo(prompt, uploaded.uri, {
			apiKey,
			model,
			mimeType: info.mimeType,
			signal: deadlineSignal(),
			timeoutMs: flowTimeoutMs,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	} finally {
		if (fileName) deleteGeminiFile(fileName, apiKey);
	}
}

async function uploadToFilesApi(
	info: VideoFileInfo,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ name: string; uri: string }> {
	const displayName = basename(info.absolutePath);

	const initRes = await fetchGeminiApi(`${getUploadBase()}/files`, {
		method: "POST",
		headers: {
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Header-Content-Type": info.mimeType,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ file: { display_name: displayName } }),
		signal,
	}, apiKey);

	if (!initRes.ok) {
		const text = redactGeminiApiResponse(initRes, await initRes.text(), apiKey);
		throw new Error(`File upload init failed: ${initRes.status} (${text.slice(0, 200)})`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	// Only the header is consumed; release the unread body before proceeding.
	await initRes.body?.cancel();
	if (!uploadUrl) throw new Error("No upload URL in response headers");

	const fileData = await readFile(info.absolutePath);
	const uploadRes = await fetchGeminiApi(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
		},
		body: fileData,
		signal,
	}, apiKey);

	if (!uploadRes.ok) {
		const text = redactGeminiApiResponse(uploadRes, await uploadRes.text(), apiKey);
		throw new Error(`File upload failed: ${uploadRes.status} (${text.slice(0, 200)})`);
	}

	const result = await uploadRes.json() as { file: { name: string; uri: string } };
	return result.file;
}

async function pollFileState(
	fileName: string,
	apiKey: string,
	signal?: AbortSignal,
	timeoutMs: number = 120000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Aborted");

		const res = await fetchGeminiApi(`${getVersionedApiBase()}/${fileName}`, { signal }, apiKey);
		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(`File state check failed: ${res.status}`);
		}

		const data = await res.json() as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") throw new Error("File processing failed");

		await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(1, deadline - Date.now()))));
	}

	throw new Error("File processing timed out");
}

function deleteGeminiFile(fileName: string, apiKey: string): void {
	// Detached cleanup still needs a bounded lifetime and a consumed body.
	void fetchGeminiApi(`${getVersionedApiBase()}/${fileName}`, {
		method: "DELETE",
		signal: AbortSignal.timeout(10_000),
	}, apiKey)
		.then((res) => res.body?.cancel())
		.catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to delete Gemini file ${fileName}: ${message}`);
		});
}

function extractVideoTitle(text: string, filePath: string): string {
	return extractHeadingTitle(text) ?? basename(filePath, extname(filePath));
}
