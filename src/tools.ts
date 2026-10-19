import { parse } from "node-html-parser";
import { createDownloadLink, DOWNLOAD_TTL_HOURS } from "./download";
import { extractFile } from "./extract";
import { findResourceFile, htmlToText } from "./html";
import { Env, FetchResult, Moodle, SessionExpiredError } from "./moodle";
import { decryptPdf, isEncryptedPdf, isPdf, PdfPasswordError } from "./pdf";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolContext {
  env: Env;
  /** Public origin of the worker, used to build download links. */
  origin: string;
  tz: string;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(m: Moodle, args: Record<string, any>, ctx: ToolContext): Promise<ToolContent[]>;
}

const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 30000;

const text = (t: string): ToolContent[] => [{ type: "text", text: t }];

function fmtDate(unix: number, tz: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(
    new Date(unix * 1000),
  );
}

function paginate(body: string, offset: number, maxChars: number): string {
  if (offset >= body.length && body.length > 0) return `[offset ${offset} liegt hinter dem Ende (${body.length} Zeichen).]`;
  const slice = body.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  return end < body.length
    ? `${slice}\n\n[Gekürzt: Zeichen ${offset}–${end} von ${body.length}. Weiterlesen mit offset=${end}.]`
    : slice;
}

function filenameOf(res: Response, url: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) return decodeURIComponent(star[1].replace(/"/g, ""));
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain) return plain[1];
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "datei");
}

function fmtSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Fetches a Moodle URL and, for resource pages that Moodle does not redirect on its own,
 * follows the embedded file link. html is set when the result is an ordinary page.
 */
async function fetchTarget(m: Moodle, url: string): Promise<FetchResult & { html?: string }> {
  const r = await m.fetch(url);
  if (r.external || !r.res.ok) return r;
  if (!(r.res.headers.get("Content-Type") ?? "").includes("text/html")) return r;
  const html = await r.res.text();
  if (r.finalUrl.includes("/mod/resource/view.php")) {
    const file = findResourceFile(html, r.finalUrl);
    if (file) return m.fetch(file);
  }
  return { ...r, html };
}

interface DownloadedFile {
  data: Uint8Array;
  name: string;
  contentType: string;
}

async function download(res: Response, url: string): Promise<DownloadedFile> {
  const len = Number(res.headers.get("Content-Length") ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`Die Datei ist mit ${fmtSize(len)} zu groß (Limit 30 MB). URL: ${url}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const contentType = (res.headers.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim();
  return { data, name: filenameOf(res, url), contentType };
}

async function readFileResponse(
  res: Response,
  url: string,
  offset: number,
  maxChars: number,
  password?: string,
): Promise<ToolContent[]> {
  const f = await download(res, url);
  const result = await extractFile(f.data, f.name, f.contentType, password);
  if (result.kind === "image") {
    return [{ type: "text", text: `Bild: ${f.name}` }, { type: "image", data: result.data, mimeType: result.mimeType }];
  }
  return text(
    `# Datei: ${f.name}\nQuelle: ${url}\n(Die Datei selbst als PDF/Download liefert get_file.)\n\n${paginate(result.text, offset, maxChars)}`,
  );
}

interface CourseState {
  section: { id: string; number?: number; section?: number; title: string; cmlist: string[]; visible?: boolean }[];
  cm: { id: string; name: string; module: string; url?: string; uservisible?: boolean; visible?: boolean }[];
}

async function courseContents(m: Moodle, courseId: number): Promise<string> {
  try {
    const raw = await m.ajax<string>("core_courseformat_get_state", { courseid: courseId });
    const state: CourseState = JSON.parse(raw);
    const cms = new Map(state.cm.map((c) => [String(c.id), c]));
    const lines: string[] = [];
    for (const s of state.section) {
      lines.push(`\n## ${s.title || `Abschnitt ${s.number ?? s.section}`}`);
      for (const id of s.cmlist) {
        const c = cms.get(String(id));
        if (!c) continue;
        const hidden = c.uservisible === false ? " (nicht verfügbar)" : "";
        lines.push(c.url ? `- [${c.module}] ${c.name}${hidden}: ${c.url}` : `- [${c.module}] ${c.name}${hidden}`);
      }
    }
    return lines.join("\n").trim();
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    return courseContentsFromHtml(m, courseId);
  }
}

/** Fallback for Moodle versions where core_courseformat_get_state is not available. */
async function courseContentsFromHtml(m: Moodle, courseId: number): Promise<string> {
  const { res, finalUrl } = await m.fetch(`/course/view.php?id=${courseId}`);
  const root = parse(await res.text());
  const lines: string[] = [];
  for (const sec of root.querySelectorAll("li.section, li.course-section")) {
    const title = sec.querySelector(".sectionname, h3")?.text.trim() || "Abschnitt";
    lines.push(`\n## ${title}`);
    for (const act of sec.querySelectorAll("li.activity")) {
      const mod = (act.getAttribute("class") ?? "").match(/modtype_(\w+)/)?.[1] ?? "?";
      const nameEl = act.querySelector(".instancename") ?? act.querySelector(".activityname");
      nameEl?.querySelectorAll(".accesshide").forEach((n) => n.remove());
      const name = nameEl?.text.trim() || act.text.trim().slice(0, 120);
      const href = act.querySelector("a.aalink, .activityname a")?.getAttribute("href");
      lines.push(href ? `- [${mod}] ${name}: ${new URL(href, finalUrl)}` : `- [${mod}] ${name}`);
    }
  }
  return lines.join("\n").trim() || htmlToText(root.toString(), finalUrl).text;
}

