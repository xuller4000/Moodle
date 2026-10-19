import { parse } from "node-html-parser";
import { extractFile } from "./extract";
import { findResourceFile, htmlToText } from "./html";
import { Moodle, SessionExpiredError } from "./moodle";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(m: Moodle, args: Record<string, any>, tz: string): Promise<ToolContent[]>;
}

const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
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

async function readFileResponse(res: Response, url: string, offset: number, maxChars: number): Promise<ToolContent[]> {
  const len = Number(res.headers.get("Content-Length") ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) {
    return text(`Die Datei ist mit ${Math.round(len / 1048576)} MB zu groß (Limit 30 MB). URL: ${url}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const name = filenameOf(res, url);
  const result = await extractFile(buf, name, res.headers.get("Content-Type") ?? "");
  if (result.kind === "image") {
    return [{ type: "text", text: `Bild: ${name}` }, { type: "image", data: result.data, mimeType: result.mimeType }];
  }
  return text(`# Datei: ${name}\nQuelle: ${url}\n\n${paginate(result.text, offset, maxChars)}`);
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
      },
      required: ["url"],
    },
    async run(m, args) {
      const offset = Number(args.offset ?? 0);
      const maxChars = Number(args.max_chars ?? DEFAULT_MAX_CHARS);
      const { res, finalUrl, external } = await m.fetch(String(args.url));
      if (external) return text(`Diese Moodle-Aktivität verweist auf eine externe Seite: ${finalUrl}`);
      if (!res.ok) return text(`Moodle antwortete mit HTTP ${res.status} für ${finalUrl}.`);
      const ct = res.headers.get("Content-Type") ?? "";
      if (!ct.includes("text/html")) return readFileResponse(res, finalUrl, offset, maxChars);

      const html = await res.text();
      if (finalUrl.includes("/mod/resource/view.php")) {
        const file = findResourceFile(html, finalUrl);
        if (file) {
          const f = await m.fetch(file);
          return readFileResponse(f.res, f.finalUrl, offset, maxChars);
        }
      }
      const page = htmlToText(html, finalUrl);
      return text(`# ${page.title}\nQuelle: ${finalUrl}\n\n${paginate(page.text, offset, maxChars)}`);
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
    async run(m, args, tz) {
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
    async run(m, _args, tz) {
      await m.refreshSesskey();
      const s = m.session;
      return text(
        `Moodle-Session ist gültig (User-ID ${s.userId ?? "?"}). Cookie zuletzt gesetzt: ${fmtDate(Date.parse(s.updatedAt) / 1000, tz)}.`,
      );
    },
  },
];
