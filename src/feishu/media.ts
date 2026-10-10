/** 1 MB in the media cap is 1024×1024 bytes. */
export const MEDIA_BYTE_CAP = 1024 * 1024;

export const MEDIA_OVERSIZE_NOTE = "image exceeds 1 MB; returning metadata only";

export function estimatedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

export const INLINE_IMAGE_NOTE = "only images are returned inline";

/** Feishu fetch-file allows 5 MB. Base64 of that, plus the JSON wrapper, fits under this cap. */
export const MCP_MEDIA_CHAR_LIMIT = 7_500_000;

export function mediaNote(mimeType: string, size: number | null, note: string): string {
  const type = mimeType.length > 0 ? mimeType : "application/octet-stream";
  const sizeText = size === null ? "unknown" : String(size);
  return `type: ${type}\nsize: ${sizeText}\nnote: ${note}`;
}

export function imageMetadata(mimeType: string, size: number | null): string {
  return mediaNote(mimeType, size, MEDIA_OVERSIZE_NOTE);
}

export function mimeOf(header: string | null): string {
  if (!header) return "";
  const type = header.split(";")[0] ?? "";
  return type.trim().toLowerCase();
}

export function declaredLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

export function bytesToStandardBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function readBoundedBytes(response: Response, cap: number): Promise<{ bytes: Uint8Array; size: number; overflow: boolean }> {
  const declared = declaredLength(response.headers.get("content-length"));
  if (declared !== null && declared > cap) {
    await response.body?.cancel();
    return { bytes: new Uint8Array(), size: declared, overflow: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > cap) return { bytes: new Uint8Array(), size: declared ?? buffer.byteLength, overflow: true };
    return { bytes: buffer, size: buffer.byteLength, overflow: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (size + value.byteLength > cap) {
        size += value.byteLength;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value) size += next.value.byteLength;
        }
        return { bytes: new Uint8Array(), size: declared ?? size, overflow: true };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size, overflow: false };
}

