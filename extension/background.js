// Pushes the MoodleSession cookie of moodle.hm.edu to the connector whenever it changes,
// and checks every 15 minutes that the connector still holds a working session.

const MOODLE_URL = "https://moodle.hm.edu/";
const COOKIE_NAME = "MoodleSession";
const ALARM = "sync";

async function connectorBase() {
  const { connectorUrl } = await chrome.storage.local.get("connectorUrl");
  if (!connectorUrl) return null;
  // Accepts the setup or the MCP address and strips the last path segment.
  return connectorUrl.trim().replace(/\/+$/, "").replace(/\/(setup|mcp)$/, "");
}

async function fingerprint(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...hash.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setState(state, detail) {
  const entry = { state, detail: detail ?? "", at: new Date().toISOString() };
  await chrome.storage.local.set({ lastSync: entry });
  const [text, color] = { ok: ["", "#2e7d32"], pending: ["…", "#757575"] }[state] ?? ["!", "#c62828"];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  return entry;
}

let running = null;

async function sync(reason) {
  // Avoid overlapping runs when several cookie events arrive at once.
  if (running) return running;
  running = doSync(reason).finally(() => (running = null));
  return running;
}

async function doSync(reason) {
  const base = await connectorBase();
  if (!base) return setState("unconfigured", "Connector-Adresse fehlt. Im Popup eintragen.");

  const cookie = await chrome.cookies.get({ url: MOODLE_URL, name: COOKIE_NAME });
  let status;
  try {
    const res = await fetch(`${base}/api/status`, { cache: "no-store" });
    if (res.status === 404) return setState("error", "Connector-Adresse stimmt nicht (404). Secret prüfen.");
    status = await res.json();
  } catch (e) {
    return setState("error", `Connector nicht erreichbar: ${e.message}`);
  }

  if (!cookie) {
    return status.ok
      ? setState("ok", "Connector-Session aktiv (im Browser gerade nicht bei Moodle angemeldet).")
      : setState("logged_out", "Connector-Session abgelaufen. Bitte in Edge bei moodle.hm.edu anmelden.");
  }

  const fp = await fingerprint(cookie.value);
  if (status.ok && status.fingerprint === fp) return setState("ok", "Connector nutzt die Session dieses Browsers.");

  // A cookie Moodle already rejected (e.g. a not-logged-in guest session) is not sent again.
  const { rejected } = await chrome.storage.local.get("rejected");
  if (rejected === fp && reason !== "manual") {
    return status.ok
      ? setState("ok", "Connector-Session aktiv.")
      : setState("logged_out", "Connector-Session abgelaufen. Bitte in Edge bei moodle.hm.edu anmelden.");
  }

  await setState("pending", "Übertrage Cookie …");
  let result;
  try {
    const res = await fetch(`${base}/api/cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: cookie.value }),
    });
    result = await res.json();
  } catch (e) {
    return setState("error", `Übertragung fehlgeschlagen: ${e.message}`);
  }

  if (result.ok) {
    await chrome.storage.local.remove("rejected");
    return setState("ok", `Cookie übertragen, Moodle-User-ID ${result.userId ?? "?"}.`);
  }
  await chrome.storage.local.set({ rejected: fp });
  if (result.error === "not_logged_in") {
    return status.ok
      ? setState("ok", "Connector-Session aktiv (Browser-Cookie ist nicht angemeldet).")
      : setState("logged_out", "Connector-Session abgelaufen. Bitte in Edge bei moodle.hm.edu anmelden.");
  }
  return setState("error", `Connector meldet: ${result.error}`);
}

let debounce = null;
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (removed || cookie.name !== COOKIE_NAME || !cookie.domain.endsWith("moodle.hm.edu")) return;
  // Moodle swaps the cookie several times during login; wait until it settles.
  clearTimeout(debounce);
  debounce = setTimeout(() => sync("changed"), 3000);
});

chrome.alarms.onAlarm.addListener((alarm) => alarm.name === ALARM && sync("alarm"));

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 15 });
}
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  sync("startup");
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  sync("startup");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "sync") {
    sync("manual").then(sendResponse);
    return true;
  }
});
