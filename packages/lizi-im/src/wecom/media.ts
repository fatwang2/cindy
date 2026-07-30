import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function mimeTypeForFilename(filename: string | undefined): string {
  const extension = path.extname(filename ?? "").toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function safeWecomFilename(
  filename: string | undefined,
  fallbackExtension = "",
): string {
  const sanitized = path
    .basename(filename?.trim() || `attachment${fallbackExtension}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 160);
  let end = sanitized.length;
  while (
    end > 0 &&
    (sanitized.charCodeAt(end - 1) === 0x2e ||
      sanitized.charCodeAt(end - 1) === 0x20)
  ) {
    end -= 1;
  }
  const base = sanitized.slice(0, end);
  return base || `attachment${fallbackExtension}`;
}

export async function persistWecomDownload(args: {
  mediaDir: string;
  buffer: Buffer;
  filename?: string;
  fallbackExtension?: string;
}): Promise<{ absPath: string; originalName: string; mimeType: string }> {
  if (args.buffer.length === 0) throw new Error("WECOM_MEDIA_EMPTY");
  if (args.buffer.length > MAX_MEDIA_BYTES)
    throw new Error("WECOM_MEDIA_TOO_LARGE");

  const originalName = safeWecomFilename(args.filename, args.fallbackExtension);
  const storageName = `${randomUUID()}-${originalName}`;
  await fs.mkdir(args.mediaDir, { recursive: true });
  const absPath = path.join(args.mediaDir, storageName);
  await fs.writeFile(absPath, args.buffer, { flag: "wx" });
  return {
    absPath,
    originalName,
    mimeType: mimeTypeForFilename(originalName),
  };
}

export async function readWecomOutboundFile(
  absPath: string,
  displayName?: string,
): Promise<{
  buffer: Buffer;
  filename: string;
  mediaType: "file" | "image" | "voice" | "video";
}> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error("WECOM_FILE_NOT_FOUND");
  if (stat.size === 0) throw new Error("WECOM_FILE_EMPTY");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("WECOM_FILE_TOO_LARGE");

  const filename = safeWecomFilename(displayName || path.basename(absPath));
  const mimeType = mimeTypeForFilename(filename);
  const mediaType =
    mimeType.startsWith("image/") && stat.size <= MAX_IMAGE_BYTES
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : mimeType.startsWith("audio/")
          ? "voice"
          : "file";
  return {
    buffer: await fs.readFile(absPath),
    filename,
    mediaType,
  };
}
