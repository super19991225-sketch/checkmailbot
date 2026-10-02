/**
 * Per-mailbox record of checked messages.
 *
 * data/records/<accountId>.json
 *   { filterVersion, uidValidity, updatedAt, checked: { [uid]: { at, action, region?, row? } } }
 *
 * A message listed in `checked` is not downloaded again unless the filter
 * version or the mailbox UIDVALIDITY changes, or a re-check is requested.
 */
const fs = require("fs");
const path = require("path");

const RECORDS_DIR = path.join(__dirname, "..", "data", "records");

function recordPath(accountId) {
  return path.join(RECORDS_DIR, `${String(accountId || "default").replace(/[^\w.-]/g, "_")}.json`);
}

function emptyRecord(filterVersion, uidValidity) {
  return {
    filterVersion,
    uidValidity: uidValidity != null ? String(uidValidity) : null,
    updatedAt: null,
    checked: {},
  };
}

/**
 * Load the record for a mailbox. Returns a fresh record when the filter
 * version or UIDVALIDITY no longer matches (UIDs would be meaningless).
 */
function loadRecord(accountId, { filterVersion, uidValidity, reset = false } = {}) {
  const file = recordPath(accountId);
  if (reset || !fs.existsSync(file)) return emptyRecord(filterVersion, uidValidity);
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (rec.filterVersion !== filterVersion) return emptyRecord(filterVersion, uidValidity);
    if (uidValidity != null && rec.uidValidity != null && String(rec.uidValidity) !== String(uidValidity)) {
      return emptyRecord(filterVersion, uidValidity);
    }
    rec.checked = rec.checked || {};
    rec.uidValidity = uidValidity != null ? String(uidValidity) : rec.uidValidity;
    return rec;
  } catch {
    return emptyRecord(filterVersion, uidValidity);
  }
}

function saveRecord(accountId, rec) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  rec.updatedAt = new Date().toISOString();
  const file = recordPath(accountId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file);
}

function setChecked(rec, uid, entry) {
  rec.checked[String(uid)] = { at: new Date().toISOString(), ...entry };
}

function isChecked(rec, uid) {
  return Object.prototype.hasOwnProperty.call(rec.checked, String(uid));
}

/** All kept rows recorded for this mailbox (across every scan) */
function keptRows(rec) {
  return Object.values(rec.checked)
    .filter((e) => e && e.action === "keep" && e.row)
    .map((e) => e.row);
}

function recordStats(rec) {
  const stats = { total: 0 };
  for (const e of Object.values(rec.checked)) {
    stats.total += 1;
    stats[e.action] = (stats[e.action] || 0) + 1;
  }
  return stats;
}

module.exports = {
  RECORDS_DIR,
  loadRecord,
  saveRecord,
  setChecked,
  isChecked,
  keptRows,
  recordStats,
};
