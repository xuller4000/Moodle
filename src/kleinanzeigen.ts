import { HTMLElement, parse } from "node-html-parser";
import { errorResult, McpServer, ToolInfo } from "./mcp";

const BASE = "https://www.kleinanzeigen.de";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Accept-Language": "de-DE,de;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};
const MAX_IMAGES = 4;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function kaFetch(path: string): Promise<Response> {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`Kleinanzeigen blockiert die Anfrage gerade (HTTP ${res.status}). Später erneut versuchen.`);
  }
  if (!res.ok) throw new Error(`Kleinanzeigen antwortete mit HTTP ${res.status} für ${path}.`);
  return res;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

async function resolveLocation(query: string): Promise<{ id: string; name: string } | null> {
  const res = await kaFetch(`/s-ort-empfehlungen.json?query=${encodeURIComponent(query)}`);
  const data = (await res.json()) as Record<string, string>;
  const first = Object.entries(data).find(([key]) => key !== "_0");
  return first ? { id: first[0].slice(1), name: first[1] } : null;
}

interface SearchArgs {
  query: string;
  location?: string;
  radius_km?: number;
  min_price?: number;
  max_price?: number;
  sort?: "neueste" | "preis";
  type?: "angebote" | "gesuche";
  page?: number;
}

/** Builds paths like /s-preis:100:500/seite:2/fahrrad/k0l6411r10. */
function searchPath(a: SearchArgs, locationId?: string): string {
  const filters: string[] = [];
  if (a.type) filters.push(`anzeige:${a.type}`);
  if (a.min_price !== undefined || a.max_price !== undefined) filters.push(`preis:${a.min_price ?? ""}:${a.max_price ?? ""}`);
  if (a.sort) filters.push(`sortierung:${a.sort}`);
  if (a.page && a.page > 1) filters.push(`seite:${a.page}`);
  const keyword = encodeURIComponent(a.query.trim().toLowerCase().replace(/\s+/g, "-"));
  const area = locationId ? `l${locationId}${a.radius_km ? `r${a.radius_km}` : ""}` : "";
  return `/s-${[...filters, keyword].join("/")}/k0${area}`;
}

