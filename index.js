/**
 * Mail Check — multi-mailbox recruiter scanner
 *
 *   npm run ui   → http://localhost:3855
 *   npm start    → CLI from .env
 *
 * Output: exports/{company} - {YYYY-MM-DD}.xlsx
 * Sheets: American | Canada | European | Latina | Possible
 * Job-site location: profile city + university (Wellfound, Hubstaff, GoHire, and forwarded boards)
 * Tags: Thunderbird colors ($label1 red, $label2 yellow, $label3 possible) + star
 * Also files kept mail into IMAP folders Mail Check/American|Canada|European|Latina|Possible
 * Region engine: lib/regions.js
 */
require("dotenv").config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const ExcelJS = require("exceljs");
const https = require("https");
const fs = require("fs");
const path = require("path");
const {
  resolveMailHost,
  resolveMailPort,
  authHintFor,
} = require("./lib/providers");
const { parseCandidate } = require("./lib/parsers");
const {
  resolveApplicantPlace,
  filterApplicantLocation,
  enrichKnownCity,
  isJobHub,
  isVagueMetro,
  stripNoise,
  extractPhone,
  matchLocation,
  phoneRegion,
} = require("./lib/regions");
const {
  loadRecord,
  saveRecord,
  setChecked,
  isChecked,
  keptRows,
} = require("./lib/records");
const { writeGoogleSheet } = require("./lib/sheets");

const KEEP_REGIONS = ["American", "Canada", "EU", "Latin American"];

// Bump when check/filter rules change so recorded messages are re-checked once
const FILTER_VERSION = "2026-10-02.1";

function senderText(envelope) {
  return (envelope?.from || [])
    .map((a) => `${a.name || ""} ${a.address || ""}`)
    .join(" ");
}

/** Export label: companyName, or domain from email (e.g. geniusxlab) */
function exportBaseNameFor(account = {}) {
  if (account.companyName) return clean(account.companyName);
  const domain = (account.email || "").split("@")[1] || "mail";
  const brand = domain.split(".")[0] || "mail";
  return brand;
}

