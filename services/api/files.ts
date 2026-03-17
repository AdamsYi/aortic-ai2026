export function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.includes(",") ? base64.split(",").pop() || "" : base64;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function contentTypeForArtifact(name: string): string {
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (name.endsWith(".stl")) return "model/stl";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".nii.gz")) return "application/gzip";
  return "application/octet-stream";
}

export function pickObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
