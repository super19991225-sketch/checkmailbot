/**
 * Local multi-mail UI server
 *   npm run ui  →  http://localhost:3847
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  listAccounts,
  getAccount,
  addAccount,
  updateAccount,
  deleteAccount,
  seedFromEnv,
} = require("./lib/accounts");
const { PROVIDERS } = require("./lib/providers");
const { scanAccount, testAccount } = require("./index");

const PORT = Number(process.env.UI_PORT || 3855);
const EXPORTS_DIR = path.join(__dirname, "exports");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (/\.(?:html|js|css)$/i.test(req.path) || req.path === "/" || req.path === "") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, maxAge: 0 }));

seedFromEnv();

app.get("/api/providers", (_req, res) => {
  res.json({
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      host: p.host,
      port: p.port,
      hint: p.hint || "",
    })),
  });
});

app.post("/api/accounts/test", async (req, res) => {
  try {
    const body = req.body || {};
    let account = null;
    if (body.id) {
      account = getAccount(body.id, { includePassword: true });
      if (!account) return res.status(404).json({ error: "Account not found" });
      if (body.password) account.password = body.password;
      if (body.host) account.host = body.host;
      if (body.port) account.port = body.port;
      if (body.provider) account.provider = body.provider;
    } else {
      account = {
        email: body.email,
        password: body.password,
        provider: body.provider || "custom",
        host: body.host || "",
        port: body.port,
      };
    }
    const result = await testAccount(account);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message, ok: false });
  }
});

/** In-memory scan job (one at a time) */
let job = {
  id: null,
  status: "idle", // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  accountIds: [],
  currentAccountId: null,
  logs: [],
  results: [],
  error: null,
};

function pushLog(entry) {
  const line = {
    at: new Date().toISOString(),
    ...entry,
  };
  job.logs.push(line);
  if (job.logs.length > 2000) job.logs = job.logs.slice(-1500);
  return line;
}

function publicJob() {
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    accountIds: job.accountIds,
    currentAccountId: job.currentAccountId,
    logs: job.logs.slice(-200),
    results: job.results,
    error: job.error,
  };
}

