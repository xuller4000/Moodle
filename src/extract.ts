import { unzipSync, strFromU8 } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { htmlToText } from "./html";
import { PdfPasswordError } from "./pdf";

export type Extracted =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string };

const TEXT_EXT = new Set([
  "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "tex", "bib", "log", "ini", "cfg",
  "py", "m", "c", "h", "cpp", "hpp", "cs", "java", "js", "ts", "html", "htm", "css", "sql", "sh", "r", "vhd", "v",
]);
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function extractFile(
  buf: Uint8Array,
  filename: string,
  contentType: string,
  password?: string,
): Promise<Extracted> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const ct = contentType.toLowerCase();

  if (ext === "pdf" || ct.includes("application/pdf")) return { kind: "text", text: await pdfText(buf, password) };
  if (IMAGE_MIME[ext] || ct.startsWith("image/")) {
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return { kind: "text", text: `Bild ${filename} ist mit ${kb(buf)} zu groß zum Übertragen.` };
    }
    return { kind: "image", data: toBase64(buf), mimeType: IMAGE_MIME[ext] ?? ct.split(";")[0] };
  }
  if (ext === "docx") return { kind: "text", text: docxText(buf) };
  if (ext === "pptx") return { kind: "text", text: pptxText(buf) };
  if (ext === "xlsx") return { kind: "text", text: xlsxText(buf) };
  if (["odt", "odp", "ods"].includes(ext)) return { kind: "text", text: odfText(buf) };
  if (ext === "zip") {
    const names = Object.keys(unzipSync(buf, { filter: () => false })).join("\n");
    return { kind: "text", text: `ZIP-Archiv ${filename}, Inhalt:\n${names || "(Liste nicht lesbar)"}` };
  }
  if (ext === "html" || ext === "htm" || ct.includes("text/html")) {
    return { kind: "text", text: htmlToText(new TextDecoder().decode(buf), "https://localhost/").text };
  }
  if (TEXT_EXT.has(ext) || ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) {
    return { kind: "text", text: new TextDecoder().decode(buf) };
  }
  return {
    kind: "text",
    text: `Die Datei ${filename} (${contentType || "unbekannter Typ"}, ${kb(buf)}) kann nicht als Text gelesen werden.`,
  };
}

async function pdfText(buf: Uint8Array, password?: string): Promise<string> {
  let pdf;
  try {
    pdf = await getDocumentProxy(buf, password ? { password } : {});
  } catch (e) {
    if ((e as Error).name === "PasswordException") {
      throw new PdfPasswordError((e as { code?: number }).code === 2 ? "incorrect" : "required");
    }
    throw e;
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => `--- Seite ${i + 1} ---\n${t.trim()}`);
  const joined = pages.join("\n\n");
  if (joined.replace(/--- Seite \d+ ---/g, "").trim().length < 20) {
    return `PDF mit ${totalPages} Seiten, aber ohne extrahierbaren Text (vermutlich eingescannt).`;
  }
  return joined;
}

function unzipXml(buf: Uint8Array, pattern: RegExp): Map<string, string> {
  const files = unzipSync(buf, { filter: (f) => pattern.test(f.name) });
  const out = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) out.set(name, strFromU8(data));
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripXml(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ""));
}

function byNumber(a: string, b: string): number {
  return Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

function docxText(buf: Uint8Array): string {
  const xml = unzipXml(buf, /^word\/document\.xml$/).get("word/document.xml") ?? "";
  return stripXml(xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n")).trim();
}

function pptxText(buf: Uint8Array): string {
  const slides = unzipXml(buf, /^ppt\/slides\/slide\d+\.xml$/);
  return [...slides.keys()]
    .sort(byNumber)
    .map((name, i) => {
      const paras = (slides.get(name) ?? "").split(/<\/a:p>/).map((p) =>
        [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeEntities(m[1])).join(""),
      );
      return `--- Folie ${i + 1} ---\n${paras.filter((p) => p.trim()).join("\n")}`;
    })
    .join("\n\n");
}

function xlsxText(buf: Uint8Array): string {
  const files = unzipXml(buf, /^xl\/(sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/);
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    stripXml(m[1]),
  );
  const sheetNames = [...(files.get("xl/workbook.xml") ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
    decodeEntities(m[1]),
  );
  const sheets = [...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort(byNumber);
  return sheets
    .map((name, i) => {
      const rows = [...(files.get(name) ?? "").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const attrs = c[1];
            const inner = c[2] ?? "";
            const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
            if (/t="s"/.test(attrs) && v !== undefined) return shared[Number(v)] ?? "";
            if (/t="inlineStr"/.test(attrs)) return stripXml(inner);
            return v !== undefined ? decodeEntities(v) : "";
          })
          .join("\t"),
      );
      return `--- Tabelle ${sheetNames[i] ?? i + 1} ---\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

function odfText(buf: Uint8Array): string {
  const xml = unzipXml(buf, /^content\.xml$/).get("content.xml") ?? "";
  return stripXml(xml.replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<\/text:(p|h)>/g, "\n")).trim();
}

function kb(buf: Uint8Array): string {
  return `${Math.round(buf.byteLength / 1024)} KB`;
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
