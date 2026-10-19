import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "svg", "button", "select", "option", "input", "textarea", "template", "nav",
]);
const SKIP_CLASSES = ["accesshide", "sr-only", "visually-hidden", "dropdown-menu", "skip-block"];
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "ul", "ol", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "blockquote", "pre", "figure", "figcaption", "form", "fieldset",
]);

export interface PageText {
  title: string;
  text: string;
}

/** Converts the main region of a Moodle page into compact Markdown-ish text. */
export function htmlToText(html: string, pageUrl: string): PageText {
  const root = parse(html);
  const title = root.querySelector("title")?.text.trim() ?? "";
  const main =
    root.querySelector("#region-main") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
  const out: string[] = [];
  walk(main, out, pageUrl);
  const text = out
    .join("")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

function walk(node: Node, out: string[], baseUrl: string): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(node.text.replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase() ?? "";
  if (SKIP_TAGS.has(tag)) return;
  if (el.getAttribute("aria-hidden") === "true") return;
  const cls = el.getAttribute("class") ?? "";
  if (SKIP_CLASSES.some((c) => cls.split(/\s+/).includes(c))) return;

  switch (tag) {
    case "br":
      out.push("\n");
      return;
    case "hr":
      out.push("\n---\n");
      return;
    case "img": {
      const alt = el.getAttribute("alt")?.trim();
      if (alt) out.push(` [Bild: ${alt}] `);
      return;
    }
    case "a": {
      const href = el.getAttribute("href");
      const inner: string[] = [];
      for (const c of el.childNodes) walk(c, inner, baseUrl);
      const text = inner.join("").replace(/\s+/g, " ").trim();
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
        out.push(text);
        return;
      }
      let abs: string;
      try {
        abs = new URL(href, baseUrl).toString();
      } catch {
        out.push(text);
        return;
      }
      out.push(text && text !== abs ? `[${text}](${abs})` : abs);
      return;
    }
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      out.push(`\n\n${"#".repeat(Number(tag[1]) + 1)} `);
      for (const c of el.childNodes) walk(c, out, baseUrl);
      out.push("\n\n");
      return;
    case "li":
      out.push("\n- ");
      for (const c of el.childNodes) walk(c, out, baseUrl);
      return;
    case "tr":
      out.push("\n|");
      for (const c of el.childNodes) walk(c, out, baseUrl);
      return;
    case "td": case "th":
      out.push(" ");
      for (const c of el.childNodes) walk(c, out, baseUrl);
      out.push(" |");
      return;
  }

  const block = BLOCK_TAGS.has(tag);
  if (block) out.push("\n");
  for (const c of el.childNodes) walk(c, out, baseUrl);
  if (block) out.push("\n");
}

/** Finds the first file link of a resource page that Moodle did not redirect on its own. */
export function findResourceFile(html: string, pageUrl: string): string | null {
  const main = parse(html).querySelector("#region-main") ?? parse(html);
  const candidates = [
    ...main.querySelectorAll(".resourceworkaround a"),
    ...main.querySelectorAll("object[data]"),
    ...main.querySelectorAll("iframe[src]"),
    ...main.querySelectorAll("a[href*='pluginfile.php']"),
  ];
  for (const el of candidates) {
    const link = el.getAttribute("href") ?? el.getAttribute("data") ?? el.getAttribute("src");
    if (link && link.includes("pluginfile.php")) return new URL(link, pageUrl).toString();
  }
  return null;
}
