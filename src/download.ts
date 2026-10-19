import { Env } from "./moodle";

const TTL_SECONDS = 24 * 3600;
const KV_MAX_BYTES = 25 * 1024 * 1024;

interface DownloadMeta {
  filename: string;
  contentType: string;
}

export const DOWNLOAD_TTL_HOURS = TTL_SECONDS / 3600;

/**
 * Stores a file for 24 hours and returns a link that works without the connector secret.
 * The random token is the only thing that grants access, so the link can be shown in chat.
 */
export async function createDownloadLink(
  env: Env,
  origin: string,
  data: Uint8Array,
  meta: DownloadMeta,
): Promise<string | null> {
  if (data.byteLength > KV_MAX_BYTES) return null;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.MOODLE_KV.put(`dl:${token}`, data, { expirationTtl: TTL_SECONDS, metadata: meta });
  return `${origin}/dl/${token}/${encodeURIComponent(meta.filename)}`;
}

export async function handleDownload(env: Env, token: string): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(token)) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.MOODLE_KV.getWithMetadata<DownloadMeta>(`dl:${token}`, "arrayBuffer");
  if (!value || !metadata) {
    return new Response("Dieser Download-Link ist abgelaufen. Bitte die Datei in Claude neu anfordern.", {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const ascii = metadata.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(value, {
    headers: {
      "Content-Type": metadata.contentType,
      "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
