/**
 * Shared guards that decide whether a path can be read as text by the `read` tool.
 *
 * Two independent signals are used:
 * - path-only checks (device files, well-known binary extensions) run before any I/O, so
 *   files that would block forever or stream endlessly are rejected without opening them;
 * - content checks on the leading bytes of the file, which is the authoritative signal and
 *   also catches binary files with a misleading or missing extension.
 */

/** Bytes inspected when classifying content. 8 KiB makes a NUL-free binary essentially impossible. */
export const TEXT_SNIFF_BYTES = 8192;

/**
 * Device files that block, never reach EOF, or alias stdio. Checked by path only so the read
 * tool never opens them: `/dev/zero` and `/dev/urandom` never end, FIFO-like aliases block
 * until a writer appears, and `/dev/full` fails every write (they are not readable files).
 */
const BLOCKED_DEVICE_PATHS = new Set([
	"/dev/zero",
	"/dev/random",
	"/dev/urandom",
	"/dev/full",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/console",
	"/dev/fd/0",
	"/dev/fd/1",
	"/dev/fd/2",
]);

const PROC_STDIO_FD_PATTERN = /^\/proc\/(?:[^/]+)\/fd\/[012]$/;

/**
 * Extensions that always denote binary content. Formats the read tool handles itself
 * (png/jpeg/gif/webp/bmp images, svg text, PDFs, notebooks) are deliberately absent.
 */
const BINARY_EXTENSIONS = new Set([
	// archives and packages
	"7z",
	"a",
	"apk",
	"ar",
	"bz2",
	"cab",
	"deb",
	"dmg",
	"egg",
	"gz",
	"img",
	"iso",
	"jar",
	"lz",
	"lz4",
	"lzma",
	"msi",
	"msix",
	"o",
	"pkg",
	"rar",
	"rpm",
	"tar",
	"tbz2",
	"tgz",
	"txz",
	"war",
	"whl",
	"xz",
	"z",
	"zip",
	"zst",
	// executables and compiled artifacts
	"bin",
	"class",
	"dll",
	"dylib",
	"elf",
	"exe",
	"lib",
	"node",
	"pyc",
	"pyo",
	"so",
	"wasm",
	// media
	"aac",
	"aiff",
	"avi",
	"flac",
	"flv",
	"ico",
	"icns",
	"m4a",
	"m4v",
	"mka",
	"mkv",
	"mov",
	"mp3",
	"mp4",
	"mpeg",
	"mpg",
	"oga",
	"ogg",
	"ogv",
	"opus",
	"wav",
	"webm",
	"wma",
	"wmv",
	// fonts
	"eot",
	"otf",
	"ttc",
	"ttf",
	"woff",
	"woff2",
	// office and document containers
	"doc",
	"docm",
	"docx",
	"epub",
	"mobi",
	"numbers",
	"odp",
	"ods",
	"odt",
	"pages",
	"pps",
	"ppt",
	"pptm",
	"pptx",
	"vsd",
	"vsdx",
	"xls",
	"xlsb",
	"xlsm",
	"xlsx",
	"xlt",
	"xltx",
	// databases, disk and application data
	"accdb",
	"db3",
	"dbf",
	"mdb",
	"sqlite",
	"sqlite3",
	// images in formats the read tool cannot send to a model
	"avif",
	"heic",
	"heif",
	"jxl",
	"psd",
	"tif",
	"tiff",
]);

const UNSUPPORTED_IMAGE_FORMATS: { label: string; matches: (head: Uint8Array) => boolean }[] = [
	{
		label: "an animated PNG (APNG)",
		matches: (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && isAnimatedPng(head),
	},
	{
		label: "a TIFF",
		matches: (head) => startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]),
	},
	{
		label: "a JPEG 2000 image",
		matches: (head) => startsWith(head, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]),
	},
	{ label: "a JPEG-LS image", matches: (head) => startsWith(head, [0xff, 0xd8, 0xff, 0xf7]) },
	{
		label: "an ICO or CUR image",
		matches: (head) => startsWith(head, [0x00, 0x00, 0x01, 0x00]) || startsWith(head, [0x00, 0x00, 0x02, 0x00]),
	},
	{ label: "a HEIC or AVIF image", matches: (head) => startsWithAscii(head, 4, "ftyp") && isHeifBrand(head) },
];

/**
 * Returns a message when a path cannot be read through the read tool regardless of content
 * (device files that block or never end) or is a well-known binary format. Never touches the
 * filesystem, so it is safe to call before opening the file.
 */
