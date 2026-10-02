/**
 * CLI scan of saved mailboxes.
 *   node scripts/run-scan.js [accountId ...] [--unread] [--recheck] [--no-tags] [--no-read]
 * No account IDs = every enabled mailbox.
 */
const { listAccounts, getAccount } = require("../lib/accounts");
const { scanAccount } = require("../index");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
let ids = args.filter((a) => !a.startsWith("--"));
if (!ids.length) ids = listAccounts().filter((a) => a.enabled !== false).map((a) => a.id);

(async () => {
  const started = Date.now();
  for (const id of ids) {
    const acc = getAccount(id, { includePassword: true });
    if (!acc) {
      console.log(`Unknown account ${id}`);
      continue;
    }
    console.log(`\n=== ${acc.companyName || acc.email} ===`);
    try {
      await scanAccount(
        {
          ...acc,
          scanLimit: 0,
          unreadOnly: flags.has("--unread"),
          recheckAll: flags.has("--recheck"),
          tagThunderbird: !flags.has("--no-tags"),
          markAsRead: !flags.has("--no-read"),
        },
        {}
      );
    } catch (e) {
      console.log(`ERROR ${acc.email}: ${e.message}`);
    }
  }
  console.log(`\nAll done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
})();
