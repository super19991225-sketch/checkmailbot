/** Shared IMAP provider presets for CLI + UI */

const PROVIDERS = [
  {
    id: "hostinger",
    label: "Hostinger",
    host: "imap.hostinger.com",
    port: 993,
  },
  {
    id: "namecheap",
    label: "Namecheap / PrivateEmail",
    host: "mail.privateemail.com",
    port: 993,
    hint: "Use your Private Email password or an App Password from Security Center.",
  },
  {
    id: "gmail",
    label: "Gmail / Google Workspace",
    host: "imap.gmail.com",
    port: 993,
    hint: "Use a Google App Password — not your normal Gmail password.",
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    host: "outlook.office365.com",
    port: 993,
    hint: "Work accounts may need an app password or IMAP enabled by admin.",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    host: "imap.zoho.com",
    port: 993,
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    host: "imap.secureserver.net",
    port: 993,
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    host: "imap.mail.yahoo.com",
    port: 993,
    hint: "Yahoo usually needs an App Password.",
  },
  {
    id: "custom",
    label: "Custom IMAP host",
    host: "",
    port: 993,
    hint: "Enter your provider’s IMAP hostname. IMAP SSL port is almost always 993 (not 593).",
  },
];

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS.find((p) => p.id === "custom");
}

function resolveMailHost(provider, host) {
  if (host && String(host).trim()) return String(host).trim();
  const preset = getProvider(provider);
  return preset?.host || "imap.hostinger.com";
}

function resolveMailPort(provider, port) {
  const n = Number(port);
  if (n > 0) return n;
  return getProvider(provider)?.port || 993;
}

function authHintFor(account = {}) {
  const host = String(account.host || resolveMailHost(account.provider, "")).toLowerCase();
  if (host.includes("gmail.com")) {
    return "Gmail login failed. Use a Google App Password, not your normal password.";
  }
  if (host.includes("privateemail.com")) {
    return "Namecheap login failed. Use your Private Email password or App Password.";
  }
  if (host.includes("office365") || host.includes("outlook")) {
    return "Outlook/Microsoft login failed. Check IMAP access or use an app password.";
  }
  return "Login failed. Check email, password, and IMAP host.";
}

module.exports = {
  PROVIDERS,
  getProvider,
  resolveMailHost,
  resolveMailPort,
  authHintFor,
};