export const TOOLS: Tool[] = [
  {
    name: "list_courses",
    title: "Kurse auflisten",
    description:
      "Listet die Moodle-Kurse auf, in die der Nutzer an der Hochschule München eingeschrieben ist, mit Kurs-ID und URL.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["inprogress", "all", "past", "future", "favourites"],
          description: "Welche Kurse: laufende (Standard), alle, vergangene, zukünftige oder favorisierte.",
        },
      },
    },
    async run(m, args) {
      const data = await m.ajax<{ courses: any[] }>("core_course_get_enrolled_courses_by_timeline_classification", {
        offset: 0,
        limit: 0,
        classification: args.filter ?? "inprogress",
        sort: "fullname",
      });
      if (!data.courses.length) return text("Keine Kurse gefunden.");
      return text(
        data.courses
          .map((c) => `- ${c.fullname} (${c.shortname}), Kurs-ID ${c.id}${c.coursecategory ? `, ${c.coursecategory}` : ""}: ${c.viewurl}`)
          .join("\n"),
      );
    },
  },
  {
    name: "get_course_contents",
    title: "Kursinhalt anzeigen",
    description:
      "Zeigt Abschnitte und Aktivitäten eines Kurses (Dateien, Ordner, Seiten, Foren, Aufgaben, Links) mit ihren URLs. Die URLs können mit open_url gelesen werden.",
    inputSchema: {
      type: "object",
      properties: { course_id: { type: "integer", description: "Kurs-ID, z. B. 12102 aus course/view.php?id=12102" } },
      required: ["course_id"],
    },
    async run(m, args) {
      return text(await courseContents(m, Number(args.course_id)));
    },
  },
  {
    name: "open_url",
    title: "Moodle-Seite oder Datei lesen",
    description:
      "Öffnet eine beliebige Moodle-URL (Aktivität, Datei unter pluginfile.php, Forum, Diskussion, Aufgabe, Ordner) und gibt den Inhalt als Text zurück. PDFs, Word, PowerPoint, Excel und Textdateien werden in Text umgewandelt, Bilder als Bild geliefert. Lange Inhalte werden seitenweise über offset geliefert.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Vollständige Moodle-URL oder Pfad wie /mod/resource/view.php?id=123" },
        offset: { type: "integer", minimum: 0, description: "Startzeichen für lange Texte (Standard 0)" },
        max_chars: { type: "integer", minimum: 1000, maximum: 100000, description: "Maximale Zeichenzahl (Standard 30000)" },
        password: { type: "string", description: "Passwort für passwortgeschützte PDFs (nur wenn nötig)" },
      },
      required: ["url"],
    },
    async run(m, args) {
      const offset = Number(args.offset ?? 0);
      const maxChars = Number(args.max_chars ?? DEFAULT_MAX_CHARS);
      const password = args.password ? String(args.password) : undefined;
      const { res, finalUrl, external, html } = await fetchTarget(m, String(args.url));
      if (external) return text(`Diese Moodle-Aktivität verweist auf eine externe Seite: ${finalUrl}`);
      if (!res.ok) return text(`Moodle antwortete mit HTTP ${res.status} für ${finalUrl}.`);
      if (html === undefined) return readFileResponse(res, finalUrl, offset, maxChars, password);
      const page = htmlToText(html, finalUrl);
      return text(`# ${page.title}\nQuelle: ${finalUrl}\n\n${paginate(page.text, offset, maxChars)}`);
    },
  },
  {
    name: "get_file",
    title: "Datei herunterladen (PDF in den Chat)",
    description:
      "Holt eine Datei aus Moodle als Datei statt als Text: liefert einen Download-Link (24 Stunden gültig, zum Öffnen, Speichern oder Drucken) und hängt PDFs bis 10 MB direkt an, damit sie im Chat mit Layout, Bildern und Formeln gelesen werden können. " +
      "Passwortgeschützte PDFs werden mit password entschlüsselt; der Link liefert dann ein PDF ohne Passwort und ohne Druck- oder Kopiersperre. Akzeptiert Aktivitäts-URLs (mod/resource) und pluginfile.php-URLs.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Moodle-URL der Datei, z. B. /mod/resource/view.php?id=123 oder eine pluginfile.php-URL" },
        password: { type: "string", description: "Passwort, falls das PDF passwortgeschützt ist" },
        attach: {
          type: "boolean",
          description: "PDF zusätzlich direkt an die Antwort anhängen (Standard true). false liefert nur den Link.",
        },
      },
      required: ["url"],
    },
    async run(m, args, ctx) {
      const password = args.password ? String(args.password) : undefined;
      const { res, finalUrl, external, html } = await fetchTarget(m, String(args.url));
      if (external) return text(`Diese Moodle-Aktivität verweist auf eine externe Seite: ${finalUrl}`);
      if (!res.ok) return text(`Moodle antwortete mit HTTP ${res.status} für ${finalUrl}.`);
      if (html !== undefined) {
        return text(`Unter ${finalUrl} liegt keine Datei, sondern eine Seite. Inhalt mit open_url lesen; Dateilinks darin können mit get_file geholt werden.`);
      }

      const f = await download(res, finalUrl);
      const notes: string[] = [];
      if (isPdf(f.data)) {
        f.contentType = "application/pdf";
        if (password || isEncryptedPdf(f.data)) {
          f.data = await decryptPdf(f.data, password);
          notes.push("Das PDF war verschlüsselt und wurde entschlüsselt, Passwort und Druck-/Kopiersperren sind entfernt.");
        }
      }

      const link = await createDownloadLink(ctx.env, ctx.origin, f.data, { filename: f.name, contentType: f.contentType });
      const lines = [`Datei: ${f.name} (${fmtSize(f.data.byteLength)}, ${f.contentType})`, `Quelle: ${finalUrl}`];
      lines.push(link ? `Download-Link (${DOWNLOAD_TTL_HOURS} Stunden gültig, ohne Login): ${link}` : "Für einen Download-Link ist die Datei zu groß (über 25 MB).");
      lines.push(...notes);

      const content: ToolContent[] = [];
      if (link) {
        content.push({ type: "resource_link", uri: link, name: f.name, mimeType: f.contentType, size: f.data.byteLength });
      }
      if (args.attach !== false && f.contentType === "application/pdf") {
        if (f.data.byteLength <= MAX_ATTACH_BYTES) {
          content.push({
            type: "resource",
            resource: { uri: link ?? finalUrl, mimeType: "application/pdf", blob: toBase64(f.data) },
          });
          lines.push("Das PDF ist angehängt.");
        } else {
          lines.push(`Das PDF ist zu groß zum Anhängen (Limit ${fmtSize(MAX_ATTACH_BYTES)}), bitte den Link nutzen. Text liefert open_url.`);
        }
      }
      return [{ type: "text", text: lines.join("\n") }, ...content];
    },
  },
  {
    name: "upcoming_deadlines",
    title: "Anstehende Termine und Abgaben",
    description:
      "Listet anstehende Abgaben, Tests und andere Termine aus der Moodle-Zeitleiste, optional nur für einen Kurs.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 365, description: "Zeitraum in Tagen ab heute (Standard 30)" },
        include_overdue_days: {
          type: "integer",
          minimum: 0,
          maximum: 90,
          description: "Auch überfällige Termine der letzten N Tage zeigen (Standard 0)",
        },
        course_id: { type: "integer", description: "Nur Termine dieses Kurses" },
      },
    },
    async run(m, args, { tz }) {
      const now = Math.floor(Date.now() / 1000);
      const from = now - Number(args.include_overdue_days ?? 0) * 86400;
      const to = now + Number(args.days ?? 30) * 86400;
      const data = args.course_id
        ? await m.ajax<{ events: any[] }>("core_calendar_get_action_events_by_course", {
            courseid: Number(args.course_id),
            timesortfrom: from,
            timesortto: to,
            limitnum: 50,
          })
        : await m.ajax<{ events: any[] }>("core_calendar_get_action_events_by_timesort", {
            timesortfrom: from,
            timesortto: to,
            limitnum: 50,
            limittononsuspendedevents: true,
          });
      if (!data.events.length) return text("Keine anstehenden Termine im gewählten Zeitraum.");
      return text(
        data.events
          .map((e) => {
            const overdue = e.overdue || e.timesort < now ? " (ÜBERFÄLLIG)" : "";
            const action = e.action?.name ? `, Aktion: ${e.action.name}` : "";
            return `- ${fmtDate(e.timesort, tz)}${overdue}: ${e.activityname ?? e.name} [${e.course?.fullname ?? "?"}]${action}\n  ${e.url}`;
          })
          .join("\n"),
      );
    },
  },
  {
    name: "session_status",
    title: "Verbindungsstatus",
    description: "Prüft, ob die gespeicherte Moodle-Session noch gültig ist.",
    inputSchema: { type: "object", properties: {} },
    async run(m, _args, { tz }) {
      await m.refreshSesskey();
      const s = m.session;
      return text(
        `Moodle-Session ist gültig (User-ID ${s.userId ?? "?"}). Cookie zuletzt gesetzt: ${fmtDate(Date.parse(s.updatedAt) / 1000, tz)}.`,
      );
    },
  },
];
