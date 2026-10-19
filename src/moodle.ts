export interface Env {
  MOODLE_KV: KVNamespace;
  MOODLE_BASE_URL: string;
  TIMEZONE: string;
  CONNECTOR_SECRET: string;
}

export interface SessionData {
  cookie: string;
  sesskey: string;
  userId?: number;
  updatedAt: string;
  lastCheckAt?: string;
  lastCheckOk?: boolean;
  lastError?: string;
}

export class SessionExpiredError extends Error {
  constructor(message = "Moodle-Session ist abgelaufen oder ungültig.") {
    super(message);
  }
}

const KV_KEY = "session";
const UA = "Mozilla/5.0 (compatible; moodle-connector/0.1)";

export async function loadSession(env: Env): Promise<SessionData | null> {
  return env.MOODLE_KV.get<SessionData>(KV_KEY, "json");
}

export async function saveSession(env: Env, s: SessionData): Promise<void> {
  await env.MOODLE_KV.put(KV_KEY, JSON.stringify(s));
}

/** Accepts either the bare MoodleSession value or a full cookie header. */
export function normalizeCookie(input: string): string {
  const v = input.trim().replace(/^cookie:\s*/i, "");
  return v.includes("=") ? v : `MoodleSession=${v}`;
}

export interface FetchResult {
  res: Response;
  finalUrl: string;
  /** Set when Moodle redirected to a host outside the Moodle site (e.g. mod/url). */
  external?: boolean;
}

export class Moodle {
  readonly base: string;
  /** True when the session (cookie or sesskey) changed and should be persisted. */
  dirty = false;

  constructor(private env: Env, public session: SessionData) {
    this.base = env.MOODLE_BASE_URL.replace(/\/+$/, "");
  }

  resolve(url: string): string {
    const abs = new URL(url, this.base + "/").toString();
    if (!abs.startsWith(this.base + "/")) {
      throw new Error(`Nur URLs unter ${this.base} sind erlaubt.`);
    }
    return abs;
  }

  private isLoginUrl(url: string): boolean {
    const u = new URL(url);
    if (u.origin !== new URL(this.base).origin) {
      return /shibboleth|idp|saml|login/i.test(u.hostname + u.pathname);
    }
    return /^\/(login\/|auth\/shibboleth)/.test(u.pathname);
  }

  private absorbCookies(res: Response): void {
    const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    const jar = new Map<string, string>();
    for (const part of this.session.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    let changed = false;
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      const i = first.indexOf("=");
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (!value || value === "deleted") {
        if (name === "MoodleSession") throw new SessionExpiredError();
        continue;
      }
      if (jar.get(name) !== value) {
        jar.set(name, value);
        changed = true;
      }
    }
    if (changed) {
      this.session.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      this.dirty = true;
    }
  }

  /** Fetches a Moodle URL with the session cookie, following redirects inside Moodle. */
  async fetch(url: string, init: RequestInit = {}, maxRedirects = 6): Promise<FetchResult> {
    let current = this.resolve(url);
    let method = init.method ?? "GET";
    let body = init.body;
    for (let i = 0; i <= maxRedirects; i++) {
      const headers = new Headers(init.headers);
      headers.set("Cookie", this.session.cookie);
      headers.set("User-Agent", UA);
      const res = await fetch(current, { method, body, headers, redirect: "manual" });
      this.absorbCookies(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("Location");
        if (!loc) return { res, finalUrl: current };
        const next = new URL(loc, current).toString();
        if (this.isLoginUrl(next)) throw new SessionExpiredError();
        if (!next.startsWith(this.base + "/")) return { res, finalUrl: next, external: true };
        current = next;
        method = "GET";
        body = undefined;
        continue;
      }
      if (this.isLoginUrl(current)) throw new SessionExpiredError();
      return { res, finalUrl: current };
    }
    throw new Error("Zu viele Weiterleitungen.");
  }

  /** Loads the dashboard to get a fresh sesskey (and verify that the cookie works). */
  async refreshSesskey(): Promise<void> {
    const { res } = await this.fetch("/my/");
    const html = await res.text();
    const m = html.match(/"sesskey":"([^"]+)"/);
    if (!m) throw new SessionExpiredError();
    const uid = html.match(/"userId":(\d+)/);
    this.session.sesskey = m[1];
    if (uid) this.session.userId = Number(uid[1]);
    this.dirty = true;
  }

  /** Calls a Moodle web service function through the AJAX endpoint used by the web UI. */
  async ajax<T = unknown>(methodname: string, args: Record<string, unknown>, retried = false): Promise<T> {
    if (!this.session.sesskey) await this.refreshSesskey();
    const url = `/lib/ajax/service.php?sesskey=${encodeURIComponent(this.session.sesskey)}&info=${methodname}`;
    const { res } = await this.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify([{ index: 0, methodname, args }]),
    });
    const json: any = await res.json().catch(() => null);
    if (!json) throw new Error(`Moodle lieferte keine gültige Antwort für ${methodname} (HTTP ${res.status}).`);
    const item = Array.isArray(json) ? json[0] : json;
    if (!item.error) return item.data as T;
    const code: string = item.exception?.errorcode ?? item.errorcode ?? "";
    const message: string = item.exception?.message ?? item.error ?? "unbekannter Fehler";
    if (code === "invalidsesskey" && !retried) {
      await this.refreshSesskey();
      return this.ajax<T>(methodname, args, true);
    }
    if (["servicerequireslogin", "requireloginerror", "sessionexpired", "invalidsesskey"].includes(code)) {
      throw new SessionExpiredError();
    }
    throw new Error(`Moodle-Fehler bei ${methodname}: ${message}${code ? ` (${code})` : ""}`);
  }
}
