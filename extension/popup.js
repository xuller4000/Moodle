const urlInput = document.getElementById("url");
const statusBox = document.getElementById("status");

function show(entry) {
  if (!entry) return;
  const time = new Date(entry.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
  statusBox.textContent = `${entry.detail} (${time})`;
  statusBox.className = entry.state === "ok" ? "ok" : entry.state === "pending" ? "" : "bad";
}

async function runSync() {
  statusBox.textContent = "Synchronisiere …";
  statusBox.className = "";
  show(await chrome.runtime.sendMessage({ type: "sync" }));
}

chrome.storage.local.get(["connectorUrl", "lastSync"]).then(({ connectorUrl, lastSync }) => {
  if (connectorUrl) urlInput.value = connectorUrl;
  show(lastSync);
});

document.getElementById("save").addEventListener("click", async () => {
  const value = urlInput.value.trim();
  if (!/^https:\/\/[^/]+\.workers\.dev\/[^/]+\/(setup|mcp)\/?$/.test(value)) {
    statusBox.textContent = "Bitte die vollständige Setup- oder MCP-Adresse des Connectors einfügen.";
    statusBox.className = "bad";
    return;
  }
  await chrome.storage.local.set({ connectorUrl: value });
  await chrome.storage.local.remove("rejected");
  await runSync();
});

document.getElementById("sync").addEventListener("click", runSync);
