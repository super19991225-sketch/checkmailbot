const { getAccount } = require("../lib/accounts");
const { ImapFlow } = require("imapflow");
const { resolveMailHost, resolveMailPort } = require("../lib/providers");
const { simpleParser } = require("mailparser");

const NAMES = [
  "Omotayo Odupitan",
  "Maitri Modi",
  "Hamir Mahal",
  "John F Kenny",
  "Jesús Daniel",
  "Jesus Daniel",
  "Martínez García",
  "Martinez Garcia",
  "Kamal Sekar",
];

(async () => {
  const acc = getAccount("156b038f55775b24", { includePassword: true });
  const client = new ImapFlow({
    host: resolveMailHost(acc.provider, acc.host),
    port: resolveMailPort(acc.provider, acc.port),
    secure: true,
    auth: { user: acc.email, pass: acc.password },
    logger: false,
    connectionTimeout: 180000,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const total = client.mailbox.exists || 0;
  const from = Math.max(1, total - 120);
  const hits = [];
  for await (const msg of client.fetch(`${from}:${total}`, {
    uid: true,
    flags: true,
    envelope: true,
    source: true,
  })) {
    const subj = msg.envelope?.subject || "";
    if (!NAMES.some((n) => subj.toLowerCase().includes(n.toLowerCase().split(" ")[0])) &&
        !/Omotayo|Maitri|Hamir|Kenny|Jesús|Jesus Daniel|Kamal Sekar/i.test(subj)) {
      continue;
    }
    if (!NAMES.some((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(subj)) &&
        !/Omotayo Odupitan|Maitri Modi|Hamir Mahal|John F Kenny|Jesús Daniel|Jesus Daniel|Kamal Sekar/i.test(subj)) {
      continue;
    }
    const fl = [...(msg.flags || [])].map(String);
    let city = "";
    let email = "";
    try {
      const p = await simpleParser(msg.source);
      const html = String(p.html || "");
      const text = String(p.text || "");
      const raw =
        html
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
          .replace(/<[^>]+>/g, "\n") +
        "\n" +
        text;
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const nameLine = lines.findIndex((l) =>
        /Omotayo|Maitri Modi|Hamir Mahal|John F Kenny|Jesús|Jesus|Kamal/i.test(l)
      );
      if (nameLine >= 0) {
        city = lines[nameLine + 1] || "";
        for (let i = nameLine; i < Math.min(nameLine + 8, lines.length); i++) {
          const m = lines[i].match(/[\w.+-]+@[\w.-]+\.\w+/);
          if (m && !/wellfound/i.test(m[0])) {
            email = m[0];
            break;
          }
        }
      }
    } catch (_) {}
    hits.push({
      uid: msg.uid,
      subj: subj.slice(0, 90),
      flags: fl,
      city,
      email,
      hasLabel: fl.some((f) => /\$label/i.test(f)),
      seen: fl.some((f) => /Seen/i.test(f)),
    });
  }
  lock.release();
  await client.logout();
  console.log(JSON.stringify(hits, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
