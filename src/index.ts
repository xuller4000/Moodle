import { handleDownload } from "./download";
import { handleMcp } from "./mcp";
import { Env, loadSession, Moodle, saveSession, SessionExpiredError } from "./moodle";
import { handleSetup } from "./setup";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const notFound = () => new Response("Not found", { status: 404 });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const secret = (env.CONNECTOR_SECRET ?? "").trim();
    if (secret.length < 24) {
      return new Response("CONNECTOR_SECRET fehlt oder ist kürzer als 24 Zeichen.", { status: 500 });
    }
    const [prefix, route = "", ...rest] = new URL(req.url).pathname.split("/").filter(Boolean);
    // Download links carry their own random token so they can be shared in chat without the secret.
    if (prefix === "dl" && req.method === "GET") return handleDownload(env, route);
    // Everything else lives under /<secret>/... and otherwise looks like an empty site.
    if (!prefix || !safeEqual(prefix, secret) || rest.length) return notFound();
    if (route === "mcp") {
      // A browser opening the MCP URL by mistake lands on the setup page; MCP clients never ask for HTML.
      if (req.method === "GET" && (req.headers.get("Accept") ?? "").includes("text/html")) {
        return Response.redirect(new URL(`/${prefix}/setup`, req.url).toString(), 302);
      }
      return handleMcp(req, env);
    }
    if (route === "setup") return handleSetup(req, env);
    return notFound();
  },

  /** Keeps the Moodle session alive so it does not time out between uses. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const session = await loadSession(env);
    if (!session || session.lastCheckOk === false) return;
    const m = new Moodle(env, session);
    try {
      await m.ajax("core_session_touch", {});
      session.lastCheckOk = true;
      session.lastError = undefined;
    } catch (e) {
      // A failed request (e.g. during the nightly maintenance window) only counts as expiry if Moodle says so.
      if (e instanceof SessionExpiredError) {
        session.lastCheckOk = false;
        session.lastError = "Session abgelaufen";
      } else {
        session.lastError = (e as Error).message;
      }
    }
    session.lastCheckAt = new Date().toISOString();
    await saveSession(env, session);
  },
} satisfies ExportedHandler<Env>;