export function getUnreadablePathReason(filePath: string): string | undefined {
	const normalized = filePath.replaceAll("\\", "/");
	if (BLOCKED_DEVICE_PATHS.has(normalized) || PROC_STDIO_FD_PATTERN.test(normalized)) {
		return `Cannot read ${filePath}: it is a device file that blocks or produces infinite output.`;
	}

	const extension = getExtension(normalized);
	if (extension !== undefined && BINARY_EXTENSIONS.has(extension)) {
		return `Cannot read ${filePath} as text: .${extension} files are binary. Inspect them with bash (for example \`file\`, \`unzip -l\`, or a format-specific converter).`;
	}

	return undefined;
}

/**
 * Returns a message when the leading bytes of a file show it cannot be read as UTF-8 text,
 * including images in formats the read tool cannot send to a model. `head` may be shorter
 * than `TEXT_SNIFF_BYTES` for small files.
 */
export function getUnreadableContentReason(filePath: string, head: Uint8Array): string | undefined {
	if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
		const encoding = head[0] === 0xff ? "UTF-16LE" : "UTF-16BE";
		return `Cannot read ${filePath} as text: it is ${encoding} encoded and the read tool expects UTF-8. Convert it first (for example: \`iconv -f ${encoding} -t UTF-8 ${filePath}\`).`;
	}

	for (const format of UNSUPPORTED_IMAGE_FORMATS) {
		if (format.matches(head)) {
			return `Cannot read ${filePath}: it is ${format.label}, which the read tool cannot send to a model (supported: png, jpeg, gif, webp, bmp). Convert it to PNG first.`;
		}
	}

	const nulIndex = head.indexOf(0x00);
	if (nulIndex !== -1) {
		return `Cannot read ${filePath} as text: the file contains NUL bytes and appears to be binary. Inspect it with bash (for example \`file\`, \`unzip -l\`, or a format-specific converter).`;
	}

	return undefined;
}

function getExtension(filePath: string): string | undefined {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return base.slice(dot + 1).toLowerCase();
}

function startsWith(head: Uint8Array, bytes: number[]): boolean {
	if (head.length < bytes.length) return false;
	return bytes.every((byte, index) => head[index] === byte);
}

/**
 * Returns a message when a path is not a regular file the read tool can stream. A FIFO, socket,
 * or character/block device can block forever or produce endless output, so it is rejected even
 * when its path is not in the device list above. `/dev/null` stays readable: it is empty and
 * harmless on every platform.
 */
export function getUnreadableFileKindReason(filePath: string, kind: ReadFileKind): string | undefined {
	if (kind === "file") return undefined;
	if (filePath.replaceAll("\\", "/") === "/dev/null") return undefined;
	if (kind === "directory") {
		return `${filePath} is a directory. Use the ls tool to list its contents.`;
	}
	return `Cannot read ${filePath}: it is a special file (FIFO, socket, or device) that can block or produce endless output.`;
}

/** File kinds reported by read-tool operations, mirroring `stat` classification. */
export type ReadFileKind = "file" | "directory" | "other";

/** PDFs are recognized by extension first; the content is validated before parsing. */
export function isPdfPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * The PDF header `%PDF-` must appear within the first 1024 bytes (ISO 32000-1, 7.5.2),
 * which lets a misnamed file fall back to being read as text.
 */
export function isPdfContent(head: Uint8Array): boolean {
	const limit = Math.min(head.length, 1024) - 4;
	for (let index = 0; index < limit; index++) {
		if (
			head[index] === 0x25 &&
			head[index + 1] === 0x50 &&
			head[index + 2] === 0x44 &&
			head[index + 3] === 0x46 &&
			head[index + 4] === 0x2d
		) {
			return true;
		}
	}
	return false;
}

function startsWithAscii(head: Uint8Array, offset: number, text: string): boolean {
	if (head.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (head[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

/**
 * True when a PNG stream carries an `acTL` animation control chunk before its first
 * `IDAT`. Walking the chunk table keeps this accurate for static PNGs that the image
 * detection rejected for another reason (for example a malformed IHDR).
 */
function isAnimatedPng(head: Uint8Array): boolean {
	let offset = 8;
	while (offset + 8 <= head.length) {
		const chunkLength = readUint32BE(head, offset);
		if (startsWithAscii(head, offset + 4, "acTL")) return true;
		if (startsWithAscii(head, offset + 4, "IDAT")) return false;
		const nextOffset = offset + 12 + chunkLength;
		if (nextOffset <= offset || nextOffset > head.length) return false;
		offset = nextOffset;
	}
	return false;
}

function readUint32BE(head: Uint8Array, offset: number): number {
	return (
		(head[offset] ?? 0) * 0x1000000 +
		((head[offset + 1] ?? 0) << 16) +
		((head[offset + 2] ?? 0) << 8) +
		(head[offset + 3] ?? 0)
	);
}

/** HEIF/AVIF file brands used in the ISO base media file format `ftyp` box. */
function isHeifBrand(head: Uint8Array): boolean {
	const brand = String.fromCharCode(...head.subarray(8, 12));
	return ["avif", "avis", "heic", "heix", "heif", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand);
}
