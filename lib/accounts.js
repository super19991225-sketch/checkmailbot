const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveMailHost, resolveMailPort, getProvider } = require("./providers");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "accounts.json");

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ accounts: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
  } catch {
    return { accounts: [] };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function maskAccount(account) {
  if (!account) return null;
  const { password, ...rest } = account;
  return {
    ...rest,
    hasPassword: !!password,
    passwordMasked: password ? "••••••••" : "",
  };
}

function normalizeAccount(input = {}, existing = null) {
  const provider = input.provider || existing?.provider || "hostinger";
  const hostInput =
    input.host !== undefined
      ? String(input.host || "").trim()
      : existing?.host || "";
  const preset = getProvider(provider);
  const resolvedHost =
    provider === "custom"
      ? hostInput || existing?.host || ""
      : resolveMailHost(provider, hostInput);
  const resolvedPort = resolveMailPort(
    provider,
    input.port !== undefined ? input.port : existing?.port
  );

  const email = String(input.email || existing?.email || "")
    .trim()
    .toLowerCase();
  const companyName = String(
    input.companyName || input.label || existing?.companyName || ""
  ).trim();
  const password =
    input.password !== undefined && input.password !== ""
      ? String(input.password)
      : existing?.password || "";

  return {
    id: existing?.id || input.id || newId(),
    label: companyName || email.split("@")[0] || "Mailbox",
    companyName: companyName || email.split("@")[1]?.split(".")[0] || "",
    email,
    password,
    provider,
    host: resolvedHost || preset?.host || "",
    port: resolvedPort,
    scanLimit: Number(
      input.scanLimit !== undefined
        ? input.scanLimit
        : existing?.scanLimit !== undefined
          ? existing.scanLimit
          : 0
    ),
    unreadOnly:
      input.unreadOnly !== undefined
        ? !!input.unreadOnly
        : existing?.unreadOnly !== undefined
          ? !!existing.unreadOnly
          : false,
    enabled:
      input.enabled !== undefined
        ? !!input.enabled
        : existing?.enabled !== undefined
          ? !!existing.enabled
          : true,
    sheetId:
      input.sheetId !== undefined
        ? String(input.sheetId || "").trim()
        : existing?.sheetId || "",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function listAccounts() {
  return readStore().accounts.map(maskAccount);
}

function getAccount(id, { includePassword = false } = {}) {
  const account = readStore().accounts.find((a) => a.id === id);
  if (!account) return null;
  return includePassword ? { ...account } : maskAccount(account);
}

function addAccount(input) {
  const store = readStore();
  const account = normalizeAccount(input);
  if (!account.email) throw new Error("Email is required");
  if (!account.password) throw new Error("Password is required");
  if (account.provider === "custom" && !account.host) {
    throw new Error("Custom provider requires an IMAP host");
  }
  if (
    store.accounts.some((a) => a.email.toLowerCase() === account.email)
  ) {
    throw new Error("An account with this email already exists");
  }
  store.accounts.push(account);
  writeStore(store);
  return maskAccount(account);
}

function updateAccount(id, input) {
  const store = readStore();
  const idx = store.accounts.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error("Account not found");
  const account = normalizeAccount(input, store.accounts[idx]);
  if (!account.email) throw new Error("Email is required");
  if (!account.password) throw new Error("Password is required");
  if (account.provider === "custom" && !account.host) {
    throw new Error("Custom provider requires an IMAP host");
  }
  if (
    store.accounts.some(
      (a) => a.id !== id && a.email.toLowerCase() === account.email
    )
  ) {
    throw new Error("An account with this email already exists");
  }
  store.accounts[idx] = account;
  writeStore(store);
  return maskAccount(account);
}

function deleteAccount(id) {
  const store = readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) throw new Error("Account not found");
  writeStore(store);
  return true;
}

/** Seed from .env once when store is empty */
function seedFromEnv() {
  const store = readStore();
  if (store.accounts.length > 0) return null;
  require("dotenv").config({
    path: path.join(__dirname, "..", ".env"),
  });
  const email = process.env.MAIL_USER;
  const password = process.env.MAIL_PASS;
  if (!email || !password) return null;
  const account = normalizeAccount({
    email,
    password,
    provider: process.env.MAIL_PROVIDER || "hostinger",
    host: process.env.MAIL_HOST || "",
    companyName: process.env.COMPANY_NAME || "",
    scanLimit: Number(process.env.SCAN_LIMIT || 0),
    unreadOnly: process.env.UNREAD_ONLY !== "false",
  });
  store.accounts.push(account);
  writeStore(store);
  return maskAccount(account);
}

module.exports = {
  STORE_PATH,
  listAccounts,
  getAccount,
  addAccount,
  updateAccount,
  deleteAccount,
  seedFromEnv,
  maskAccount,
};