function parseResults(html: string): string[] {
  const root = parse(html);
  return root.querySelectorAll("article[data-adid]").map((art) => {
    const id = art.getAttribute("data-adid");
    const url = BASE + (art.getAttribute("data-href") ?? `/s-anzeige/${id}`);
    const title = clean(art.querySelector("h3")?.text) || clean(art.querySelector("h2")?.text);
    const [place, date] = art.querySelectorAll("span").slice(0, 2).map((s) => clean(s.text));
    const paragraphs = art.querySelectorAll("p").map((p) => ({ cls: p.getAttribute("class") ?? "", text: clean(p.text) }));
    const price = paragraphs.find((p) => p.cls.includes("text-title3"))?.text ?? "";
    const desc = paragraphs.find((p) => p.cls.includes("onSurfaceSubdued"))?.text ?? "";
    const tags = paragraphs.filter((p) => p.text && !p.cls.includes("text-title3") && !p.cls.includes("onSurfaceSubdued"));
    const extra = tags.map((t) => t.text).join(", ");
    return [
      `- **${title}**${price ? ` · ${price}` : ""}`,
      `  ${[place, date, extra].filter(Boolean).join(" · ")}`,
      desc ? `  ${desc.slice(0, 200)}` : "",
      `  ${url}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
}

async function search(a: SearchArgs): Promise<Content[]> {
  if (!a.query?.trim()) return [{ type: "text", text: "Bitte einen Suchbegriff angeben." }];
  let locationNote = "";
  let locationId: string | undefined;
  if (a.location) {
    const loc = await resolveLocation(a.location);
    if (!loc) return [{ type: "text", text: `Ort „${a.location}“ nicht gefunden. Bitte PLZ oder Stadtname angeben.` }];
    locationId = loc.id;
    locationNote = ` in ${loc.name}${a.radius_km ? ` (+${a.radius_km} km)` : ""}`;
  }
  const path = searchPath(a, locationId);
  const html = await (await kaFetch(path)).text();
  const results = parseResults(html);
  const total = html.match(/von ([\d.]+) Ergebnissen/)?.[1];
  if (!results.length) return [{ type: "text", text: `Keine Anzeigen für „${a.query}“${locationNote} gefunden.\n${BASE}${path}` }];
  const head = `${total ? `${total} Treffer` : `${results.length} Treffer auf dieser Seite`} für „${a.query}“${locationNote}, Seite ${a.page ?? 1}.`;
  return [{ type: "text", text: `${head}\nSuche im Browser: ${BASE}${path}\n\n${results.join("\n\n")}` }];
}

function listingPath(input: string): string {
  const v = input.trim();
  if (/^\d{6,}$/.test(v)) return `/s-anzeige/${v}`;
  const u = new URL(v, BASE);
  if (u.hostname !== "www.kleinanzeigen.de" && u.hostname !== "kleinanzeigen.de") {
    throw new Error("Nur Links von kleinanzeigen.de oder Anzeigen-IDs sind erlaubt.");
  }
  return u.pathname;
}

function descriptionText(el: HTMLElement | null): string {
  if (!el) return "";
  return el.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function getListing(input: string, withImages: boolean): Promise<Content[]> {
  const path = listingPath(input);
  const res = await kaFetch(path);
  const url = res.url || BASE + path;
  const root = parse(await res.text());
  const title = clean(root.querySelector("#viewad-title")?.text);
  if (!title) return [{ type: "text", text: `Unter ${url} wurde keine Anzeige gefunden (gelöscht oder abgelaufen?).` }];

  const details = root
    .querySelectorAll("li.addetailslist--detail")
    .map((li) => {
      const value = clean(li.querySelector(".addetailslist--detail--value")?.text);
      const label = clean(li.text.replace(value, ""));
      return `${label}: ${value}`;
    });
  const features = root.querySelectorAll("li.checktag").map((li) => clean(li.text));
  const seller = root.querySelector(".userprofile-vip a");
  const sellerInfo = root.querySelectorAll(".userprofile-vip-details-text").map((e) => clean(e.text)).filter(Boolean);
  const images = [
    ...new Set(root.querySelectorAll("[data-imgsrc]").map((e) => e.getAttribute("data-imgsrc")!).filter(Boolean)),
  ];

  const lines = [
    `# ${title.replace(/^(Reserviert|Gelöscht|Verkauft)\s*•\s*/, "$1: ")}`,
    `Preis: ${clean(root.querySelector("#viewad-price")?.text) || "keine Angabe"}`,
    `Versand: ${clean(root.querySelector(".boxedarticle--details--shipping")?.text) || "keine Angabe"}`,
    `Ort: ${clean(root.querySelector("#viewad-locality")?.text)}`,
    `Eingestellt: ${clean(root.querySelector("#viewad-extra-info span")?.text)}`,
    seller ? `Anbieter: ${clean(seller.text)}${sellerInfo.length ? ` (${sellerInfo.join(", ")})` : ""}` : "",
    details.length ? `\n## Details\n${details.join("\n")}` : "",
    features.length ? `\n## Ausstattung\n${features.join(", ")}` : "",
    `\n## Beschreibung\n${descriptionText(root.querySelector("#viewad-description-text"))}`,
    `\n${images.length} Bilder · ${url}`,
  ];
  const content: Content[] = [{ type: "text", text: lines.filter(Boolean).join("\n") }];

  if (withImages) {
    for (const src of images.slice(0, MAX_IMAGES)) {
      const img = await fetch(src, { headers: HEADERS });
      if (!img.ok) continue;
      const mime = (img.headers.get("Content-Type") ?? "image/jpeg").split(";")[0];
      content.push({ type: "image", data: toBase64(new Uint8Array(await img.arrayBuffer())), mimeType: mime });
    }
  }
  return content;
}

const TOOLS: ToolInfo[] = [
  {
    name: "search_listings",
    title: "Kleinanzeigen durchsuchen",
    description:
      "Sucht Anzeigen auf kleinanzeigen.de und liefert Titel, Preis, Ort, Datum, Kurzbeschreibung und Link je Treffer (etwa 25 pro Seite).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff, z. B. „woom 4“ oder „Rennrad 56“" },
        location: { type: "string", description: "PLZ oder Ort, z. B. „80335“ oder „München“" },
        radius_km: { type: "integer", enum: [5, 10, 20, 30, 50, 100, 150, 200], description: "Umkreis in km (nur mit location)" },
        min_price: { type: "integer", minimum: 0, description: "Mindestpreis in Euro" },
        max_price: { type: "integer", minimum: 0, description: "Höchstpreis in Euro" },
        sort: { type: "string", enum: ["neueste", "preis"], description: "neueste zuerst oder günstigste zuerst" },
        type: { type: "string", enum: ["angebote", "gesuche"], description: "Nur Angebote oder nur Gesuche" },
        page: { type: "integer", minimum: 1, maximum: 50, description: "Ergebnisseite (Standard 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_listing",
    title: "Anzeige anzeigen",
    description:
      "Liest eine einzelne Anzeige: Preis, Versand, Ort, Datum, Anbieter, Details wie Zustand oder Größe, vollständige Beschreibung und optional die ersten Fotos.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Link zur Anzeige oder die Anzeigen-ID" },
        images: { type: "boolean", description: `Die ersten ${MAX_IMAGES} Fotos mitliefern (Standard true)` },
      },
      required: ["url"],
    },
  },
];

export const kleinanzeigenServer: McpServer = {
  info: { name: "kleinanzeigen", title: "Kleinanzeigen", version: "0.1.0" },
  instructions:
    "Lesender Zugriff auf kleinanzeigen.de ohne Login. search_listings für Suchen (Ort als PLZ oder Stadt, Umkreis, " +
    "Preisgrenzen), get_listing für Details und Fotos einer Anzeige. Immer den Link zur Anzeige mitgeben. " +
    "Nachrichten an Verkäufer kann dieser Connector nicht senden.",
  tools: TOOLS,
  async call(name, args) {
    try {
      if (name === "search_listings") return { content: await search(args as unknown as SearchArgs) };
      return { content: await getListing(String(args.url ?? ""), args.images !== false) };
    } catch (e) {
      return errorResult(`Fehler: ${(e as Error).message}`);
    }
  },
};