app.get("/api/accounts", (_req, res) => {
  try {
    res.json({ accounts: listAccounts() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/accounts", (req, res) => {
  try {
    const account = addAccount(req.body || {});
    res.status(201).json({ account });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/accounts/:id", (req, res) => {
  try {
    const account = updateAccount(req.params.id, req.body || {});
    res.json({ account });
  } catch (e) {
    const code = e.message === "Account not found" ? 404 : 400;
    res.status(code).json({ error: e.message });
  }
});

app.delete("/api/accounts/:id", (req, res) => {
  try {
    deleteAccount(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    const code = e.message === "Account not found" ? 404 : 400;
    res.status(code).json({ error: e.message });
  }
});

app.get("/api/exports", (_req, res) => {
  try {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const files = fs
      .readdirSync(EXPORTS_DIR)
      .filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$") && !f.includes(".tmp."))
      .map((name) => {
        const full = path.join(EXPORTS_DIR, name);
        const st = fs.statSync(full);
        return {
          name,
          size: st.size,
          mtime: st.mtime.toISOString(),
          url: `/api/exports/${encodeURIComponent(name)}`,
        };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      .slice(0, 40);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/exports/:name", (req, res) => {
  const name = path.basename(req.params.name);
  if (!name.endsWith(".xlsx") || name.startsWith("~$")) {
    return res.status(400).json({ error: "Invalid file" });
  }
  const full = path.join(EXPORTS_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Not found" });
  res.download(full, name);
});

app.get("/api/scan", (_req, res) => {
  res.json({ job: publicJob() });
});

app.get("/api/scan/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let lastLen = 0;
  const send = () => {
    const pj = publicJob();
    if (pj.logs.length !== lastLen || true) {
      lastLen = pj.logs.length;
      res.write(`data: ${JSON.stringify(pj)}\n\n`);
    }
  };
  send();
  const timer = setInterval(send, 800);
  req.on("close", () => clearInterval(timer));
});

app.post("/api/scan", async (req, res) => {
  if (job.status === "running") {
    return res.status(409).json({ error: "A scan is already running", job: publicJob() });
  }

  const accountIds = Array.isArray(req.body?.accountIds)
    ? req.body.accountIds.filter(Boolean)
    : [];
  if (!accountIds.length) {
    return res.status(400).json({ error: "Select at least one account" });
  }

  const accounts = accountIds
    .map((id) => getAccount(id, { includePassword: true }))
    .filter(Boolean);
  if (!accounts.length) {
    return res.status(400).json({ error: "No matching accounts found" });
  }

  // Run-time overrides from UI
  const unreadOverride =
    typeof req.body?.unreadOnly === "boolean" ? req.body.unreadOnly : null;
  const tagOverride =
    typeof req.body?.tagThunderbird === "boolean"
      ? req.body.tagThunderbird
      : null;
  const markReadOverride =
    typeof req.body?.markAsRead === "boolean" ? req.body.markAsRead : null;
  const scanAll =
    req.body?.scanAll !== false &&
    (req.body?.scanAll === true ||
      req.body?.scanAll === undefined ||
      req.body?.scanLimit === 0 ||
      req.body?.scanLimit === "0");
  const scanLimitOverride = scanAll
    ? 0
    : typeof req.body?.scanLimit === "number" && req.body.scanLimit > 0
      ? req.body.scanLimit
      : null;
  const scanAccounts = accounts.map((a) => ({
    ...a,
    unreadOnly: unreadOverride !== null ? unreadOverride : !!a.unreadOnly,
    tagThunderbird:
      tagOverride !== null
        ? tagOverride
        : a.tagThunderbird !== false,
    markAsRead:
      markReadOverride !== null
        ? markReadOverride
        : a.markAsRead !== false,
    scanLimit:
      scanLimitOverride !== null ? scanLimitOverride : a.scanLimit ?? 0,
  }));

  job = {
    id: `job-${Date.now()}`,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    accountIds: scanAccounts.map((a) => a.id),
    currentAccountId: null,
    logs: [],
    results: [],
    error: null,
    unreadOnly:
      unreadOverride !== null
        ? unreadOverride
        : scanAccounts.some((a) => a.unreadOnly),
    tagThunderbird: scanAccounts.some((a) => a.tagThunderbird !== false),
  };

  res.status(202).json({ job: publicJob() });

  (async () => {
    try {
      for (const account of scanAccounts) {
        job.currentAccountId = account.id;
        pushLog({
          type: "account",
          message: `Starting ${account.companyName || account.email}${account.unreadOnly ? " (unread only)" : ""}${!account.scanLimit || account.scanLimit <= 0 ? " (entire inbox)" : ` (last ${account.scanLimit})`}${account.tagThunderbird !== false ? " + tags" : ""}${account.markAsRead !== false || account.unreadOnly ? " + mark read" : ""}…`,
          accountId: account.id,
        });
        const result = await scanAccount(account, {
          onProgress: (ev) => {
            pushLog({
              type: ev.type || "log",
              message: ev.message || "",
              accountId: account.id,
            });
          },
        });
        job.results.push({
          accountId: account.id,
          email: account.email,
          companyName: account.companyName,
          ...result,
          downloadUrl: result.fileName
            ? `/api/exports/${encodeURIComponent(result.fileName)}`
            : null,
        });
        pushLog({
          type: "result",
          message: `Finished ${account.email}: Wellfound ${result.wellfound || result.counts?.Wellfound || 0}, American ${result.counts?.American || 0}, European ${result.counts?.European || 0}, Latina ${result.counts?.Latina || 0}, tagged ${result.tagged || 0}, markedRead ${result.markedRead || 0}`,
          accountId: account.id,
        });
      }
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      job.currentAccountId = null;
      pushLog({ type: "done", message: "All selected accounts finished." });
    } catch (e) {
      job.status = "error";
      job.error = e.message || String(e);
      job.finishedAt = new Date().toISOString();
      pushLog({ type: "error", message: job.error });
    }
  })();
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Mail Check UI → http://127.0.0.1:${PORT}`);
}).on("error", (err) => {
  // Electron (or a second launch) can reuse an already-running local server
  if (err && err.code === "EADDRINUSE") {
    console.log(`Port ${PORT} already in use — using existing Mail Check server`);
    return;
  }
  console.error(`Failed to bind port ${PORT}:`, err.message);
  process.exit(1);
});
