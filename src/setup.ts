import {
  Env,
  loadSession,
  Moodle,
  normalizeCookie,
  saveSession,
  SessionData,
  SessionExpiredError,
  sessionFingerprint,
} from "./moodle";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmt(iso: string | undefined, tz: string): string {
  if (!iso) return "nie";
  return new Intl.DateTimeFormat("de-DE", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function page(env: Env, s: SessionData | null, message = "", ok = true): Response {
  const tz = env.TIMEZONE || "Europe/Berlin";
  const status = !s
    ? "Noch kein Cookie hinterlegt."
    : s.lastCheckOk === false
      ? `Session ungültig (${esc(s.lastError ?? "abgelaufen")}), geprüft ${fmt(s.lastCheckAt, tz)}.`
      : `Session aktiv (User-ID ${s.userId ?? "?"}), gesetzt ${fmt(s.updatedAt, tz)}, zuletzt geprüft ${fmt(s.lastCheckAt, tz)}.`;
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>HM Moodle Connector</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#222;background:#fafafa}
textarea{width:100%;box-sizing:border-box;font-family:monospace;min-height:5rem}
button{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem}
.msg{padding:.75rem;border-radius:6px;background:${ok ? "#e6f4ea" : "#fde8e8"}}
.status{padding:.75rem;border:1px solid #ddd;border-radius:6px;background:#fff}
code{background:#eee;padding:0 .25rem}
</style></head><body>
<h1>HM Moodle Connector</h1>
${message ? `<p class="msg">${message}</p>` : ""}
<p class="status">${status}</p>
<form method="post">
<p><label for="cookie">Wert des Cookies <code>MoodleSession</code> von moodle.hm.edu:</label></p>
<textarea id="cookie" name="cookie" autocomplete="off" spellcheck="false" placeholder="z. B. 8f3k2..."></textarea>
<p><button name="action" value="save">Speichern und prüfen</button><button name="action" value="check">Nur Verbindung prüfen</button></p>
</form>
<p>So kommst du an das Cookie: bei moodle.hm.edu anmelden, Entwicklertools öffnen (F12), unter
<em>Speicher</em> (Firefox) bzw. <em>Application</em> (Chrome) die Cookies von moodle.hm.edu aufrufen und den Wert von
<code>MoodleSession</code> kopieren. Danach im Browser <strong>nicht</strong> abmelden, sonst wird die Session ungültig.
Einfach den Tab schließen.</p>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function handleSetup(req: Request, env: Env): Promise<Response> {
  const current = await loadSession(env);
  if (req.method !== "POST") return page(env, current);

  const form = await req.formData();
  const action = String(form.get("action") ?? "save");
  const raw = String(form.get("cookie") ?? "").trim();

  let session: SessionData;
  if (action === "save") {
    if (!raw) return page(env, current, "Bitte zuerst ein Cookie einfügen.", false);
    session = { cookie: normalizeCookie(raw), sesskey: "", updatedAt: new Date().toISOString() };
  } else {
    if (!current) return page(env, current, "Es ist noch kein Cookie gespeichert.", false);
    session = current;
  }

  const m = new Moodle(env, session);
  try {
    await m.refreshSesskey();
    session.lastCheckOk = true;
    session.lastError = undefined;
    session.lastCheckAt = new Date().toISOString();
    await saveSession(env, session);
    return page(env, session, `Verbindung funktioniert. Angemeldet als User-ID ${session.userId ?? "?"}.`);
  } catch (e) {
    const msg = e instanceof SessionExpiredError
      ? "Moodle hat das Cookie nicht akzeptiert. Ist der Wert vollständig und bist du im Browser noch angemeldet?"
      : `Fehler: ${esc((e as Error).message)}`;
    if (action === "check") {
      session.lastCheckOk = false;
      session.lastError = e instanceof SessionExpiredError ? "abgelaufen" : (e as Error).message;
      session.lastCheckAt = new Date().toISOString();
      await saveSession(env, session);
    }
    return page(env, action === "check" ? session : current, msg, false);
  }
}

/**
 * JSON endpoints for the browser extension: GET api/status reports the stored session,
 * POST api/cookie validates a cookie against Moodle and stores it only if it is logged in.
 */
export async function handleApi(req: Request, env: Env, action: string): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

  if (action === "status" && req.method === "GET") {
    const s = await loadSession(env);
    if (!s) return json({ configured: false, ok: false });
    return json({
      configured: true,
      ok: s.lastCheckOk !== false,
      userId: s.userId ?? null,
      updatedAt: s.updatedAt,
      lastCheckAt: s.lastCheckAt ?? null,
      lastError: s.lastError ?? null,
      fingerprint: await sessionFingerprint(s.cookie),
    });
  }

  if (action === "cookie" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { cookie?: unknown } | null;
    const raw = typeof body?.cookie === "string" ? body.cookie.trim() : "";
    if (!raw) return json({ ok: false, error: "cookie fehlt" }, 400);
    const session: SessionData = { cookie: normalizeCookie(raw), sesskey: "", updatedAt: new Date().toISOString() };
    try {
      await new Moodle(env, session).refreshSesskey();
    } catch (e) {
      if (e instanceof SessionExpiredError) return json({ ok: false, error: "not_logged_in" }, 401);
      return json({ ok: false, error: (e as Error).message }, 502);
    }
    session.lastCheckOk = true;
    session.lastCheckAt = new Date().toISOString();
    await saveSession(env, session);
    return json({ ok: true, userId: session.userId ?? null });
  }

  return json({ ok: false, error: "not found" }, 404);
}
