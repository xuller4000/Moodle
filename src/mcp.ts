import { Env, loadSession, Moodle, saveSession, SessionExpiredError } from "./moodle";
import { TOOLS } from "./tools";
import { PdfPasswordError } from "./pdf";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "hm-moodle", title: "HM Moodle", version: "0.1.0" };
const INSTRUCTIONS =
  "Lesender Zugriff auf das Moodle der Hochschule München. Typischer Ablauf: list_courses, dann get_course_contents " +
  "mit der Kurs-ID, dann open_url für einzelne Dateien oder Aktivitäten (als Text). Soll der Nutzer die Datei selbst " +
  "bekommen (PDF ansehen, speichern, drucken) oder sind Layout und Abbildungen wichtig, get_file verwenden und den " +
  "Download-Link an den Nutzer weitergeben. Passwortgeschützte PDFs: Passwort beim Nutzer erfragen und als password " +
  "übergeben. Termine über upcoming_deadlines.";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Stateless MCP server over Streamable HTTP (JSON responses, no SSE). */
export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  const responses = [];
  for (const msg of messages) {
    // Notifications and client responses need no answer.
    if (msg.id === undefined || msg.id === null || !msg.method) continue;
    responses.push(await dispatch(msg, env, new URL(req.url).origin));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? responses : responses[0]);
}

async function dispatch(msg: RpcRequest, env: Env, origin: string) {
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        })),
      });
    case "tools/call":
      return rpcResult(msg.id, await callTool(msg.params?.name, msg.params?.arguments ?? {}, env, origin));
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>, env: Env, origin: string) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `Unbekanntes Tool: ${name}` }] };

  const session = await loadSession(env);
  if (!session) {
    return {
      isError: true,
      content: [{ type: "text", text: "Es ist noch keine Moodle-Session hinterlegt. Bitte das Cookie auf der Setup-Seite des Connectors eintragen (Connector-URL mit /setup statt /mcp)." }],
    };
  }
  const m = new Moodle(env, session);
  try {
    const content = await tool.run(m, args, { env, origin, tz: env.TIMEZONE || "Europe/Berlin" });
    if (session.lastCheckOk === false) {
      session.lastCheckOk = true;
      session.lastError = undefined;
      m.dirty = true;
    }
    return { content };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      session.lastCheckOk = false;
      session.lastError = "Session abgelaufen";
      session.lastCheckAt = new Date().toISOString();
      m.dirty = true;
      return {
        isError: true,
        content: [{ type: "text", text: "Die Moodle-Session ist abgelaufen. Bitte im Browser bei Moodle anmelden und das neue MoodleSession-Cookie auf der Setup-Seite des Connectors eintragen (Connector-URL mit /setup statt /mcp)." }],
      };
    }
    if (e instanceof PdfPasswordError) return { isError: true, content: [{ type: "text", text: e.message }] };
    return { isError: true, content: [{ type: "text", text: `Fehler: ${(e as Error).message}` }] };
  } finally {
    if (m.dirty) await saveSession(env, m.session);
  }
}