function exportFileNameFor(account = {}) {
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const base =
    exportBaseNameFor(account).replace(/[<>:"/\\|?*]/g, "").trim() || "mail";
  return `${base} - ${stamp}.xlsx`;
}

function clean(v) {
  return String(v || "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToLines(html = "", text = "") {
  const raw =
    (html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "\n") +
    "\n" +
    (text || "");
  return raw
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}

/** Known job boards / ATS platforms (including when their mail is forwarded) */
const JOB_SITE_RE =
  /wellfound|angel\.co|angellist|talent@wellfound|hubstaff|sulekha|cazvid|gohire|barefoot|indeed|ziprecruiter|glassdoor|dice\.com|workable|lever\.co|greenhouse|idealist|\[zorqiva\]|zorqiva careers/i;

function isWellfoundMail(subject = "", from = "", blob = "") {
  const h = `${subject} ${from} ${String(blob || "").slice(0, 1200)}`.toLowerCase();
  return (
    /wellfound\.com|talent@wellfound|@wellfound\.|angel\.co|angellist/i.test(h) ||
    /\bis interested in\b/i.test(subject)
  );
}

/** True when the message is (or forwards) an application from a known job site */
function isJobSiteMail(subject = "", from = "", blob = "") {
  if (isWellfoundMail(subject, from, blob)) return true;
  const raw = String(subject || "");
  const subj = unwrapSubject(raw);
  const h = `${subj} ${from} ${String(blob || "").slice(0, 2500)}`;
  if (JOB_SITE_RE.test(h)) return true;
  if (/linkedin/i.test(h) && /applied|application|interested in|easy apply/i.test(h)) return true;
  if (/tek4real|geniusxlab|genius.?lab/i.test(h) && /application|applied|location\s*[:|]/i.test(h))
    return true;
  // Forwarded applicant packet from any board / form
  if (/^(?:fwd?|fw)\s*:/i.test(raw) && /applied|application|interested in|current location|location\s*[:|]/i.test(h)) {
    return true;
  }
  return false;
}

/** Strip Fwd:/FW:/Re: so Wellfound / forwarded subjects still parse */
function unwrapSubject(subject = "") {
  return String(subject || "")
    .replace(/^((?:fwd?|fw|re)\s*:\s*)+/i, "")
    .trim();
}

function isJobApplication(subject = "", from = "", body = "") {
  const subj = unwrapSubject(subject);
  const header = `${subj} ${from}`.toLowerCase();
  const blob = `${header} ${String(body || "").slice(0, 1500)}`.toLowerCase();
  if (
    /100\+ candidates|connection request|your ad|could do more|newsletter|job alert|jobalerts-noreply|invite|invitation|accepted your invitation|explore their network|impressions last week|writing help|doomers|messaged you|coderbyte|calendly|\bis hiring\b|new listings|listings match|viewed your profile|you may know|popular in your network|your next steps|we miss you|expiring jobs|top posts|search appearances|candidates match your search/i.test(
      header
    )
  ) {
    return false;
  }
  // Wellfound applications and other known job-site alerts always count
  if (isJobSiteMail(subj, from, body)) return true;
  return (
    /is interested in|application|applied for|applied to|solicitud de empleo|perfil asistente|junior |senior |full.?stack|software engineer|developer|virtual assistant|wordpress|asistente|candidatura|resume|gohire|barefoot|engineer/i.test(
      blob
    )
  );
}

function jobSite(subject, from, text) {
  const subj = unwrapSubject(subject);
  const b = `${subj} ${from} ${text.slice(0, 2500)}`.toLowerCase();
  if (/wellfound|angel\.co|angellist|talent@wellfound/i.test(b) || /is interested in/i.test(subj))
    return "Wellfound";
  if (/hubstaff/i.test(b)) return "Hubstaff";
  if (/sulekha/i.test(b)) return "Sulekha";
  if (/cazvid/i.test(b)) return "CazVid";
  if (/gohire|barefoot/i.test(b)) return "GoHire";
  if (/indeed/i.test(b)) return "Indeed";
  if (/ziprecruiter/i.test(b)) return "ZipRecruiter";
  if (/glassdoor/i.test(b)) return "Glassdoor";
  if (/workable/i.test(b)) return "Workable";
  if (/lever\.co/i.test(b)) return "Lever";
  if (/greenhouse/i.test(b)) return "Greenhouse";
  if (/dice\.com/i.test(b)) return "Dice";
  if (/idealist/i.test(b)) return "Idealist";
  if (/\[zorqiva\]|zorqiva careers/.test(b)) return "Zorqiva Careers";
  if (/geniusxlab|genius.?lab/.test(b)) return "GeniusXLab";
  if (/tek4real/.test(b)) return "Tek4Real";
  if (/linkedin/.test(b) || /linkedin\.com/.test(from.toLowerCase())) return "LinkedIn";
  return "Other / Email";
}

function nameFromSubject(subject) {
  const subj = unwrapSubject(subject);
  const a = subj.match(/^(.+?)\s+is interested in\s+/i);
  if (a) return clean(a[1]);
  // Application: Role — Name  OR  Application for Role — Name
  const app = subj.match(
    /Application(?:\s+for)?\s*[:—\-–]?\s*.+?[—\-–]\s*(.+)$/i
  );
  if (app) return clean(app[1]);
  const b = subj.match(/Application\s*[—\-–:]\s*.+?\s*[—\-–]\s*(.+)$/i);
  if (b) return clean(b[1]);
  // "Senior Full-Stack Engineer — Jesús Manuel..."
  const dashName = subj.match(
    /(?:Engineer|Developer|Designer|Assistant|Intern)\s*[—\-–]\s*(.+)$/i
  );
  if (dashName && !/for\s*,?\s*$/i.test(dashName[1])) return clean(dashName[1]);
  return "";
}

function badLoc(v) {
  if (!v || v.length < 2 || v.length > 55) return true;
  if (
    /^(accept|reject|school|work|skills|achievements|profile|software|engineer|developer|full-?stack|frontend|backend|applied|position|replying|present|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(
      v
    )
  )
    return true;
  if (/@|https?:|·|^—$/i.test(v)) return true;
  if (
    /react|next\.?js|node|typescript|javascript|aws|bachelor|b\.?tech|data entry|high school,/i.test(
      v
    )
  )
    return true;
  // Sentence fragments / scrape garbage (never treat as a place)
  if (isGarbageLocation(v)) return true;
  return false;
}

/** Reject English sentence scraps mistaken for cities */
function isGarbageLocation(v) {
  const s = clean(v);
  if (!s) return true;
  if (/^[a-z]\.\s/i.test(s)) return true; // "s. The integration..."
  if (
    /\b(integration|actively|successfully|implemented|building|experience|unrestricted|work authorization|authorized to work|work permit|visa status)\b/i.test(
      s
    )
  )
    return true;
  const stop = (
    s.match(
      /\b(the|is|are|was|were|have|has|been|this|that|with|from|for|and|now|used|into|onto|about|which|where|when)\b/gi
    ) || []
  ).length;
  if (stop >= 2) return true;
  if ((s.match(/\s+/g) || []).length >= 5 && stop >= 1) return true;
  return false;
}

const COUNTRY_TOKEN =
  "United States|USA|Canada|Mexico|Brazil|Argentina|Colombia|Spain|Italy|France|Germany|Portugal|Poland|Ukraine|Romania|El Salvador|Guatemala|India|Pakistan|Nigeria|Egypt|Tunisia|Algeria|Peru|Chile|Netherlands|Belgium|Sweden|Ireland|Austria|Switzerland|Latvia|Lithuania|Estonia";

/** Clean messy resume/body locations into a usable place string */
function sanitizeLocation(loc) {
  let s = clean(loc);
  if (!s) return "";
  s = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

  // "Germany with unrestricted work" → Germany
  const withPhrase = s.match(
    new RegExp(`^(${COUNTRY_TOKEN})\\s+with\\b`, "i")
  );
  if (withPhrase) return clean(withPhrase[1]);
  if (/\b(unrestricted|work authorization|authorized to work|work permit)\b/i.test(s)) {
    const c = s.match(new RegExp(`\\b(${COUNTRY_TOKEN})\\b`, "i"));
    return c ? clean(c[1]) : "";
  }

  // Street / postal → city, country
  if (/\b(carrera|calle|street|ave\.?|avenue|apt\.?|suite|boulevard|blvd|#\d|\d{4,})\b/i.test(s)) {
    const cityCountry = s.match(
      new RegExp(
        `([A-Za-zÁÉÍÓÚÑáéíóúñ .'-]{3,40}),\\s*(${COUNTRY_TOKEN})\\b`,
        "i"
      )
    );
    if (cityCountry) return clean(`${cityCountry[1]}, ${cityCountry[2]}`);
    const countryOnly = s.match(new RegExp(`\\b(${COUNTRY_TOKEN})\\b`, "i"));
    if (countryOnly) return clean(countryOnly[1]);
  }

  // "Oregon State University Corvallis, OR" → Corvallis, OR
  if (/university|college|institute/i.test(s)) {
    const matches = [
      ...s.matchAll(/\b([A-Z][a-zA-Z.'-]{2,}),\s*([A-Z]{2})\b/g),
    ];
    const last = matches
      .filter((m) => !/university|college|institute/i.test(m[1]))
      .pop();
    if (last) return clean(`${last[1]}, ${last[2]}`);
  }

  // "Zeuz Waterloo, Canada" / company prefix before City, Country
  const prefixed = s.match(
    new RegExp(
      `^[A-Z][A-Za-z0-9&'.-]{1,24}\\s+([A-Z][a-zA-Z'-]{2,24}(?:\\s[A-Z][a-zA-Z'-]{2,24})?,\\s*(?:${COUNTRY_TOKEN}))\\b`
    )
  );
  if (
    prefixed &&
    !/^(New|North|South|East|West|San|Los|Las|Fort|Saint|Santa|St)\b/i.test(s)
  ) {
    return clean(prefixed[1]);
  }

  // "Germany with unrestricted…" already handled; also strip trailing junk after country
  const countryTrail = s.match(
    new RegExp(`^(${COUNTRY_TOKEN})\\b.*$`, "i")
  );
  if (
    countryTrail &&
    /\b(with|unrestricted|authorization|permit|visa)\b/i.test(s)
  ) {
    return clean(countryTrail[1]);
  }

  if (badLoc(s) || isGarbageLocation(s)) return "";
  return enrichKnownCity(s);
}

function vagueLoc(v) {
  // Work-mode / reject continents only — Europe/Canada/US are valid keep regions
  return /^(remote|flexible|india|africa|asia|pakistan|indonesia)$/i.test(
    clean(v)
  );
}

/** Reject phrase-names / role titles mistaken for people */
function normalizePersonName(name) {
  return clean(name)
    .replace(/^(full\s*name|name|candidate)\s*[:\-–—]\s*/i, "")
    .replace(/[.|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRealPersonName(name) {
  const n = normalizePersonName(name);
  if (!n || n === "?" || n.length < 4 || n.length > 55) return false;
  if (/^barefoot student$/i.test(n)) return false;
  if (/,|\//.test(n)) return false; // locations or "Life/Health Insurance Agent"
  if (/\d{3,}/.test(n)) return false; // IDs stuck on names
  if (
    /^(contact|profile|resume|curriculum(?:\s+vitae)?|vitae|objective|references|about(?:\s+me)?|personal(?:\s+info(?:rmation)?)?|managing\s+director|independent\s+broker|life\/?health(?:\s+insurance)?(?:\s+agent)?|form\s+submission(?:\s+issue)?|director|ceo|cto|founder|homepage|portfolio|cv)$/i.test(
      n
    )
  ) {
    return false;
  }
  if (
    /\b(interested|looking|writing|apply|opportunity|available|eager|founder|confident|completing|currently|still|always|super|very|ready|also|junior|senior|full.?stack|software engineer|virtual assistant|role availability|what draws|draws me|experience|education|skills|projects|summary|architecture|websockets|marketing|hospital|university|student|engineer|developer|profile|stack|director|manager|contact|curriculum|vitae|resume|objective|references|broker|consultant|specialist|analyst|independent|insurance|agent|department|submission|issue|agency|company|corporation|inc|llc|ltd|team|office)\b/i.test(
      n
    )
  ) {
    return false;
  }
  // "City of Goodyear IT Department"
  if (/\bcity of\b/i.test(n)) return false;
  if (/\bi'?m\b/i.test(n) || /\.\s/i.test(n)) return false;
  // ALL-CAPS section headers (WORK EXPERIENCE, CONTACT, etc.)
  if (n === n.toUpperCase() && !/[áéíóúñ]/i.test(n)) {
    const words = n.split(/\s+/);
    if (
      words.length === 1 &&
      /^(CONTACT|PROFILE|RESUME|SUMMARY|OBJECTIVE|REFERENCES|EDUCATION|EXPERIENCE|SKILLS|PROJECTS|PORTFOLIO|CV)$/i.test(
        n
      )
    ) {
      return false;
    }
    if (n.length > 8 && words.length <= 3 && !/^[A-Z]+ [A-Z]+$/.test(n))
      return false;
    if (words.length >= 2 && /EXPERIENCE|EDUCATION|SKILLS|SUMMARY|PROJECT/i.test(n))
      return false;
  }
  if (/\band\s*$/i.test(n)) return false; // "Dean Fox and"
  const parts = n.split(/\s+/).filter(Boolean);
  // Prefer first+last; single tokens are usually truncated headers
  if (parts.length < 2 || parts.length > 5) return false;
  const nameLike = parts.filter(
    (p) =>
      /^[A-ZÁÉÍÓÚÑÄÖÜ][a-zA-ZáéíóúñäöüÁÉÍÓÚÑ.'’-]*$/.test(p) ||
      /^[A-ZÁÉÍÓÚÑ]{2,}$/.test(p) // JOHN / DAVYDOVYCH
  );
  if (nameLike.length < 2) return false;
  return true;
}

/** linkedin.com/in/evellyn-varga → "Evellyn Varga" */
function nameFromLinkedIn(url) {
  const m = String(url || "").match(
    /linkedin\.com\/in\/([A-Za-z0-9_%-]+)/i
  );
  if (!m) return "";
  const slug = decodeURIComponent(m[1])
    .replace(/[_]+/g, "-")
    .replace(/-\d{2,}$/g, "") // trailing id digits
    .replace(/-iii$/i, "")
    .replace(/-ii$/i, "")
    .replace(/-iv$/i, "");
  const parts = slug
    .split("-")
    .map((p) => p.trim())
    .filter((p) => p && !/^\d+$/.test(p) && p.length > 1);
  if (parts.length < 2) return "";
  const titled = parts
    .slice(0, 4)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
  return isRealPersonName(titled) ? titled : "";
}

function nameFromResume(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 8);
  for (const line of lines) {
    if (/@|http|linkedin|github|phone|tel:|\d{3}[-.\s]?\d{3}/i.test(line))
      continue;
    if (
      /^(summary|experience|education|skills|projects|technical|contact|curriculum|resume|objective|references)/i.test(
        line
      )
    )
      continue;
    const candidate = normalizePersonName(line.split(/[|•·]/)[0]);
    if (isRealPersonName(candidate)) return candidate;
  }
  return "";
}

/** Keep confirmed applicants, and every other real applicant who is not a clear reject */
function isRealCandidate(row, hasResume) {
  const hasLink =
    !!clean(row["LinkedIn profile"]) ||
    !!clean(row["GitHub / Portfolio"]);
  const hasEmail =
    !!clean(row.Email) &&
    !/geniusxlab|zorqiva|tek4real|noreply|no-reply/i.test(row.Email);
  const nameOk = isRealPersonName(row.Name);
  if (!nameOk) return false;
  // Job-site / forwarded platform mail — name + platform location is enough
  const site = row["Job site name"] || "";
  if (site && site !== "Other / Email") {
    return row.Class === "Possible" || KEEP_REGIONS.includes(row.Region);
  }
  if (!(hasResume || hasEmail || hasLink)) return false;
  if (row.Class === "Possible") return true;
  if (!KEEP_REGIONS.includes(row.Region)) return false;
  if (!isSolidKeepLocation(row["Current location"], row.Region)) return false;
  return true;
}

function findEmail(lines, blob) {
  const skip =
    /geniusxlab|zorqiva|tek4real|noreply|no-reply|contact@|talent@wellfound|@wellfound\.com|angel\.co|donotreply|do-not-reply/i;
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})$/i);
    if (m && !skip.test(m[1])) return m[1];
  }
  const all = String(blob || "").match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  );
  if (!all) return "";
  const hit = all.find((e) => !skip.test(e));
  return hit || "";
}

function findLinkedIn(blob) {
  return (
    blob
      .match(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i)?.[0]
      ?.replace(/[),.;]+$/, "") || ""
  );
}

function findGithub(blob) {
  const m = blob.match(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_-]+)/i);
  if (!m) return { url: "", user: "" };
  if (/^(features|pricing|about|login|settings|topics)$/i.test(m[1])) {
    return { url: "", user: "" };
  }
  return { url: `https://github.com/${m[1]}`, user: m[1] };
}

function findPortfolio(blob) {
  const m =
    blob.match(
      /https?:\/\/(?:www\.)?[^\s<>"']+(?:portfolio|vercel\.app|netlify\.app|carrd\.co|github\.io)[^\s<>"']*/i
    ) || blob.match(/Portfolio\s*[:|]?\s*(https?:\/\/[^\s<>"']+)/i);
  return m ? clean((m[1] || m[0]).replace(/[),.;]+$/, "")) : "";
}

function namesLooselyMatch(a, b) {
  const na = clean(a).toLowerCase().replace(/\./g, "");
  const nb = clean(b).toLowerCase().replace(/\./g, "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = na.split(/\s+/).filter(Boolean);
  const pb = nb.split(/\s+/).filter(Boolean);
  if (!pa.length || !pb.length) return false;
  // same first + last token (ignore middle initials)
  return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
}

/** Wellfound: Name → City → · → Title */
function wellfoundCity(lines, name) {
  if (!name) return "";
  for (let i = 0; i < lines.length; i++) {
    if (!namesLooselyMatch(lines[i], name)) continue;
    const a = lines[i + 1];
    const b = lines[i + 2];
    if (a && (b === "·" || b === "•") && !badLoc(a)) return clean(a);
    if (a && /[·•]/.test(a)) {
      const city = clean(a.split(/[·•]/)[0]);
      if (!badLoc(city)) return city;
    }
    // HTML→lines often yields City then · on next lines
    if (a && !badLoc(a) && !/@|http/i.test(a) && a.length < 40) {
      if (b === "·" || b === "•") return clean(a);
      if (
        b &&
        /engineer|developer|designer|product|stack|frontend|backend/i.test(b)
      ) {
        return clean(a);
      }
    }
  }
  for (let i = 0; i < lines.length - 2; i++) {
    if (
      (lines[i + 1] === "·" || lines[i + 1] === "•") &&
      /engineer|developer|designer|product|stack|frontend|backend/i.test(
        lines[i + 2] || ""
      ) &&
      !badLoc(lines[i])
    ) {
      return lines[i];
    }
  }
  return "";
}

/** Wellfound "Looking for … in City" preferred work city */
function wellfoundLookingFor(lines) {
  const start = lines.findIndex((l) => /^looking for$/i.test(l));
  if (start < 0) return "";
  for (let i = start + 1; i < Math.min(start + 14, lines.length); i++) {
    if (/^job search status$|^skills$|^school$|^work$/i.test(lines[i])) break;
    if (/^in$/i.test(lines[i]) && lines[i + 1]) {
      const loc = clean(String(lines[i + 1]).replace(/\.+$/, ""));
      if (loc && !badLoc(loc) && loc.length >= 2) return loc;
    }
    const m = lines[i].match(/^in\s+(.+?)\.?\s*$/i);
    if (m) {
      const loc = clean(m[1].replace(/\.+$/, ""));
      if (loc && !badLoc(loc)) return loc;
    }
  }
  return "";
}

/** Full School section text (for university location signals) */
function wellfoundSchoolBlock(lines) {
  const start = lines.findIndex((l) => /^school$/i.test(l));
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < Math.min(start + 20, lines.length); i++) {
    if (/^work$|^skills$|^looking for$|^achievements$/i.test(lines[i])) break;
    if (/^[—\-–]$/.test(lines[i])) continue;
    out.push(lines[i]);
  }
  return out.join(" | ");
}

/**
 * Pull all location-relevant fields from a Wellfound profile email.
 * City under the name and the School block decide the region. Resume, LinkedIn, phone, and looking-for do not.
 */
function extractWellfoundProfile(lines, name) {
  const blob = (lines || []).join("\n");
  return {
    city: wellfoundCity(lines, name),
    lookingFor: wellfoundLookingFor(lines),
    university: universityFromSchool(lines),
    schoolBlock: wellfoundSchoolBlock(lines),
    phone: extractPhone(blob),
  };
}

function universityFromSchool(lines) {
  const start = lines.findIndex((l) => /^school$/i.test(l));
  if (start < 0) return "";
  const found = [];
  for (let i = start + 1; i < Math.min(start + 25, lines.length); i++) {
    const line = lines[i];
    if (/^work$|^skills$/i.test(line)) break;
    if (/^[—\-–]$/.test(line)) continue;
    if (
      /university|college|institute|campus/i.test(line) &&
      line.length > 3 &&
      line.length < 120 &&
      !/^high school,/i.test(line)
    ) {
      found.push(line);
    }
  }
  return found.find((u) => /university|college|institute/i.test(u)) || found[0] || "";
}

function formLocation(blob) {
  const patterns = [
    /(?:Current\s+location|Location|City|Hometown|Address|Based\s+in|Lives?\s+in|Country)\s*[:|]?\s*([^\n]{2,60})/i,
    /(?:Current\s+location|Location)\s*\n\s*([^\n]{2,60})/i,
  ];
  for (const re of patterns) {
    const m = String(blob || "").match(re);
    if (!m) continue;
    const loc = clean(m[1].split(/[·•|]/)[0]).replace(/[.,;]+$/, "").trim();
    if (!loc || /^(remote|flexible|n\/?a|none|prefer not|not specified)$/i.test(loc) || badLoc(loc))
      continue;
    return loc;
  }
  return "";
}

/** Cover-letter style location — regions engine (includes Canada) */
function locationFromBody(blob) {
  const patterns = [
    /(?:developer|engineer|designer|assistant)\s+in\s+([A-Z][A-Za-z .'-]{1,40})/i,
    /(?:based|living|located|residing)\s+in\s+([A-Z][A-Za-z .'-]{1,50})/i,
    /(?:soy de|vivo en|radicado en)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúñ .'-]{1,40})/i,
    /(?:location|current location)\s*[:|]\s*([A-Z][A-Za-z .',-]{2,50})/i,
  ];
  for (const re of patterns) {
    const m = String(blob || "").match(re);
    if (!m) continue;
    let loc = clean(m[1]).replace(/[|·•].*$/, "").replace(/[.,;:].*$/, "").trim();
    if (badLoc(loc) || loc.length < 3) continue;
    if (isJobHub(loc) || isVagueMetro(loc)) continue;
    const hit = matchLocation(stripNoise(loc));
    if (hit.region === "UNKNOWN") continue;
    return loc;
  }
  return "";
}

/** Weak hint from phone country code */
function phoneCountryHint(blob) {
  if (/\+1[\s\-().]*(809|829|849)\b/.test(blob)) return "Dominican Republic";
  if (/\+91\b/.test(blob) || /\b91[6-9]\d{9}\b/.test(blob.replace(/\D/g, "")))
    return "India";
  if (/\+92\b/.test(blob)) return "Pakistan";
  if (/\+880\b/.test(blob)) return "Bangladesh";
  if (/\+234\b/.test(blob)) return "Nigeria";
  if (/\+254\b/.test(blob)) return "Kenya";
  if (/\+995\b/.test(blob)) return "Georgia";

  const m = blob.match(/\+(\d{1,3})(?=[\s\-().]|\d)/);
  if (!m) return "";
  const map = {
    1: "United States",
    52: "Mexico",
    54: "Argentina",
    55: "Brazil",
    56: "Chile",
    57: "Colombia",
    51: "Peru",
    503: "El Salvador",
    502: "Guatemala",
    504: "Honduras",
    505: "Nicaragua",
    506: "Costa Rica",
    507: "Panama",
    91: "India",
    92: "Pakistan",
    34: "Spain",
    33: "France",
    49: "Germany",
    39: "Italy",
    44: "United Kingdom",
    380: "Ukraine",
    48: "Poland",
  };
  const full = blob.match(/\+(\d{1,3})/);
  const digits = full ? full[1] : m[1];
  for (const len of [3, 2, 1]) {
    if (digits.length >= len && map[digits.slice(0, len)]) {
      return map[digits.slice(0, len)];
    }
  }
  return "";
}

const NAME_WORD = "[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]+";
const NAME_RUN = `${NAME_WORD}(?:\\s+${NAME_WORD}){1,3}`;

function nameFromBody(blob) {
  const normalized = String(blob || "").replace(/['’‘]/g, "'");
  const ok = (n) =>
    n &&
    n.length > 3 &&
    n.length < 60 &&
    !/hiring|manager|team|genius|writing|apply|based|interested|excited|regards|thank/i.test(n) &&
    isRealPersonName(n);

  // Labeled form fields: "Name: Jane Doe" or "Name:\nJane Doe" (Sulekha, Tek4Real, forms)
  const labeled = normalized.match(
    /(?:^|\n)\s*(?:full\s+name|applicant(?:\s+name)?|candidate(?:\s+name)?|name)\s*[:\-]\s*\n?\s*([^\n]{3,60})/i
  );
  if (labeled && ok(clean(labeled[1]))) return clean(labeled[1]);

  // Intro phrases — prefix case-insensitive, name must be Capitalized
  const intro = normalized.match(
    new RegExp(
      `(?:[Mm]y name is|I'm|I am|[Mm]i nombre es|[Mm]e llamo|[Tt]his is)\\s+(${NAME_RUN})`
    )
  );
  if (intro && ok(clean(intro[1]))) return clean(intro[1]);

  // Sign-off: "Thank you,\nJane Doe" / "Best regards,\nJane Doe"
  const signoff = normalized.match(
    new RegExp(
      `(?:thank you|thanks|best regards|kind regards|regards|best|sincerely|cheers)\\s*,?\\s*\\n\\s*(${NAME_RUN})\\s*(?:\\n|$)`,
      "i"
    )
  );
  if (signoff && ok(clean(signoff[1]))) return clean(signoff[1]);

  return "";
}

/** Sender address when the applicant emailed us directly (not a job board / noreply) */
function senderPersonalEmail(fromList = []) {
  for (const a of fromList || []) {
    const addr = String(a?.address || "").toLowerCase();
    if (!addr) continue;
    if (
      /no-?reply|notifications?|jobs?@|alerts?|support|hello@|contact@|info@|wellfound|linkedin|hubstaff|sulekha|cazvid|barefoot|indeed|gohire|ziprecruiter|glassdoor|idealist|geniusxlab|zorqiva|tek4real/i.test(
        addr
      )
    ) {
      continue;
    }
    return addr;
  }
  return "";
}

/** Sender display name when mail comes straight from the applicant */
function nameFromSender(from = "") {
  const f = String(from || "");
  if (
    /no-?reply|notifications?|jobs?@|alerts?|support|hello@|contact@|info@|wellfound|linkedin|hubstaff|sulekha|cazvid|barefoot|indeed|gohire|ziprecruiter|glassdoor|idealist/i.test(
      f
    )
  ) {
    return "";
  }
  const name = clean(f.replace(/<[^>]*>|\S+@\S+/g, " "));
  if (!name) return "";
  const titled = name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return isRealPersonName(titled) ? titled : "";
}

function isRecruiterNoise(subject, from, blob) {
  // Never treat job-board / forwarded applicant alerts as agency spam
  if (isJobSiteMail(subject, from, blob)) return false;
  if (
    /hubstaff|sulekha|cazvid|barefootstudent|indeed|ziprecruiter|gohire|glassdoor|dice\.com|workable|lever\.co|greenhouse/i.test(
      from
    )
  ) {
    return false;
  }

  const b = `${subject} ${from} ${String(blob || "").slice(0, 3500)}`.toLowerCase();
  const fromL = String(from || "").toLowerCase();
  // Staffing / outsourcing / bench sales (not a real applicant)
  return (
    /recruitment agency|hire ua|we can share cvs|our fee is equal|looping in my colleague/i.test(
      b
    ) ||
    /\b(client partner|account manager|talent partner|business development|bench sales|staff augmentation|staffing|recruiting firm|recruitment firm|dedicated (?:development )?teams?|outsourcing|offshore team|resource(?:s)? available|i have (?:strong |experienced )?(?:\d+\+?\s+)?(?:backend |frontend |full.?stack )?developers?|please find (?:the )?(?:attached )?(?:cv|resume|profile)s?\b|our rates?(?:\s+start)?\s+at\s*\$|\$\s*\d+\s*\/\s*(?:hr|hour)|rates? start at|we have (?:strong )?(?:candidates?|profiles?)|candidates?\s+at\b|jr software engineer candidates|scaling .{0,40} capacity|app dev \+|industry specific|yrs? of exp|can meet you (?:guys )?at your office)\b/i.test(
      b
    ) ||
    /\b(ratovate|turing|toptal|andela|deel talent|remote\.com talent|ezonestaffing|e-?zone staffing)\b/i.test(
      b
    ) ||
    // From-address agency signals — do NOT match bare "talent" (breaks talent@wellfound.com)
    /staffing|recruit(?:er|ing|ment)?|sourcing|headhunt/i.test(fromL) ||
    (/\btalent\b/i.test(fromL) &&
      !/wellfound|angel\.co|angellist/i.test(fromL)) ||
    (/follow\s*up/i.test(subject) &&
      /\b(opportunity|developer|engineer)\b/i.test(subject) &&
      /\b(rates?|\$\d+|client partner|www\.|staffing)\b/i.test(b)) ||
    /\blinkedin (?:post|job)|saw your (?:linkedin )?post|regarding your linkedin/i.test(b) ||
    // Rate-card / multi-skill pitch emails (agency contractors)
    (/\$\s*\d+\s*\/\s*(?:hr|hour)/i.test(b) &&
      /\b(?:asp|c#|\.net|django|react|python|years?\s+of\s+exp)/i.test(b))
  );
}

/** Location solid enough to keep + tag (region already decided by filter) */
function isSolidKeepLocation(loc, region) {
  const s = clean(loc);
  if (!s || s.length < 3) return false;
  if (!KEEP_REGIONS.includes(region)) return false;
  // Phone-only country labels from filter — not job hubs
  const phoneCountryOk =
    (region === "American" && /^(united states|u\.s\.a?\.?|usa)$/i.test(s)) ||
    (region === "Canada" && /^canada$/i.test(s)) ||
    (region === "EU" && /^(europe|european union|eu)$/i.test(s)) ||
    (region === "Latin American" && /^(latin america|latam)$/i.test(s));
  if (phoneCountryOk) return true;
  if (/^(remote|flexible)$/i.test(s)) return false;
  if (/time\s*zones?/i.test(s)) return false;
  if (isJobHub(s)) return false;
  if (isVagueMetro(s)) {
    const hit = matchLocation(stripNoise(s));
    const code = { American: "US", Canada: "CA", EU: "EU", "Latin American": "LATAM" }[region];
    if (hit.region !== code) return false;
  }
  if (badLoc(s) || isGarbageLocation(s)) return false;
  return true;
}

function workLocationHints(blob, lines) {
  const hints = [];
  const re =
    /\b(onsite|on-site|hybrid|in-office)\b[^\n.]{0,40}?(?:in|at|@)?\s*([A-Z][A-Za-z .'-]{1,40})/gi;
  let m;
  while ((m = re.exec(blob))) {
    const loc = clean(m[2]);
    if (!badLoc(loc) && !vagueLoc(loc)) {
      hints.push({
        location: loc,
        kind: /hybrid/i.test(m[0]) ? "hybrid" : "onsite",
      });
    }
  }
  const workAt = lines.findIndex((l) => /^work$/i.test(l));
  if (workAt >= 0) {
    for (let i = workAt + 1; i < Math.min(workAt + 30, lines.length); i++) {
      if (/^skills$|^school$/i.test(lines[i])) break;
      const mm = lines[i].match(/^(.+?)\s*[·•]\s*([A-Z][A-Za-z .'-]{1,40})$/);
      if (!mm) continue;
      const loc = clean(mm[2]);
      if (badLoc(loc) || vagueLoc(loc)) continue;
      if (/present|current/i.test(lines.slice(i, i + 4).join(" "))) {
        hints.push({ location: loc, kind: "present-work" });
      }
    }
  }
  return hints;
}

function githubLocation(user) {
  return new Promise((resolve) => {
    if (!user) return resolve("");
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/users/${encodeURIComponent(user)}`,
        method: "GET",
        headers: {
          "User-Agent": "mail-location-bot",
          Accept: "application/vnd.github+json",
        },
        timeout: 8000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(clean(JSON.parse(data).location || ""));
          } catch {
            resolve("");
          }
        });
      }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
    req.end();
  });
}

async function pdfToText(buffer) {
  try {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result?.text || "";
  } catch {
    try {
      // fallback older API
      const pdfParse = require("pdf-parse");
      if (typeof pdfParse === "function") {
        const data = await pdfParse(buffer);
        return data.text || "";
      }
    } catch (_) {}
    return "";
  }
}

function locationFromResume(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 50);

  for (const line of lines) {
    // Whole header line that already looks like a place (City, State, Country)
    if (
      line.length >= 5 &&
      line.length <= 70 &&
      /,/.test(line) &&
      !/@/.test(line) &&
      !/^https?:/i.test(line) &&
      !badLoc(line)
    ) {
      const hit = matchLocation(stripNoise(line));
      if (hit.region !== "UNKNOWN") {
        const loc = sanitizeLocation(line) || line;
        if (loc) return loc;
      }
    }

    const labeled = line.match(
      /(?:Location|Based in|Address|Lives? in|Current location|Residing in|Hometown)\s*[:|]?\s*(.+)$/i
    );
    if (labeled) {
      const loc = sanitizeLocation(labeled[1].split(/[·•|]/)[0]);
      if (loc && !badLoc(loc) && !/^(remote|flexible)$/i.test(loc)) {
        const hit = matchLocation(stripNoise(loc));
        if (hit.region !== "UNKNOWN") return loc;
      }
    }
    // City, ST (US) — don't treat "IN" from "India" as Indiana
    const cs = line.match(
      /\b([A-Za-z][a-zA-Z .'-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY))(?![A-Za-z])/i
    );
    if (cs && !badLoc(cs[1])) {
      const hit = matchLocation(stripNoise(cs[1]));
      if (hit.region === "US") return sanitizeLocation(cs[1]) || cs[1];
    }
    // Full line ending in a country — keep city + country (not mid-token scraps)
    const countryLine = line.match(
      new RegExp(
        `^([A-Za-z][A-Za-z .'-]{1,45}),\\s*(?:[A-Za-z .'-]{2,30},\\s*)?(${COUNTRY_TOKEN})\\s*$`,
        "i"
      )
    );
    if (countryLine) {
      const loc = sanitizeLocation(line) || line;
      if (loc && !badLoc(loc)) {
        const hit = matchLocation(stripNoise(loc));
        if (hit.region !== "UNKNOWN") return loc;
      }
    }
  }

  const head = lines.slice(0, 25).join("\n");
  const based = head.match(
    /(?:based in|location[:\s]+|residing in)\s*([A-Z][A-Za-z .',-]{2,50})/i
  );
  if (based) {
    const loc = sanitizeLocation(
      based[1].replace(/[|·•].*$/, "").replace(/[.,;].*$/, "")
    );
    if (loc && !badLoc(loc)) {
      const hit = matchLocation(stripNoise(loc));
      if (hit.region !== "UNKNOWN") return loc;
    }
  }
  return "";
}

async function resumeTextFromAttachments(attachments = []) {
  const { extractBestResumeText } = require("./lib/parsers");
  const { resume_text } = await extractBestResumeText(attachments);
  return resume_text || "";
}

function pickLocation({
  city,
  form,
  bodyLoc,
  phoneLoc,
  github,
  resumeLoc,
  work,
  university,
  linkedin,
}) {
  const opts = [];
  // RESUME FIRST — highest priority (user rule: resume scan decides location)
  if (resumeLoc && !badLoc(resumeLoc) && !isJobHub(resumeLoc)) {
    opts.push({
      loc: resumeLoc,
      rate: 96,
      pri: 0,
      src: "Resume PDF / attachment",
    });
  } else if (resumeLoc && !badLoc(resumeLoc)) {
    opts.push({
      loc: resumeLoc,
      rate: 88,
      pri: 0,
      src: "Resume PDF / attachment",
    });
  }
  // Wellfound city only after resume (and never bare job hubs when resume exists)
  if (city && !isJobHub(city) && !vagueLoc(city)) {
    opts.push({
      loc: city,
      rate: resumeLoc ? 82 : 92,
      pri: resumeLoc ? 2 : 1,
      src: "Wellfound current location (under name)",
    });
  } else if (city && !isJobHub(city)) {
    opts.push({
      loc: city,
      rate: vagueLoc(city) ? 70 : resumeLoc ? 78 : 88,
      pri: vagueLoc(city) ? 3 : resumeLoc ? 2 : 1,
      src: "Wellfound current location (under name)",
    });
  }
  if (form) {
    opts.push({
      loc: form,
      rate: /remote|flexible/i.test(form) ? 75 : 80,
      pri: /remote|flexible/i.test(form) ? 3 : 2,
      src: "Form Location",
    });
  }
  if (bodyLoc && !badLoc(bodyLoc)) {
    opts.push({
      loc: bodyLoc,
      rate: 78,
      pri: 2,
      src: "Body phrase (based in / live in)",
    });
  }
  if (github && !badLoc(github)) {
    opts.push({
      loc: github,
      rate: 86,
      pri: 2,
      src: "GitHub profile location",
    });
  }
  if (phoneLoc && !badLoc(phoneLoc)) {
    opts.push({
      loc: phoneLoc,
      rate: 60,
      pri: 2,
      src: "Phone country hint",
    });
  }
  for (const h of work || []) {
    if (!h.location || badLoc(h.location)) continue;
    opts.push({
      loc: h.location,
      rate: h.kind === "present-work" ? 72 : 66,
      pri: 3,
      src: `Work hint (${h.kind})`,
    });
  }
  if (university && !badLoc(university)) {
    opts.push({
      loc: university,
      rate: 55,
      pri: 4,
      src: "University",
    });
  }

  opts.sort((a, b) => a.pri - b.pri || b.rate - a.rate);

  let best = opts.find((o) => o.loc);
  if (best && vagueLoc(best.loc)) {
    const better = opts.find((o) => o.loc && !vagueLoc(o.loc) && o.pri <= 3);
    if (better) best = better;
  }

  if (!best?.loc) {
    return {
      location: "",
      rate: "0%",
      reason: `No reliable city. Resume: ${resumeLoc ? "checked" : "none/unreadable"}. LinkedIn: ${linkedin ? "URL only (page not scraped — login wall)" : "none"}. GitHub: ${github ? "checked" : "none"}. University: ${university || "none"}.`,
    };
  }

  const cleaned = sanitizeLocation(best.loc) || best.loc;
  if (!cleaned || badLoc(cleaned)) {
    return {
      location: "",
      rate: "0%",
      reason: `No reliable city after cleanup ("${best.loc}"). Resume: ${resumeLoc || "n/a"}. LinkedIn: ${linkedin ? "URL only" : "none"}.`,
    };
  }

  const workNote =
    work?.length > 0
      ? ` Work hints: ${work
          .slice(0, 2)
          .map((h) => `${h.kind}:${h.location}`)
          .join(", ")}.`
      : "";

  return {
    location: cleaned,
    rate: `${best.rate}%`,
    reason: `${best.src} → "${cleaned}" (${best.rate}%).${workNote} Resume: ${resumeLoc || "n/a"}. LinkedIn: ${linkedin ? "URL only (not scraped)" : "none"}. GitHub loc: ${github || "n/a"}. University: ${university || "none"}.`,
  };
}

/** Region filter from current location text */
function classifyRegion(loc) {
  const v = clean(loc).toLowerCase();
  if (!v) return "Unknown";
  if (/^flexible$/i.test(v)) return "Flexible";
  // Remote and Remote (US) = same category (work mode, not a place)
  if (/^remote\b/i.test(v)) return "Remote";

  // Georgia country — Asia (not EU / not US state unless Atlanta/, GA)
  if (
    (/\b(tbilisi|batumi|kutaisi)\b/.test(v) || /^(georgia)$/i.test(v)) &&
    !/\b(atlanta|savannah|augusta|,?\s*ga\b|united states|u\.?s\.?a?)\b/.test(v)
  ) {
    return "Asian";
  }

  // Latin American (check before US — e.g. Sanfrancisco Tepeyanco, Mexico)
  if (
    /\b(mexico|tlaxcala|tepeyanco|sanfrancisco tepeyanco|san francisco tepeyanco|brazil|argentina|chile|colombia|peru|venezuela|ecuador|bolivia|paraguay|uruguay|panama|costa rica|guatemala|honduras|nicaragua|el salvador|cuba|dominican|puerto rico|jamaica|haiti|trinidad|guyana|suriname|belize|latin america|fortaleza|são paulo|sao paulo|buenos aires|bogot[aá]|lima|santiago|cdmx|guadalajara|monterrey|puebla)\b/.test(
      v
    )
  ) {
    return "Latin American";
  }

  // Canada (own keep-region — before US). Never "ON Location".
  if (
    /\b(canada|toronto|ottawa|vancouver|montr[eé]al|calgary|edmonton|winnipeg|halifax|mississauga|brampton|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|newfoundland|prince edward)\b/.test(
      v
    ) ||
    (/\b[a-z .'-]+,\s*(?:on|bc|ab|qc|mb|sk|ns|nb|nl|pe|nt|yt|nu)\b/.test(v) &&
      !/\bon[\s-]?location\b/.test(v))
  ) {
    return "Canada";
  }

  // American (US only — not Canada)
  if (
    /\b(united states|u\.?s\.?a?\.?|america)\b/.test(v) ||
    /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/.test(
      v
    ) ||
    // US state "Georgia" only with city/state context (avoid country Georgia)
    (/\bgeorgia\b/.test(v) &&
      (/\b(atlanta|savannah|augusta|columbus|macon|athens|marietta|,?\s*ga\b)/i.test(v) ||
        /\bunited states|u\.?s\.?a?\b/i.test(v))) ||
    /\b(new york city|nyc|los angeles|san francisco|san jose|san diego|seattle|austin|dallas|houston|chicago|boston|miami|atlanta|denver|phoenix|philadelphia|portland|nashville|frisco|fresno|fullerton|redondo beach|valley stream|oxon hill|thomaston|west chester|red wing|boca raton|princeton|huntsville|norman|wichita|louisville|milwaukee|columbus|katy|fremont|avondale|santa fe|lakewood|sarasota|bradenton)\b/.test(
      v
    )
  ) {
    return "American";
  }

  // City, ST (US) → American (not Canadian province codes)
  if (
    /\b[a-z .'-]+,\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/.test(
      v
    )
  ) {
    return "American";
  }

  // EU / Europe (citizen / based in EU+UK/EEA — Georgia country is Asia, handled above)
  if (
    /\b(europe|european|eu|united kingdom|u\.?k\.?|england|scotland|wales|ireland|germany|france|spain|italy|netherlands|belgium|portugal|sweden|norway|denmark|finland|poland|austria|switzerland|czech|greece|romania|hungary|bulgaria|croatia|slovakia|slovenia|lithuania|latvia|estonia|luxembourg|malta|cyprus|iceland|lisbon|valencia|paris|berlin|amsterdam|madrid|barcelona|rome|dublin|london|moldova|ukraine|kyiv|kiev|dubrovnik|murcia|eu citizen|european citizen)\b/.test(
      v
    ) &&
    !/\beuropean\s+time\b/i.test(v)
  ) {
    return "EU";
  }

  // African
  if (
    /\b(africa|nigeria|egypt|kenya|ghana|south africa|ethiopia|morocco|tunisia|algeria|uganda|tanzania|rwanda|senegal|ivory coast|cameroon|zimbabwe|sudan|angola|mozambique|botswana|namibia|zambia|lagos|abuja|nairobi|cairo|casablanca|cape town|johannesburg|accra|enugu|benin|tetouan)\b/.test(
      v
    )
  ) {
    return "African";
  }

  // Asian (+ Belarus/Russia — not EU keep)
  if (
    /\b(asia|india|pakistan|bangladesh|china|japan|korea|singapore|malaysia|indonesia|thailand|vietnam|philippines|taiwan|hong kong|sri lanka|nepal|bhutan|myanmar|cambodia|laos|mongolia|kazakhstan|uzbekistan|uae|dubai|saudi|qatar|israel|turkey|iran|iraq|jordan|lebanon|hyderabad|bengaluru|bangalore|mumbai|delhi|new delhi|noida|gurgaon|gurugram|pune|chennai|kolkata|ahmedabad|jaipur|indore|kanpur|kochi|faridabad|varanasi|bhopal|bhilai|lucknow|ghaziabad|surat|lahore|islamabad|karachi|quetta|dhaka|thimphu|jakarta|manila|rizal|seoul|tokyo|beijing|shanghai|hong kong|tel aviv|istanbul|goa|north goa|south goa|panaji|belarus|minsk|russia|moscow)\b/.test(
      v
    )
  ) {
    return "Asian";
  }

  return "Unknown";
}

const REGION_COLORS = {
  American: "FF90EE90", // light green
  Canada: "FFB0E0E6", // powder blue
  "Latin American": "FFFFD580", // light orange
  EU: "FF87CEEB", // sky blue
  African: "FFE6E6FA", // lavender
  Asian: "FFFFB6C1", // light pink
  Remote: "FFFFFF99", // light yellow
  Flexible: "FFD3D3D3", // light gray
  Unknown: "FFFFFFFF",
  Possible: "FFFFF3CD",
  Wellfound: "FFFFE082",
};

function rowFill(region) {
  return REGION_COLORS[region] || REGION_COLORS.Unknown;
}

const EXPORT_COLUMNS = [
  "Received",
  "Name",
  "Email",
  "Job site name",
  "LinkedIn profile",
  "GitHub / Portfolio",
  "Current location",
  "Region",
  "Class",
  "Location correct rate",
  "University",
  "Work location hints",
  "Reason",
];

// Keep only: American, Canada, European (EU), Latina (Latin American)
function isWellfoundRow(r) {
  return /wellfound/i.test(r["Job site name"] || "");
}

const EXPORT_SHEETS = [
  { name: "American", match: (r) => r.Class !== "Possible" && r.Region === "American", colorKey: "American" },
  { name: "Canada", match: (r) => r.Class !== "Possible" && r.Region === "Canada", colorKey: "Canada" },
  { name: "European", match: (r) => r.Class !== "Possible" && r.Region === "EU", colorKey: "EU" },
  { name: "Latina", match: (r) => r.Class !== "Possible" && r.Region === "Latin American", colorKey: "Latin American" },
  { name: "Possible", match: (r) => r.Class === "Possible", colorKey: "Possible" },
];

/** Rows per region tab — Wellfound first, then newest first */
function rowsBySheet(rows) {
  return EXPORT_SHEETS.map((s) => ({
    ...s,
    rows: rows.filter(s.match).sort((a, b) => {
      const aw = /wellfound/i.test(a["Job site name"] || "") ? 0 : 1;
      const bw = /wellfound/i.test(b["Job site name"] || "") ? 0 : 1;
      return (
        aw - bw ||
        (a.Class === "Possible" ? 1 : 0) - (b.Class === "Possible" ? 1 : 0) ||
        String(b.Received || "").localeCompare(String(a.Received || "")) ||
        String(a.Name || "").localeCompare(String(b.Name || ""))
      );
    }),
  }));
}

async function writeExcel(rows, outPath) {
  const wb = new ExcelJS.Workbook();
  const cols = EXPORT_COLUMNS;
  const sheets = EXPORT_SHEETS;

  function addSheet(title, list, colorKey) {
    const sheet = wb.addWorksheet(title);
    const headers = cols.map((h) => (h === "Job site name" ? "Job site" : h));
    sheet.columns = headers.map((h) => ({
      header: h,
      key: h,
      width:
        h === "Reason"
          ? 48
          : h.includes("LinkedIn") || h.includes("GitHub")
            ? 32
            : h === "Job site"
              ? 16
              : h === "Region"
              ? 16
              : 18,
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD5F5E3" },
    };
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: cols.length },
    };

    const argb = rowFill(colorKey);
    const jobCol = headers.indexOf("Job site") + 1;
    for (const r of list) {
      const display = {
        ...r,
        "Job site": r["Job site name"] || r["Job site"] || "",
        Region:
          title === "European"
            ? "European"
            : title === "Latina"
              ? "Latina"
              : r.Region,
      };
      const row = sheet.addRow(display);
      const wellfound = isWellfoundRow(r);
      for (let c = 1; c <= headers.length; c++) {
        const markSite = wellfound && c === jobCol;
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: markSite ? REGION_COLORS.Wellfound : argb },
        };
        if (markSite) row.getCell(c).font = { bold: true };
      }
    }
    return list.length;
  }

  const counts = {};
  for (const s of rowsBySheet(rows)) {
    counts[s.name] = addSheet(s.name, s.rows, s.colorKey);
  }
  counts.Wellfound = rows.filter((r) =>
    /wellfound/i.test(r["Job site name"] || "")
  ).length;

  const rejected = rows.filter(
    (r) =>
      r.Region === "Asian" ||
      r.Region === "African" ||
      !sheets.some((s) => s.match(r))
  ).length;

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Sheet", key: "Sheet", width: 20 },
    { header: "Count", key: "Count", width: 10 },
    { header: "Note", key: "Note", width: 72 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow({ Sheet: "American", Count: counts.American, Note: "US candidates, including Wellfound" });
  summary.addRow({ Sheet: "Canada", Count: counts.Canada, Note: "Canada candidates, including Wellfound" });
  summary.addRow({ Sheet: "European", Count: counts.European, Note: "EU candidates, including Wellfound" });
  summary.addRow({ Sheet: "Latina", Count: counts.Latina, Note: "Latin American candidates, including Wellfound" });
  summary.addRow({
    Sheet: "Possible",
    Count: counts.Possible || 0,
    Note: "Real applicants with a weak or missing home city — third Thunderbird tag",
  });
  summary.addRow({
    Sheet: "Rejected",
    Count: rejected,
    Note: "Asia and Africa are not exported",
  });
  summary.addRow({
    Sheet: "Wellfound marked",
    Count: counts.Wellfound,
    Note: "Not a separate sheet. Job site cell says Wellfound and is gold, on the region sheets.",
  });
  for (let i = 2; i <= 8; i++) {
    const name = summary.getRow(i).getCell(1).value;
    const key =
      name === "European"
        ? "EU"
        : name === "Latina"
          ? "Latin American"
          : name === "Wellfound marked"
            ? "Wellfound"
            : name;
    const argb = rowFill(key);
    for (let c = 1; c <= 3; c++) {
      summary.getRow(i).getCell(c).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb },
      };
    }
  }

  await wb.xlsx.writeFile(outPath);
  return counts;
}

async function writeExcelSafe(rows, outPath) {
  // Refuse wiping a prior good export with an empty keep-set
  if (
    rows.length === 0 &&
    fs.existsSync(outPath)
  ) {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);
      const prior =
        (wb.getWorksheet("American")?.rowCount || 1) +
        (wb.getWorksheet("Canada")?.rowCount || 1) +
        (wb.getWorksheet("European")?.rowCount || 1) +
        (wb.getWorksheet("Latina")?.rowCount || 1) -
        4; // minus headers
      if (prior > 0) {
        const alt = outPath.replace(/\.xlsx$/i, `-${Date.now()}.xlsx`);
        const counts = await writeExcel(rows, alt);
        console.warn(
          `Refused overwrite of ${path.basename(outPath)} (had ~${prior} keep rows); wrote empty to ${path.basename(alt)}`
        );
        return { path: alt, counts, refusedOverwrite: true };
      }
    } catch (_) {
      /* fall through to normal write */
    }
  }

  const tmp = outPath.replace(/\.xlsx$/i, ".tmp.xlsx");
  const counts = await writeExcel(rows, tmp);
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    const alt = outPath.replace(/\.xlsx$/i, `-${Date.now()}.xlsx`);
    try {
      fs.renameSync(tmp, alt);
      console.warn(`Could not replace locked file; wrote ${alt}`);
      return { path: alt, counts };
    } catch (e2) {
      console.warn(`Excel write failed (file open?): ${e2.message}`);
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
      return { path: outPath, counts };
    }
  }
  return { path: outPath, counts };
}

const TAG_LABELS = ["$label1", "$label2", "$label3"];
const MAIL_CHECK_FOLDERS = [
  "Mail Check/American",
  "Mail Check/Canada",
  "Mail Check/European",
  "Mail Check/Latina",
  "Mail Check/Possible",
];
/** Array paths so IMAP joins them with the server delimiter (often "." not "/") */
const MAIL_CHECK_PATHS = {
  "Mail Check/American": ["Mail Check", "American"],
  "Mail Check/Canada": ["Mail Check", "Canada"],
  "Mail Check/European": ["Mail Check", "European"],
  "Mail Check/Latina": ["Mail Check", "Latina"],
  "Mail Check/Possible": ["Mail Check", "Possible"],
};

/** Thunderbird: $label1 red confirmed US, $label2 yellow confirmed Canada/EU/Latina, $label3 possible */
function thunderbirdTagForRegion(region, tier) {
  if (tier === "possible" || tier === "Possible") return "$label3";
  if (region === "American") return "$label1";
  if (
    region === "Canada" ||
    region === "EU" ||
    region === "European" ||
    region === "Latin American" ||
    region === "Latina"
  ) {
    return "$label2";
  }
  return null;
}

/** Folder any IMAP app can open. Thunderbird still uses $label colors on the inbox copy. */
function mailCheckFolder(region, tier) {
  if (tier === "possible" || tier === "Possible") return "Mail Check/Possible";
  if (region === "American") return "Mail Check/American";
  if (region === "Canada") return "Mail Check/Canada";
  if (region === "EU" || region === "European") return "Mail Check/European";
  if (region === "Latin American" || region === "Latina") return "Mail Check/Latina";
  return null;
}

function platformKeyword(folder) {
  if (!folder) return null;
  return `$MailCheck${String(folder).split("/").pop()}`;
}

const PLATFORM_KEYWORDS = MAIL_CHECK_FOLDERS.map(platformKeyword);

async function messageIdsInFolder(client, pathParts) {
  let boxLock;
  try {
    boxLock = await client.getMailboxLock(pathParts);
  } catch {
    return new Set();
  }
  const ids = new Set();
  try {
    if (client.mailbox && client.mailbox.exists > 0) {
      for await (const msg of client.fetch("1:*", { envelope: true })) {
        const id = String(msg.envelope?.messageId || "").trim();
        if (id) ids.add(id);
      }
    }
  } catch {
    /* folder can be read on the next run */
  }
  boxLock.release();
  return ids;
}

async function ensureMailCheckFolders(client, log) {
  const paths = [["Mail Check"], ...Object.values(MAIL_CHECK_PATHS)];
  for (const parts of paths) {
    const name = parts.join("/");
    try {
      await client.mailboxCreate(parts);
    } catch (e) {
      const msg = String((e && e.message) || e || "");
      if (!/exist|already/i.test(msg) && typeof log === "function") {
        log(`Folder ${name}: ${msg}`);
      }
    }
  }
}

async function applyThunderbirdTag(client, uid, region) {
  const tag = thunderbirdTagForRegion(region);
  if (!client || !uid || !tag) return false;
  const remove = TAG_LABELS.filter((k) => k !== tag);
  if (remove.length) {
    try {
      await client.messageFlagsRemove(uid, remove, { uid: true });
    } catch (_) {}
  }
  // Prefer add; some hosts need set. Retry once with set if add throws.
  try {
    await client.messageFlagsAdd(uid, [tag], { uid: true });
  } catch (e1) {
    try {
      await client.messageFlagsSet(uid, [tag], { uid: true });
    } catch (e2) {
      throw e2 || e1;
    }
  }
  // Also star kept mail — Thunderbird always shows the star column even when Tags column is hidden
  try {
    await client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
  } catch (_) {}
  return true;
}

async function scanAccount(account, { onProgress } = {}) {
  const mailUser = account.email || account.user;
  const mailPass = account.password || account.pass;
  const mailHost = resolveMailHost(account.provider, account.host);
  const mailPort = resolveMailPort(account.provider, account.port);
  const unreadOnly = account.unreadOnly === true;
  const tagMail = account.tagThunderbird !== false; // default on
  // Mark scanned application mail as \\Seen (default on). Unread-only always marks.
  const markAsRead = unreadOnly || account.markAsRead !== false;
  // 0 / unset = entire inbox (not “last N”)
  const rawLimit = Number(
    account.scanLimit !== undefined && account.scanLimit !== null && account.scanLimit !== ""
      ? account.scanLimit
      : process.env.SCAN_LIMIT !== undefined && process.env.SCAN_LIMIT !== ""
        ? process.env.SCAN_LIMIT
        : 0
  );
  const batchSize = Number(process.env.BATCH_SIZE || 50);

  const log = (message, extra = {}) => {
    if (typeof onProgress === "function") {
      onProgress({ type: "log", message, ...extra });
    }
    console.log(message);
  };

  if (!mailUser || !mailPass) {
    throw new Error("Account email and password are required");
  }

  const scanStarted = Date.now();
  const recheckAll = account.recheckAll === true;
  const concurrency = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 4));
  let newKeeps = 0;
  const seen = new Set();
  const pendingTags = []; // { uid, region } applied after fetch (stable connection)
  const pendingUntag = []; // wrong/agency $label tags to clear
  const markReadUids = new Set(); // mark \\Seen after scan
  const seenUids = new Set(); // already \\Seen on the server — no STORE needed
  let tagged = 0;
  let untagged = 0;
  let markedRead = 0;

  async function openClient() {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await openClientOnce();
      } catch (e) {
        lastErr = e;
        log(`Connect to ${mailUser} failed (attempt ${attempt}/3): ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    throw lastErr;
  }

  async function openClientOnce() {
    const client = new ImapFlow({
      host: mailHost,
      port: mailPort,
      secure: true,
      auth: { user: mailUser, pass: mailPass },
      logger: false,
      connectionTimeout: 30000,
      greetingTimeout: 20000,
      socketTimeout: 300000,
    });
    client.on("error", () => {});
    await client.connect();
    return client;
  }

  /**
   * Full check of one downloaded message (header prefilter already passed).
   * Returns { action: keep|skip|reject|agency|not-app|duplicate, region?, row? }.
   */
  async function processMessage(msg) {
    const flags = [...(msg.flags || [])];
    // Already Thunderbird-tagged: still export to Excel; re-tag if region changed
    const alreadyTagged = flags.some((f) =>
      /^\$label[123]$/i.test(String(f))
    );

    const subject = msg.envelope?.subject || "";
    const fromText = senderText(msg.envelope);
    if (!msg.source) return null;

    const parsed = await simpleParser(msg.source);
    const text = parsed.text || "";
    const html = typeof parsed.html === "string" ? parsed.html : "";
    if (!isJobApplication(subject, fromText, text || html)) {
      return { action: "not-app" };
    }

    // Full-inbox / mark-as-read: mark scanned application messages
    if (!unreadOnly && markAsRead && msg.uid) markReadUids.add(msg.uid);

    const lines = htmlToLines(html, text);
    const blob = lines.join("\n");
    if (isRecruiterNoise(subject, fromText, blob)) {
      if (process.env.DEBUG_FILTER) log(`AGENCY uid ${msg.uid} "${subject.slice(0, 60)}"`);
      // Agency pitch — never keep American/EU red/yellow tags
      if (alreadyTagged && msg.uid) pendingUntag.push(msg.uid);
      return { action: "agency" };
    }

    // Platform parsers (Zorqiva / Tek4Real / GoHire) — same as Mail bot
    let parsedCandidate = null;
    try {
      parsedCandidate = await parseCandidate(parsed, account.companyName || "");
    } catch (_) {}

    // Resume first: prefer parser PDF text; if empty/short, scan all attachments
    let resumeText = parsedCandidate?.resume_text || "";
    if (!resumeText || resumeText.trim().length < 40) {
      resumeText = await resumeTextFromAttachments(parsed.attachments || []);
    }
    // Always try multi-PDF pick if parser only got a tiny first PDF
    if (
      resumeText.trim().length < 200 &&
      (parsed.attachments || []).filter((a) =>
        /\.pdf$/i.test(a.filename || "") || /pdf/i.test(a.contentType || "")
      ).length > 1
    ) {
      const better = await resumeTextFromAttachments(parsed.attachments || []);
      if (better.trim().length > resumeText.trim().length) resumeText = better;
    }
    const hasResume = !!(resumeText && resumeText.trim().length > 40);

    const linkedinEarly =
      parsedCandidate?.linkedin_url ||
      findLinkedIn(blob) ||
      findLinkedIn(resumeText);
    const nameCandidates = [
      parsedCandidate?.applicant_name,
      nameFromSubject(subject),
      nameFromBody(blob),
      nameFromResume(resumeText),
      nameFromLinkedIn(linkedinEarly),
      nameFromSender(fromText),
    ].map((n) => normalizePersonName(n || ""));
    const nameRaw = nameCandidates.find((n) => n) || "";
    let nameFinal = nameCandidates.find((n) => isRealPersonName(n)) || nameRaw;
    nameFinal = normalizePersonName(nameFinal);
    if (!isRealPersonName(nameFinal)) {
      const liName = nameFromLinkedIn(linkedinEarly);
      if (liName) nameFinal = liName;
    }

    const email = findEmail(lines, blob);
    const emailFinal =
      (parsedCandidate?.applicant_email &&
      !/geniusxlab|zorqiva|tek4real|noreply|no-reply|contact@|wellfound|angel\.co/i.test(
        parsedCandidate.applicant_email
      )
        ? parsedCandidate.applicant_email
        : null) ||
      (email && !/geniusxlab|zorqiva|tek4real|contact@|wellfound|angel\.co/i.test(email)
        ? email
        : findEmail(
            resumeText.split(/\r?\n/).map(clean).filter(Boolean),
            resumeText
          ) || email) ||
      senderPersonalEmail(msg.envelope?.from);

    if (!emailFinal) {
      const key = `name:${String(nameFinal).toLowerCase()}|${String(subject).toLowerCase()}`;
      if (seen.has(key)) return { action: "duplicate" };
      seen.add(key);
    }

    const linkedin = linkedinEarly;
    const gh = findGithub(
      `${blob}\n${parsedCandidate?.github_url || ""}\n${resumeText}`
    );
    const portfolio =
      findPortfolio(blob) || parsedCandidate?.portfolio_url || "";

    const isWf = isWellfoundMail(subject, fromText, blob);
    const isPlatform =
      isJobSiteMail(subject, fromText, blob) ||
      /^(wellfound|tek4real|zorqiva|platform)$/.test(parsedCandidate?.email_type || "");
    const wf = isWf ? extractWellfoundProfile(lines, nameFinal) : null;

    const university =
      (wf && wf.university) ||
      universityFromSchool(lines) ||
      (parsedCandidate?.university || "");
    // Profile city = the platform's own location field (never free resume text)
    const platformForm = /^(wellfound|tek4real|zorqiva|platform)$/.test(
      parsedCandidate?.email_type || ""
    );
    const form =
      formLocation(blob) ||
      (parsedCandidate?.location_field
        ? clean(parsedCandidate.location_field)
        : "");
    const city =
      (wf && wf.city) ||
      (isWf ? wellfoundCity(lines, nameFinal) : "") ||
      (platformForm && parsedCandidate?.location_field
        ? clean(parsedCandidate.location_field)
        : "") ||
      (isPlatform ? form : "");
    const lookingFor =
      (wf && wf.lookingFor) ||
      parsedCandidate?.looking_for ||
      "";
    const schoolBlock = (wf && wf.schoolBlock) || "";

    // Looking-for is a separate preference signal — never substitute for form/body city
    const bodyLoc = locationFromBody(blob) || "";
    const work = workLocationHints(blob, lines);

    const resumeLoc = locationFromResume(resumeText);
    const linkedinFinal = linkedin;
    const ghFinal = gh.user ? gh : findGithub(resumeText);
    const portfolioFinal = portfolio || findPortfolio(resumeText);
    const uniFinal = isPlatform
      ? [wf && wf.university, schoolBlock, university, parsedCandidate?.university]
          .map((t) => clean(String(t || "")))
          .filter(Boolean)
          .join(" | ")
      : university ||
        universityFromSchool(resumeText.split(/\r?\n/).map(clean).filter(Boolean));

    const phoneForRegion = isPlatform
      ? ""
      : extractPhone(resumeText) ||
        parsedCandidate?.phone ||
        extractPhone(`${blob}\n${text}`) ||
        "";

    const uniSignal = isPlatform
      ? uniFinal
      : [uniFinal, schoolBlock].map((t) => clean(String(t || ""))).filter(Boolean).join(" | ");

    const workCity = isPlatform
      ? ""
      : (work.find((h) => h.kind === "present-work") || work[0] || {}).location || "";

    const place = filterApplicantLocation(
      isPlatform
        ? { platformCity: city || form || "", university: uniSignal, platform: true }
        : {
            resumeLoc: resumeLoc ? stripNoise(resumeLoc) : "",
            form: form ? stripNoise(form) : "",
            body: bodyLoc ? stripNoise(bodyLoc) : "",
            platformCity: city || "",
            workCity,
            lookingFor: lookingFor || "",
            university: uniSignal,
            phone: phoneForRegion,
            email: emailFinal,
          }
    );

    let tier = place.tier || (place.action === "reject" ? "reject" : place.action === "accept" ? "confirmed" : "skip");
    if (
      !isPlatform &&
      tier === "skip" &&
      isRealPersonName(nameFinal) &&
      (emailFinal || hasResume || linkedinFinal)
    ) {
      tier = "possible";
      place.action = "accept";
      place.tier = "possible";
      place.region = place.region && place.region !== "Unknown" ? place.region : "Unknown";
      place.location = place.location || "Not in email";
      place.rate = place.rate && place.rate !== "0%" ? place.rate : "40%";
      place.signals = [...(place.signals || []), "no-city"];
    }

    let displayLoc = place.location || "";
    if (
      (place.region === "Asian" || place.region === "African") &&
      (!displayLoc || isJobHub(displayLoc))
    ) {
      displayLoc = place.location || (place.region === "Asian" ? "India" : "Africa");
    }

    let action = place.action || "skip";
    let region = place.region || "Unknown";
    if (tier === "possible") {
      action = "accept";
    } else if (action === "accept" && tier !== "confirmed") {
      action = "skip";
    }
    if (tier === "confirmed" && action === "accept" && !KEEP_REGIONS.includes(region)) {
      action = region === "Asian" || region === "African" ? "reject" : "skip";
      tier = action === "reject" ? "reject" : "skip";
    }

    const fromResume = hasResume && !!resumeLoc && tier === "confirmed";
    let rateOut = place.rate || (tier === "confirmed" ? "90%" : "50%");
    if (fromResume) rateOut = "96%";

    const decision = {
      region,
      action,
      tier,
      location: displayLoc,
      tag: null,
      rate: rateOut,
      signals: place.signals || [],
    };

    const received = msg.envelope?.date ? new Date(msg.envelope.date) : null;
    const row = {
      Received:
        received && !Number.isNaN(received.getTime())
          ? received.toISOString().slice(0, 10)
          : "",
      Name: nameFinal,
      Email: emailFinal,
      "Job site name": jobSite(subject, fromText, text),
      "LinkedIn profile": linkedinFinal,
      "GitHub / Portfolio": ghFinal.url || portfolioFinal || "",
      "Current location": decision.location,
      Region: decision.region,
      Class: tier === "possible" ? "Possible" : "Confirmed",
      "Location correct rate": decision.rate,
      University: uniFinal,
      "Work location hints": work.map((h) => `${h.kind}:${h.location}`).join("; "),
      Reason: `filter: ${decision.action}/${decision.region} (${(decision.signals || []).join(", ") || "n/a"})${fromResume ? " [resume-first]" : ""}`,
    };

    const keepOk = decision.action === "accept" && isRealCandidate(row, hasResume);
    decision.tag = keepOk ? thunderbirdTagForRegion(decision.region, decision.tier) : null;

    if (tagMail && msg.uid) {
      if (decision.tag) {
        const folder = mailCheckFolder(decision.region, decision.tier);
        pendingTags.push({
          uid: msg.uid,
          region: decision.region,
          tag: decision.tag,
          flags,
          folder,
          keyword: platformKeyword(folder),
        });
      } else if (alreadyTagged) {
        pendingUntag.push(msg.uid);
      }
    }

    if (!keepOk) {
      if (process.env.DEBUG_FILTER) {
        log(
          `SKIP uid ${msg.uid} "${subject.slice(0, 60)}" name=${nameFinal} loc=${decision.location} ${row.Reason} realCandidate=${isRealCandidate(row, hasResume)}`
        );
      }
      return {
        action: decision.action === "reject" ? "reject" : "skip",
        region: decision.region,
        name: nameFinal,
        location: decision.location,
      };
    }

    newKeeps += 1;
    const siteLabel = row["Job site name"] || "";
    const wfTag = /wellfound/i.test(siteLabel) ? " [Wellfound]" : "";
    const mark =
      decision.tag === "$label1" ? " [→red]" : decision.tag === "$label2" ? " [→yellow]" : decision.tag === "$label3" ? " [→possible]" : "";
    const line = `${newKeeps}. ${row.Name} | ${row["Current location"] || "—"} | ${row.Class} | ${decision.region} | ${row["Location correct rate"]}${wfTag}${fromResume ? " [resume]" : ""}${mark}`;
    log(line, { apps: newKeeps });
    return { action: "keep", region: decision.region, row };
  }

  let client = await openClient();
  let lock = await client.getMailboxLock("INBOX");
  const total = client.mailbox.exists || 0;

  async function reconnect() {
    try {
      lock.release();
    } catch (_) {}
    try {
      await client.logout();
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
    client = await openClient();
    lock = await client.getMailboxLock("INBOX");
  }

  /** Run an IMAP step, reconnecting once if the server drops the connection */
  async function withRetry(label, fn) {
    try {
      return await fn();
    } catch (e) {
      log(`${label} failed (${e.message}); reconnecting…`);
      await reconnect();
      try {
        return await fn();
      } catch (err2) {
        log(`${label} skipped: ${err2.message}`);
        return null;
      }
    }
  }

  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const uidValidity = client.mailbox.uidValidity;
  const record = loadRecord(account.id || mailUser, {
    filterVersion: FILTER_VERSION,
    uidValidity,
    reset: recheckAll,
  });

  // 0 / invalid = scan entire mailbox; otherwise last N messages
  const scanAll = !Number.isFinite(rawLimit) || rawLimit <= 0;
  const scanLimit = scanAll ? total : Math.min(Math.floor(rawLimit), total);
  const scanLabel = scanAll || scanLimit >= total ? `all ${total}` : `last ${scanLimit}`;

  const onlyUids = Array.isArray(account.onlyUids)
    ? account.onlyUids.map(Number).filter((n) => n > 0)
    : [];

  const stats = {
    listed: 0,
    alreadyChecked: 0,
    notApp: 0,
    downloaded: 0,
    keep: 0,
    skip: 0,
    reject: 0,
    agency: 0,
  };

  try {
    // ── Step 1: which UIDs to look at ──
    let t0 = Date.now();
    let uids = [];
    if (onlyUids.length) {
      uids = onlyUids;
    } else if (unreadOnly) {
      uids = (await withRetry("UNSEEN search", () =>
        client.search({ seen: false }, { uid: true })
      )) || [];
    } else {
      uids = (await withRetry("UID list", () =>
        client.search({ all: true }, { uid: true })
      )) || [];
    }
    uids = [...new Set(uids.map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
    if (!scanAll && uids.length > scanLimit) uids = uids.slice(-scanLimit);
    stats.listed = uids.length;
    log(
      `Scanning ${mailUser}: ${uids.length} ${unreadOnly ? "unread " : ""}message(s) of ${total}${recheckAll ? " (re-check all)" : ""}…`,
      { account: mailUser, total, listed: uids.length }
    );

    // Already-recorded UIDs need no IMAP traffic at all (unread-only still marks them read)
    if (!recheckAll && !onlyUids.length) {
      const fresh = [];
      for (const uid of uids) {
        if (isChecked(record, uid)) {
          stats.alreadyChecked += 1;
          if (unreadOnly && markAsRead) markReadUids.add(uid);
        } else {
          fresh.push(uid);
        }
      }
      uids = fresh;
    }

    // ── Step 2: headers only (fast) → decide what needs a full download ──
    const toDownload = [];
    const headerChunk = 500;
    for (let i = 0; i < uids.length; i += headerChunk) {
      const chunk = uids.slice(i, i + headerChunk);
      await withRetry(`Headers ${chunk[0]}…${chunk[chunk.length - 1]}`, async () => {
        for await (const msg of client.fetch(
          chunk,
          { uid: true, envelope: true, flags: true },
          { uid: true }
        )) {
          const flagSet = msg.flags || new Set();
          const isSeen = flagSet.has ? flagSet.has("\\Seen") : false;
          if (isSeen) seenUids.add(msg.uid);
          if (unreadOnly && isSeen) continue;
          // Unread-only: every unread message we look at is marked read afterwards
          if (unreadOnly && markAsRead) markReadUids.add(msg.uid);

          const subject = msg.envelope?.subject || "";
          if (!isJobApplication(subject, senderText(msg.envelope))) {
            stats.notApp += 1;
            setChecked(record, msg.uid, { action: "not-app" });
            continue;
          }
          toDownload.push(msg.uid);
        }
      });
    }
    log(
      `Headers checked in ${secs(Date.now() - t0)}: ${toDownload.length} to open, ${stats.alreadyChecked} already checked, ${stats.notApp} not applications.`
    );

    // ── Step 3: download + full check, several messages in parallel ──
    t0 = Date.now();
    const dlChunk = Math.max(5, Math.min(batchSize, 25));
    for (let i = 0; i < toDownload.length; i += dlChunk) {
      const chunk = toDownload.slice(i, i + dlChunk);
      if (typeof onProgress === "function") {
        onProgress({
          type: "batch",
          message: `Opening ${i + 1}–${i + chunk.length} of ${toDownload.length}`,
        });
      }
      const msgs = [];
      await withRetry(`Download ${chunk[0]}…${chunk[chunk.length - 1]}`, async () => {
        msgs.length = 0;
        for await (const msg of client.fetch(
          chunk,
          { uid: true, envelope: true, flags: true, source: true },
          { uid: true }
        )) {
          msgs.push(msg);
        }
      });
      stats.downloaded += msgs.length;

      let next = 0;
      const worker = async () => {
        while (next < msgs.length) {
          const msg = msgs[next++];
          try {
            const out = await processMessage(msg);
            if (!out) continue;
            if (stats[out.action] !== undefined) stats[out.action] += 1;
            else if (out.action === "not-app") stats.notApp += 1;
            setChecked(record, msg.uid, out);
          } catch (e) {
            console.error(`msg ${msg.uid}:`, e.message);
            if (typeof onProgress === "function") {
              onProgress({ type: "error", message: `msg ${msg.uid}: ${e.message}` });
            }
          } finally {
            msg.source = null;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, msgs.length) }, worker)
      );
      saveRecord(account.id || mailUser, record);
    }
    if (toDownload.length) {
      log(
        `Opened ${stats.downloaded} message(s) in ${secs(Date.now() - t0)}: kept ${stats.keep}, rejected ${stats.reject}, skipped ${stats.skip}, agency ${stats.agency}.`
      );
    }
    saveRecord(account.id || mailUser, record);
  } finally {
    try {
      lock.release();
    } catch (_) {}
  }

  // Tag + mark-read in grouped STOREs (reconnects only if the scan connection dropped)
  const byUid = new Map();
  for (const t of pendingTags) {
    const folder = t.folder || mailCheckFolder(t.region, t.tag === "$label3" ? "possible" : "confirmed");
    byUid.set(t.uid, {
      region: t.region,
      tag: t.tag,
      flags: t.flags,
      folder,
      keyword: t.keyword || platformKeyword(folder),
    });
  }
  // Already-checked keeps still need a folder + keyword if an older scan never filed them
  if (tagMail) {
    for (const [uid, entry] of Object.entries(record.checked || {})) {
      if (!entry || entry.action !== "keep" || !entry.row) continue;
      const n = Number(uid);
      if (!n) continue;
      const tier = entry.row.Class === "Possible" ? "possible" : "confirmed";
      const folder = mailCheckFolder(entry.row.Region, tier);
      const tag = thunderbirdTagForRegion(entry.row.Region, tier);
      const keyword = platformKeyword(folder);
      if (!tag || !folder || !keyword) continue;
      if (entry.folder === folder && entry.keyword === keyword) continue;
      const cur = byUid.get(n);
      if (cur) {
        cur.folder = folder;
        cur.keyword = keyword;
        continue;
      }
      byUid.set(n, { region: entry.row.Region, tag, flags: [], folder, keyword, fromRecord: true });
    }
  }
  const untagList = [...new Set(pendingUntag)].filter(
    (uid) => uid > 0 && !byUid.has(uid)
  );
  // Always mark tagged keepers as read when markAsRead is on
  if (markAsRead) {
    for (const [uid, info] of byUid) {
      if (info.fromRecord) continue;
      markReadUids.add(uid);
    }
  }
  const readList = [...markReadUids].filter((uid) => uid > 0 && !seenUids.has(uid));
  const needPass =
    (tagMail && (byUid.size > 0 || untagList.length > 0)) ||
    (markAsRead && readList.length > 0);

  if (needPass) {
    const flagChunk = 200;
    /** One STORE per chunk of UIDs; falls back to per-UID only if the server rejects the set */
    const storeFlags = async (uidList, fn, label) => {
      let done = 0;
      for (let i = 0; i < uidList.length; i += flagChunk) {
        const chunk = uidList.slice(i, i + flagChunk);
        try {
          await fn(chunk);
          done += chunk.length;
        } catch (e) {
          for (const uid of chunk) {
            try {
              await fn([uid]);
              done += 1;
            } catch (err) {
              log(`${label} failed uid ${uid}: ${err.message}`);
            }
          }
        }
      }
      return done;
    };

    const runFlagPass = async () => {
      const t0 = Date.now();
      if (!client.usable) {
        try {
          await client.logout();
        } catch (_) {}
        client = await openClient();
      }
      await ensureMailCheckFolders(client, log);
      lock = await client.getMailboxLock("INBOX");

      if (tagMail && untagList.length) {
        untagged = await storeFlags(
          untagList,
          (uids) => client.messageFlagsRemove(uids, [...TAG_LABELS, ...PLATFORM_KEYWORDS], { uid: true }),
          "Untag"
        );
        log(`Cleared wrong tags on ${untagged} message(s).`);
      }

      if (tagMail && byUid.size) {
        // Group by tag colour; skip messages that already carry exactly the right tag + star
        const groups = new Map();
        let alreadyOk = 0;
        for (const [uid, info] of byUid) {
          const { tag, keyword, flags = [] } = info;
          if (!tag) continue;
          const has = new Set((flags || []).map(String));
          const otherLabels = TAG_LABELS.filter((k) => k !== tag && has.has(k));
          const otherKeys = PLATFORM_KEYWORDS.filter((k) => k !== keyword && has.has(k));
          if (
            has.has(tag) &&
            keyword &&
            has.has(keyword) &&
            has.has("\\Flagged") &&
            !otherLabels.length &&
            !otherKeys.length
          ) {
            alreadyOk += 1;
            continue;
          }
          const gk = `${tag}|${keyword || ""}`;
          if (!groups.has(gk)) groups.set(gk, { tag, keyword, uids: [] });
          groups.get(gk).uids.push(uid);
        }
        for (const { tag, keyword, uids } of groups.values()) {
          const remove = [
            ...TAG_LABELS.filter((k) => k !== tag),
            ...PLATFORM_KEYWORDS.filter((k) => k !== keyword),
          ];
          await storeFlags(
            uids,
            (u) => client.messageFlagsRemove(u, remove, { uid: true }),
            "Untag"
          );
          const add = [tag, "\\Flagged"];
          if (keyword) add.push(keyword);
          tagged += await storeFlags(
            uids,
            (u) => client.messageFlagsAdd(u, add, { uid: true }),
            "Tag"
          );
          for (const uid of uids) {
            const rec = record.checked[String(uid)];
            if (rec && keyword) rec.keyword = keyword;
          }
        }
        log(
          `Tagged ${tagged} message(s) (US=red, Canada/EU/Latina=yellow, possible=third tag) + starred${alreadyOk ? ` · ${alreadyOk} already tagged` : ""}.`
        );

        const copyGroups = new Map();
        for (const [uid, info] of byUid) {
          if (!info.folder) continue;
          const rec = record.checked[String(uid)];
          if (rec && rec.folder === info.folder) continue;
          if (!copyGroups.has(info.folder)) copyGroups.set(info.folder, []);
          copyGroups.get(info.folder).push(uid);
        }
        let filed = 0;
        let alreadyThere = 0;
        for (const [folder, uids] of copyGroups) {
          const parts = MAIL_CHECK_PATHS[folder];
          let existingIds = new Set();
          if (parts) {
            try {
              lock.release();
            } catch (_) {}
            existingIds = await messageIdsInFolder(client, parts);
            lock = await client.getMailboxLock("INBOX");
          }
          for (let i = 0; i < uids.length; i += 100) {
            const chunk = uids.slice(i, i + 100);
            const markChunk = (list) => {
              for (const uid of list) {
                const rec = record.checked[String(uid)];
                const info = byUid.get(uid);
                if (!rec) continue;
                rec.folder = folder;
                if (info && info.keyword) rec.keyword = info.keyword;
              }
            };
            const idByUid = new Map();
            try {
              for await (const msg of client.fetch(chunk, { uid: true, envelope: true }, { uid: true })) {
                idByUid.set(msg.uid, String(msg.envelope?.messageId || "").trim());
              }
            } catch (_) {}
            const fresh = [];
            for (const uid of chunk) {
              const id = idByUid.get(uid);
              if (id && existingIds.has(id)) {
                markChunk([uid]);
                alreadyThere += 1;
              } else {
                fresh.push(uid);
                if (id) existingIds.add(id);
              }
            }
            if (!fresh.length) continue;
            try {
              await client.messageCopy(fresh, parts || folder, { uid: true });
              markChunk(fresh);
              filed += fresh.length;
            } catch (e) {
              for (const uid of fresh) {
                try {
                  await client.messageCopy(uid, parts || folder, { uid: true });
                  markChunk([uid]);
                  filed += 1;
                } catch (err) {
                  log(`File ${folder} failed uid ${uid}: ${err.message}`);
                }
              }
            }
          }
        }
        if (filed || tagged || alreadyThere) saveRecord(account.id || mailUser, record);
        if (filed || alreadyThere) {
          log(
            `Filed ${filed} message(s) into Mail Check folders${alreadyThere ? ` · ${alreadyThere} already filed` : ""}.`
          );
        }
      }

      if (markAsRead && readList.length) {
        markedRead = await storeFlags(
          readList,
          (uids) => client.messageFlagsAdd(uids, ["\\Seen"], { uid: true }),
          "Mark-read"
        );
        log(`Marked ${markedRead} message(s) as read.`);
      }
      log(`Tags / read flags written in ${secs(Date.now() - t0)}.`);
    };

    let flagOk = false;
    for (let attempt = 1; attempt <= 3 && !flagOk; attempt++) {
      try {
        tagged = 0;
        untagged = 0;
        markedRead = 0;
        await runFlagPass();
        flagOk = true;
      } catch (e) {
        log(
          `Post-scan flag pass failed (attempt ${attempt}/3): ${e.message}`
        );
        try {
          lock.release();
        } catch (_) {}
        try {
          await client.logout();
        } catch (_) {}
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    try {
      lock.release();
    } catch (_) {}
    try {
      await client.logout();
    } catch (_) {}
  } else {
    try {
      await client.logout();
    } catch (_) {}
  }

  const exportsDir = path.join(__dirname, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  // Export = every kept candidate ever recorded for this mailbox (not only this run)
  const rows = keptRows(record).map((r) => ({ ...r }));
  const filledRows = [];
  const dedupe = new Map();
  const richness = (r) =>
    (clean(r["LinkedIn profile"]) ? 2 : 0) +
    (clean(r["GitHub / Portfolio"]) ? 2 : 0) +
    (clean(r.University) ? 1 : 0) +
    (parseInt(r["Location correct rate"], 10) || 0) / 100;
  for (const r of rows) {
    const name = clean(r.Name);
    const loc = clean(r["Current location"]);
    const rate = clean(r["Location correct rate"]);
    const region = clean(r.Region);
    const rowClass = r.Class === "Possible" ? "Possible" : "Confirmed";
    r.Class = rowClass;
    if (rowClass === "Confirmed") {
      if (!loc || region === "Unknown" || rate === "0%") continue;
      if (isJobHub(loc)) continue;
      if (!KEEP_REGIONS.includes(region)) continue;
    }
    if (!isRealPersonName(name)) continue;
    const emailKey = clean(r.Email).toLowerCase();
    const dk = emailKey || `n:${name.toLowerCase()}|${loc.toLowerCase()}`;
    // Keep scan Region — do NOT reclassify
    r["Current location"] = enrichKnownCity(sanitizeLocation(loc) || loc) || loc;
    const prev = dedupe.get(dk);
    if (prev === undefined) {
      dedupe.set(dk, filledRows.length);
      filledRows.push(r);
    } else if (richness(r) > richness(filledRows[prev])) {
      filledRows[prev] = r;
    }
  }

  const out = path.join(exportsDir, exportFileNameFor(account));
  const { path: written, counts } = await writeExcelSafe(filledRows, out);
  const wellfoundCount =
    counts.Wellfound ??
    filledRows.filter((r) => /wellfound/i.test(r["Job site name"] || "")).length;

  let sheet = null;
  if (account.sheetId) {
    try {
      sheet = await writeGoogleSheet(account.sheetId, rowsBySheet(filledRows), {
        columns: EXPORT_COLUMNS,
        title: account.companyName || mailUser,
      });
      log(`Google Sheet updated: ${sheet.url}`);
    } catch (e) {
      sheet = { error: e.message };
      log(`Google Sheet update failed: ${e.message}`);
    }
  }

  const elapsed = Date.now() - scanStarted;
  const doneMsg = `Done in ${secs(elapsed)} → ${written} | checked ${scanLabel} (opened ${stats.downloaded}, already checked ${stats.alreadyChecked}) | new keeps=${stats.keep} | total kept=${filledRows.length} | Wellfound=${wellfoundCount} | tagged=${tagged} | markedRead=${markedRead} | American=${counts.American || 0} Canada=${counts.Canada || 0} European=${counts.European || 0} Latina=${counts.Latina || 0} Possible=${counts.Possible || 0}`;
  log(doneMsg, {
    path: written,
    counts: { ...counts, Wellfound: wellfoundCount },
    apps: filledRows.length,
    tagged,
    markedRead,
    wellfound: wellfoundCount,
  });

  return {
    path: written,
    fileName: path.basename(written),
    counts: { ...counts, Wellfound: wellfoundCount },
    apps: filledRows.length,
    newKeeps: stats.keep,
    stats,
    elapsedMs: elapsed,
    sheet,
    wellfound: wellfoundCount,
    tagged,
    markedRead,
    account: mailUser,
  };
}

async function main() {
  const account = {
    email: process.env.MAIL_USER,
    password: process.env.MAIL_PASS,
    host: process.env.MAIL_HOST,
    provider: process.env.MAIL_PROVIDER || "hostinger",
    companyName: process.env.COMPANY_NAME,
    scanLimit: Number(process.env.SCAN_LIMIT || 0),
    unreadOnly: process.env.UNREAD_ONLY !== "false",
  };
  if (!account.email || !account.password) {
    console.error("Set MAIL_USER and MAIL_PASS in .env (or use npm run ui)");
    process.exit(1);
  }
  await scanAccount(account);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  scanAccount,
  resolveMailHost,
  resolveMailPort,
  exportFileNameFor,
  exportBaseNameFor,
  writeExcelSafe,
  classifyRegion,
  isRealPersonName,
  sanitizeLocation,
  pickLocation,
  locationFromResume,
  testAccount,
};

async function testAccount(account) {
  const mailUser = account.email || account.user;
  const mailPass = account.password || account.pass;
  const mailHost = resolveMailHost(account.provider, account.host);
  const mailPort = resolveMailPort(account.provider, account.port);
  if (!mailUser || !mailPass) {
    throw new Error("Email and password are required");
  }
  if (!mailHost) {
    throw new Error("IMAP host is required");
  }

  const client = new ImapFlow({
    host: mailHost,
    port: mailPort,
    secure: account.useSsl !== false,
    auth: { user: mailUser, pass: mailPass },
    logger: false,
    connectionTimeout: 30000,
    greetingTimeout: 20000,
  });
  client.on("error", () => {});

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", {
        messages: true,
        unseen: true,
      });
      return {
        ok: true,
        email: mailUser,
        host: mailHost,
        port: mailPort,
        messages: status.messages || 0,
        unseen: status.unseen || 0,
      };
    } finally {
      lock.release();
    }
  } catch (error) {
    const message = String(error.message || error.responseText || error);
    if (/authentication|invalid credentials|login/i.test(message)) {
      throw new Error(authHintFor({ ...account, host: mailHost }));
    }
    throw new Error(message);
  } finally {
    try {
      await client.logout();
    } catch (_) {}
  }
}
