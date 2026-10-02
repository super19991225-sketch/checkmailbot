const { getAccount } = require("../lib/accounts");
const { ImapFlow } = require("imapflow");
const { resolveMailHost, resolveMailPort } = require("../lib/providers");

async function inspect(id, label) {
  const acc = getAccount(id, { includePassword: true });
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
  try {
    const total = client.mailbox.exists || 0;
    let unseen = [];
    try {
      unseen = await client.search({ seen: false }, { uid: true });
    } catch (e) {
      console.log("unseen search err", e.message);
    }
    console.log("\n====", label, acc.email, "====");
    console.log("total", total, "unseen_count", Array.isArray(unseen) ? unseen.length : unseen);
    console.log("permanentFlags", [...(client.mailbox.permanentFlags || [])]);
    console.log("flags", [...(client.mailbox.flags || [])]);

    const from = Math.max(1, total - 39);
    let withLabel = 0;
    let seenN = 0;
    let unseenN = 0;
    const samples = [];
    for await (const msg of client.fetch(`${from}:${total}`, {
      uid: true,
      flags: true,
      envelope: true,
    })) {
      const fl = [...(msg.flags || [])].map(String);
      const hasL = fl.some((f) => /\$label/i.test(f));
      if (hasL) withLabel++;
      if (fl.some((f) => /\\?Seen/i.test(f) && !/Unseen/i.test(f))) seenN++;
      else unseenN++;
      const subj = (msg.envelope?.subject || "").slice(0, 80);
      if (/wellfound|interested in|application/i.test(subj) || hasL) {
        samples.push({ uid: msg.uid, flags: fl, subj });
      }
    }
    console.log("last40 seen-ish", seenN, "unseen-ish", unseenN, "with_$label", withLabel);
    console.log("samples", JSON.stringify(samples.slice(0, 15), null, 2));

    for (const kw of ["$label1", "$label2"]) {
      try {
        const uids = await client.search({ keyword: kw }, { uid: true });
        console.log(
          "search keyword",
          kw,
          "→",
          Array.isArray(uids) ? uids.length : uids
        );
      } catch (e) {
        console.log("search keyword", kw, "ERR", e.message);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

(async () => {
  await inspect("156b038f55775b24", "Zorqiva");
  await inspect("61accb3685e7cd39", "Tek4Real");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
