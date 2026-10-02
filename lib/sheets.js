/**
 * Google Sheets export via a Google Cloud service account.
 *
 * Setup (once):
 *   1. Google Cloud console → enable "Google Sheets API" → create a service account → JSON key.
 *   2. Paste the JSON key in Mail Check (Google Sheets settings) → saved to data/google-service-account.json.
 *   3. Share each Google Sheet with the service account email as Editor.
 *   4. Put the sheet URL on the mailbox (Google Sheet URL field).
 */
const fs = require("fs");
const path = require("path");

const KEY_PATH = path.join(__dirname, "..", "data", "google-service-account.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const TAB_COLORS = {
  American: { red: 0.96, green: 0.8, blue: 0.8 },
  Canada: { red: 1, green: 0.95, blue: 0.7 },
  European: { red: 1, green: 0.95, blue: 0.7 },
  Latina: { red: 1, green: 0.95, blue: 0.7 },
  Wellfound: { red: 1, green: 0.88, blue: 0.51 },
  Possible: { red: 1, green: 0.95, blue: 0.8 },
  Summary: { red: 0.84, green: 0.96, blue: 0.89 },
};

function readKey() {
  if (!fs.existsSync(KEY_PATH)) return null;
  try {
    const key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    if (!key.client_email || !key.private_key) return null;
    return key;
  } catch {
    return null;
  }
}

function googleStatus() {
  const key = readKey();
  return {
    configured: !!key,
    clientEmail: key ? key.client_email : "",
    projectId: key ? key.project_id || "" : "",
  };
}

function saveServiceAccountKey(raw) {
  let key;
  try {
    key = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("Not valid JSON — paste the whole service account key file.");
  }
  if (!key || key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error("This is not a service account key (needs type, client_email, private_key).");
  }
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify(key, null, 2));
  return googleStatus();
}

function removeServiceAccountKey() {
  if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
  return googleStatus();
}

/** Accepts a full Google Sheets URL or a bare spreadsheet ID */
function parseSheetId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : "";
}

function sheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

let cachedClient = null;
let cachedEmail = "";
function authClient() {
  const key = readKey();
  if (!key) {
    throw new Error("Google Sheets is not set up — paste a service account key in Settings.");
  }
  if (cachedClient && cachedEmail === key.client_email) return cachedClient;
  const { JWT } = require("google-auth-library");
  cachedClient = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  cachedEmail = key.client_email;
  return cachedClient;
}

async function api(method, url, data) {
  const client = authClient();
  try {
    const res = await client.request({ method, url, data });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 403 || status === 404) {
      throw new Error(
        `${msg} — share the sheet with ${cachedEmail} as Editor, and check the URL.`
      );
    }
    throw new Error(msg);
  }
}

const quoteTab = (name) => `'${String(name).replace(/'/g, "''")}'`;

/**
 * Overwrite region tabs (+ Summary) in a spreadsheet.
 * @param sheetIdOrUrl  spreadsheet URL or ID
 * @param sections      [{ name, rows: [rowObject] }]
 * @param opts.columns  column order (header row)
 */
async function writeGoogleSheet(sheetIdOrUrl, sections, { columns, title = "" } = {}) {
  const id = parseSheetId(sheetIdOrUrl);
  if (!id) throw new Error("Invalid Google Sheet URL / ID");

  const summaryRows = [
    ["Sheet", "Count", "Updated"],
    ...sections.map((s) => [s.name, s.rows.length, ""]),
    ["Total", sections.reduce((n, s) => n + s.rows.length, 0), new Date().toLocaleString()],
  ];
  const tabs = [...sections.map((s) => s.name), "Summary"];

  // 1) Make sure every tab exists
  const meta = await api("GET", `${API}/${id}?fields=properties.title,sheets.properties`);
  const existing = new Map(
    (meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId])
  );
  const missing = tabs.filter((t) => !existing.has(t));
  if (missing.length) {
    const added = await api("POST", `${API}/${id}:batchUpdate`, {
      requests: missing.map((t) => ({
        addSheet: { properties: { title: t, tabColor: TAB_COLORS[t] } },
      })),
    });
    for (const r of added.replies || []) {
      const p = r.addSheet?.properties;
      if (p) existing.set(p.title, p.sheetId);
    }
  }

  // 2) Clear old values, then write fresh ones
  await api("POST", `${API}/${id}/values:batchClear`, {
    ranges: tabs.map((t) => `${quoteTab(t)}!A:Z`),
  });
  const cellValue = (v) => (v === undefined || v === null ? "" : String(v));
  await api("POST", `${API}/${id}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: [
      ...sections.map((s) => ({
        range: `${quoteTab(s.name)}!A1`,
        values: [
          columns.map((c) => (c === "Job site name" ? "Job site" : c)),
          ...s.rows.map((r) =>
            columns.map((c) =>
              cellValue(c === "Job site name" ? r["Job site name"] || r["Job site"] : r[c])
            )
          ),
        ],
      })),
      { range: `${quoteTab("Summary")}!A1`, values: summaryRows },
    ],
  });

  // 3) Bold + frozen header row on each tab
  await api("POST", `${API}/${id}:batchUpdate`, {
    requests: tabs.flatMap((t) => {
      const sheetId = existing.get(t);
      if (sheetId === undefined) return [];
      return [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: TAB_COLORS[t] || TAB_COLORS.Summary,
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
      ];
    }),
  });

  return {
    url: sheetUrl(id),
    title: meta.properties?.title || title,
    counts: Object.fromEntries(sections.map((s) => [s.name, s.rows.length])),
  };
}

module.exports = {
  KEY_PATH,
  googleStatus,
  saveServiceAccountKey,
  removeServiceAccountKey,
  parseSheetId,
  sheetUrl,
  writeGoogleSheet,
};
