/**
 * Mail Check — multi-mailbox recruiter scanner
 *
 *   npm run ui   → http://localhost:3855
 *   npm start    → CLI from .env
 *
 * Output: exports/{company} - {YYYY-MM-DD}.xlsx
 * Sheets: American | Canada | European | Latina
 * Tags: American=red ($label1); Canada+EU+Latina=yellow ($label2)
 * Region engine: lib/regions.js (Mail bot + city enrich)
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

const KEEP_REGIONS = ["American", "Canada", "EU", "Latin American"];

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

function isWellfoundMail(subject = "", from = "", blob = "") {
  const h = `${subject} ${from} ${String(blob || "").slice(0, 1200)}`.toLowerCase();
  return (
    /wellfound\.com|talent@wellfound|@wellfound\.|angel\.co|angellist/i.test(h) ||
    /\bis interested in\b/i.test(subject)
  );
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
    /100\+ candidates|connection request|your ad|could do more|newsletter|job alert|invite|invitation|accepted your invitation|explore their network|impressions last week|writing help|doomers|messaged you|coderbyte|calendly/i.test(
      header
    )
  ) {
    return false;
  }
  // Wellfound applications always count
  if (isWellfoundMail(subj, from, body)) return true;
  return (
    /is interested in|application|applied for|applied to|solicitud de empleo|perfil asistente|junior |senior |full.?stack|software engineer|developer|virtual assistant|wordpress|asistente|candidatura|resume|gohire|barefoot|engineer/i.test(
      blob
    )
  );
}

function jobSite(subject, from, text) {
  const subj = unwrapSubject(subject);
  const b = `${subj} ${from} ${text.slice(0, 1200)}`.toLowerCase();
  if (/wellfound|angel\.co|angellist|talent@wellfound/i.test(b)) return "Wellfound";
  if (/is interested in/i.test(subj)) return "Wellfound";
  if (/\[zorqiva\]|zorqiva careers/.test(b)) return "Zorqiva Careers";
  if (/geniusxlab|genius.?lab/.test(b)) return "GeniusXLab";
  if (/linkedin/.test(b) || /linkedin\.com/.test(from.toLowerCase()))
    return "LinkedIn";
  if (/tek4real/.test(b)) return "Tek4Real";
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

/** Keep only likely real applicants in keep-regions with solid location */
function isRealCandidate(row, hasResume) {
  const hasLink =
    !!clean(row["LinkedIn profile"]) ||
    !!clean(row["GitHub / Portfolio"]);
  const hasEmail =
    !!clean(row.Email) &&
    !/geniusxlab|zorqiva|tek4real|noreply|no-reply/i.test(row.Email);
  const region = row.Region;
  const keepRegion = KEEP_REGIONS.includes(region);
  const nameOk = isRealPersonName(row.Name);
  const locOk = isSolidKeepLocation(row["Current location"], region);

  if (!nameOk || !keepRegion || !locOk) return false;
  if (hasResume) return true;
  if (hasLink && hasEmail) return true;
  if (hasEmail) return true;
  return false;
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
 * City + phone + university + looking-for are all used for region.
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
  const m = blob.match(/(?:Location|Current location)\s*[:|]?\s*([^\n]{2,40})/i);
  if (!m) return "";
  const loc = clean(m[1].split(/[·•|]/)[0]);
  if (!loc || /^(remote|flexible)$/i.test(loc) || badLoc(loc)) return "";
  return loc;
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
  // Never treat Wellfound / job-board applicant alerts as agency spam
  if (isWellfoundMail(subject, from, blob)) return false;
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
  if (isJobHub(s) || isVagueMetro(s)) return false;
  if (/^(remote|flexible)$/i.test(s)) return false;
  if (/time\s*zones?/i.test(s)) return false;
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
  Unknown: "FFFFFFFF", // white
};

function rowFill(region) {
  return REGION_COLORS[region] || REGION_COLORS.Unknown;
}

async function writeExcel(rows, outPath) {
  const wb = new ExcelJS.Workbook();
  const cols = [
    "Name",
    "Email",
    "Job site name",
    "LinkedIn profile",
    "GitHub / Portfolio",
    "Current location",
    "Region",
    "Location correct rate",
    "University",
    "Work location hints",
    "Reason",
  ];

  // Keep only: American, Canada, European (EU), Latina (Latin American)
  const sheets = [
    { name: "American", match: (r) => r.Region === "American", colorKey: "American" },
    { name: "Canada", match: (r) => r.Region === "Canada", colorKey: "Canada" },
    { name: "European", match: (r) => r.Region === "EU", colorKey: "EU" },
    { name: "Latina", match: (r) => r.Region === "Latin American", colorKey: "Latin American" },
  ];

  function addSheet(title, list, colorKey) {
    const sheet = wb.addWorksheet(title);
    sheet.columns = cols.map((h) => ({
      header: h,
      key: h,
      width:
        h === "Reason"
          ? 48
          : h.includes("LinkedIn") || h.includes("GitHub")
            ? 32
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
    for (const r of list) {
      const display = {
        ...r,
        Region:
          title === "European"
            ? "European"
            : title === "Latina"
              ? "Latina"
              : r.Region,
      };
      const row = sheet.addRow(display);
      for (let c = 1; c <= cols.length; c++) {
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb },
        };
      }
    }
    return list.length;
  }

  const counts = {};
  for (const s of sheets) {
    // Wellfound first within each region (primary hiring source)
    const list = rows
      .filter(s.match)
      .sort((a, b) => {
        const aw = /wellfound/i.test(a["Job site name"] || "") ? 0 : 1;
        const bw = /wellfound/i.test(b["Job site name"] || "") ? 0 : 1;
        return aw - bw || String(a.Name || "").localeCompare(String(b.Name || ""));
      });
    counts[s.name] = addSheet(s.name, list, s.colorKey);
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
    { header: "Sheet", key: "Sheet", width: 14 },
    { header: "Count", key: "Count", width: 10 },
    { header: "Note", key: "Note", width: 48 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow({
    Sheet: "Wellfound",
    Count: counts.Wellfound,
    Note: "PRIMARY source — talent@wellfound.com applications",
  });
  summary.addRow({ Sheet: "American", Count: counts.American, Note: "Kept (US)" });
  summary.addRow({ Sheet: "Canada", Count: counts.Canada, Note: "Kept (Canada)" });
  summary.addRow({ Sheet: "European", Count: counts.European, Note: "Kept (EU location)" });
  summary.addRow({ Sheet: "Latina", Count: counts.Latina, Note: "Kept (Latin American)" });
  summary.addRow({
    Sheet: "Rejected",
    Count: rejected,
    Note: "Asian + African + Remote/Flexible/Unknown excluded",
  });
  // Highlight Wellfound summary row
  for (let c = 1; c <= 3; c++) {
    summary.getRow(2).getCell(c).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFE082" },
    };
    summary.getRow(2).getCell(c).font = { bold: true };
  }
  for (let i = 3; i <= 6; i++) {
    const name = summary.getRow(i).getCell(1).value;
    const key =
      name === "European"
        ? "EU"
        : name === "Latina"
          ? "Latin American"
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

/** Thunderbird IMAP keywords: $label1=red (US), $label2=yellow (Canada/EU/Latina) */
function thunderbirdTagForRegion(region) {
  if (region === "American") return "$label1"; // red
  if (
    region === "Canada" ||
    region === "EU" ||
    region === "Latin American"
  ) {
    return "$label2"; // yellow
  }
  return null;
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

  const rows = [];
  const seen = new Set();
  const pendingTags = []; // { uid, region } applied after fetch (stable connection)
  const pendingUntag = []; // wrong/agency $label tags to clear
  const markReadUids = new Set(); // mark \\Seen after scan
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
      connectionTimeout: 120000,
      greetingTimeout: 60000,
      socketTimeout: 300000,
    });
    client.on("error", () => {});
    await client.connect();
    return client;
  }

  async function processMessage(msg) {
    const flags = [...(msg.flags || [])];
    const isSeen =
      flags.includes("\\Seen") || (msg.flags && msg.flags.has("\\Seen"));
    if (unreadOnly && isSeen) return;

    // Unread-only: mark every unread message we open. Full scan: mark job apps after confirm.
    if (unreadOnly && msg.uid) markReadUids.add(msg.uid);

    // Already Thunderbird-tagged: still export to Excel; re-tag if region changed
    const alreadyTagged = flags.some((f) =>
      /^\$label[123]$/i.test(String(f))
    );

    const subject = msg.envelope?.subject || "";
    const fromText = (msg.envelope?.from || [])
      .map((a) => `${a.name || ""} ${a.address || ""}`)
      .join(" ");
    if (!isJobApplication(subject, fromText)) return;
    if (!msg.source) return;

    const parsed = await simpleParser(msg.source);
    const text = parsed.text || "";
    const html = typeof parsed.html === "string" ? parsed.html : "";
    if (!isJobApplication(subject, fromText, text || html)) return;

    // Full-inbox / mark-as-read: mark scanned application messages
    if (!unreadOnly && markAsRead && msg.uid) markReadUids.add(msg.uid);

    const lines = htmlToLines(html, text);
    const blob = lines.join("\n");
    if (isRecruiterNoise(subject, fromText, blob)) {
      if (process.env.DEBUG_FILTER) log(`AGENCY uid ${msg.uid} "${subject.slice(0, 60)}"`);
      // Agency pitch — never keep American/EU red/yellow tags
      if (alreadyTagged && msg.uid) pendingUntag.push(msg.uid);
      return;
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
      if (seen.has(key)) return;
      seen.add(key);
    }

    const linkedin = linkedinEarly;
    const gh = findGithub(
      `${blob}\n${parsedCandidate?.github_url || ""}\n${resumeText}`
    );
    const portfolio =
      findPortfolio(blob) || parsedCandidate?.portfolio_url || "";

    const isWf = isWellfoundMail(subject, fromText, blob);
    const wf = isWf ? extractWellfoundProfile(lines, nameFinal) : null;

    const university =
      (wf && wf.university) ||
      universityFromSchool(lines) ||
      (parsedCandidate?.university || "");
    const city =
      (wf && wf.city) ||
      wellfoundCity(lines, nameFinal) ||
      (parsedCandidate?.location_text ? clean(parsedCandidate.location_text) : "");
    const lookingFor =
      (wf && wf.lookingFor) ||
      parsedCandidate?.looking_for ||
      "";
    const schoolBlock = (wf && wf.schoolBlock) || "";

    const form =
      formLocation(blob) ||
      (parsedCandidate?.location_field
        ? clean(parsedCandidate.location_field)
        : "");
    // Looking-for is a separate preference signal — never substitute for form/body city
    const bodyLoc = locationFromBody(blob) || "";
    const work = workLocationHints(blob, lines);

    const resumeLoc = locationFromResume(resumeText);
    const linkedinFinal = linkedin;
    const ghFinal = gh.user ? gh : findGithub(resumeText);
    const portfolioFinal = portfolio || findPortfolio(resumeText);
    const uniFinal =
      university ||
      universityFromSchool(resumeText.split(/\r?\n/).map(clean).filter(Boolean));

    const phoneForRegion =
      extractPhone(resumeText) ||
      (wf && wf.phone) ||
      parsedCandidate?.phone ||
      extractPhone(`${blob}\n${text}`) ||
      "";

    // ONE location-filter → Excel + tags
    // Wellfound: profile city wins over looking-for / resume client noise
    const uniSignal = [uniFinal, schoolBlock]
      .map((t) => clean(String(t || "")))
      .filter(Boolean)
      .join(" | ");

    const place = filterApplicantLocation({
      resume: resumeText,
      resumeLoc: resumeLoc ? stripNoise(resumeLoc) : "",
      form: form ? stripNoise(form) : "",
      body: bodyLoc ? stripNoise(bodyLoc) : "",
      platformCity: city || "",
      lookingFor: lookingFor || "",
      university: uniSignal,
      phone: phoneForRegion,
      email: emailFinal,
      preferPlatform: isWf || !!city,
    });

    let displayLoc = place.location || "";
    if (
      (place.region === "Asian" || place.region === "African") &&
      (!displayLoc || isJobHub(displayLoc))
    ) {
      displayLoc =
        place.location ||
        (place.region === "Asian" ? "India" : "Africa");
    }

    let action = place.action || "skip";
    let region = place.region || "Unknown";
    // Trust filter solid=true (phone-only US/EU country labels). Else require solid keep.
    if (action === "accept") {
      if (place.solid === true) {
        // keep
      } else if (place.solid === false || !isSolidKeepLocation(displayLoc, region)) {
        action = "skip";
      }
    }
    if (action === "accept" && !KEEP_REGIONS.includes(region)) {
      action = region === "Asian" || region === "African" ? "reject" : "skip";
    }

    // Confidence rate from source
    const fromResume =
      hasResume &&
      (resumeLoc ||
        (place.signals || []).some((s) =>
          /match:|phone:|resume|header/i.test(String(s))
        ));
    const fromUni = (place.signals || []).some((s) =>
      /university:/i.test(String(s))
    );
    const fromWfCity = !!(isWf && city && place.action === "accept");
    let rateOut = "75%";
    if (fromResume && resumeLoc) rateOut = "96%";
    else if (fromResume) rateOut = "90%";
    else if (fromWfCity && fromUni) rateOut = "88%";
    else if (fromWfCity && phoneForRegion) rateOut = "85%";
    else if (fromWfCity) rateOut = "82%";
    else if (fromUni) rateOut = "80%";
    else if (form) rateOut = "80%";
    else if (bodyLoc) rateOut = "78%";
    else if (phoneForRegion && phoneRegion(phoneForRegion)) rateOut = "70%";
    if (action !== "accept") rateOut = rateOut === "96%" ? "90%" : rateOut;

    const decision = {
      region,
      action,
      location: displayLoc,
      tag: null,
      rate: rateOut,
      signals: place.signals || [],
    };

    const row = {
      Name: nameFinal,
      Email: emailFinal,
      "Job site name": jobSite(subject, fromText, text),
      "LinkedIn profile": linkedinFinal,
      "GitHub / Portfolio": ghFinal.url || portfolioFinal || "",
      "Current location": decision.location,
      Region: decision.region,
      "Location correct rate": decision.rate,
      University: uniFinal,
      "Work location hints": work.map((h) => `${h.kind}:${h.location}`).join("; "),
      Reason: `filter: ${decision.action}/${decision.region} (${(decision.signals || []).join(", ") || "n/a"})${fromResume ? " [resume-first]" : ""}`,
    };

    const keepOk =
      decision.action === "accept" && isRealCandidate(row, hasResume);
    decision.tag = keepOk ? thunderbirdTagForRegion(decision.region) : null;

    if (tagMail && msg.uid) {
      if (decision.tag) {
        pendingTags.push({ uid: msg.uid, region: decision.region });
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
      return;
    }

    let shouldLog = true;
    if (emailFinal) {
      const idx = rows.findIndex(
        (r) =>
          clean(r.Email).toLowerCase() === clean(emailFinal).toLowerCase()
      );
      if (idx >= 0) {
        const score = (r) =>
          (clean(r["LinkedIn profile"]) ? 2 : 0) +
          (clean(r["GitHub / Portfolio"]) ? 2 : 0) +
          (clean(r["Current location"]) ? 1 : 0) +
          (parseInt(r["Location correct rate"], 10) || 0) / 100;
        if (score(row) > score(rows[idx])) rows[idx] = row;
        else shouldLog = false;
      } else {
        rows.push(row);
      }
    } else {
      rows.push(row);
    }

    if (!shouldLog) return;

    const siteLabel = row["Job site name"] || "";
    const wfTag = /wellfound/i.test(siteLabel) ? " [Wellfound]" : "";
    const line = `${rows.length}. ${row.Name} | ${row["Current location"] || "—"} | ${decision.region} | ${row["Location correct rate"]}${wfTag}${fromResume || resumeLoc ? " [resume]" : ""}${decision.tag ? (decision.region === "American" ? " [→red]" : " [→yellow]") : ""}`;
    log(line, { apps: rows.length });
  }

  let client = await openClient();
  let lock = await client.getMailboxLock("INBOX");
  const total = client.mailbox.exists || 0;

  async function fetchRange(range, opts = {}) {
    for await (const msg of client.fetch(
      range,
      {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
      },
      opts
    )) {
      try {
        await processMessage(msg);
      } catch (e) {
        console.error(`msg ${msg.uid}:`, e.message);
        if (typeof onProgress === "function") {
          onProgress({ type: "error", message: `msg ${msg.uid}: ${e.message}` });
        }
      }
    }
  }

  async function fetchWithRetry(range, label, opts = {}) {
    try {
      await fetchRange(range, opts);
    } catch (e) {
      log(`${label} failed (${e.message}); reconnecting…`);
      try {
        lock.release();
      } catch (_) {}
      try {
        await client.logout();
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 2000));
      client = await openClient();
      lock = await client.getMailboxLock("INBOX");
      try {
        await fetchRange(range, opts);
      } catch (err2) {
        log(`${label} skipped: ${err2.message}`);
      }
    }
  }

  // 0 / invalid = scan entire mailbox; otherwise last N messages
  const scanAll = !Number.isFinite(rawLimit) || rawLimit <= 0;
  const scanLimit = scanAll ? total : Math.min(Math.floor(rawLimit), total);
  const fromSeq = Math.max(1, total - scanLimit + 1);
  const scanLabel = scanAll || scanLimit >= total ? `all ${total}` : `last ${scanLimit}`;

  const onlyUids = Array.isArray(account.onlyUids)
    ? account.onlyUids.map(Number).filter((n) => n > 0)
    : [];

  try {
    if (onlyUids.length) {
      log(`Re-checking ${onlyUids.length} specific message(s) in ${mailUser}…`);
      await fetchWithRetry(onlyUids, "UID list", { uid: true });
    } else if (unreadOnly) {
      // Real IMAP UNSEEN search (not “last N then skip read”)
      let uids = [];
      try {
        uids = await client.search({ seen: false }, { uid: true });
      } catch (e) {
        log(
          `UNSEEN search failed (${e.message}); falling back to flag filter on ${scanLabel}…`
        );
        uids = null;
      }

      if (Array.isArray(uids)) {
        uids = uids.map(Number).filter((n) => n > 0).sort((a, b) => a - b);
        if (!scanAll && uids.length > scanLimit) uids = uids.slice(-scanLimit);
        log(
          `Scanning ${mailUser}: ${uids.length} unread message(s) (${scanAll ? "no cap" : `cap ${scanLimit}`}, mailbox has ${total})…`,
          { account: mailUser, unread: uids.length, total, scanLimit }
        );
        if (!uids.length) {
          log(`No unread messages in ${mailUser}.`);
        } else {
          for (let i = 0; i < uids.length; i += batchSize) {
            const chunk = uids.slice(i, i + batchSize);
            if (typeof onProgress === "function") {
              onProgress({
                type: "batch",
                message: `Unread batch ${i + 1}–${Math.min(i + chunk.length, uids.length)} of ${uids.length}`,
              });
            }
            await fetchWithRetry(chunk, `Unread batch ${chunk[0]}…${chunk[chunk.length - 1]}`, {
              uid: true,
            });
          }
        }
      } else {
        // Fallback: last N (or all) by sequence, skip \\Seen
        log(
          `Scanning ${mailUser} seq ${fromSeq}…${total} (unreadOnly fallback, ${scanLabel}, batch=${batchSize})…`
        );
        for (let start = fromSeq; start <= total; start += batchSize) {
          const end = Math.min(total, start + batchSize - 1);
          await fetchWithRetry(`${start}:${end}`, `Batch ${start}-${end}`);
        }
      }
    } else {
      log(
        `Scanning ${mailUser} seq ${fromSeq}…${total} (${scanLabel}, batch=${batchSize})…`,
        { account: mailUser, fromSeq, total, scanLimit }
      );
      for (let start = fromSeq; start <= total; start += batchSize) {
        const end = Math.min(total, start + batchSize - 1);
        if (typeof onProgress === "function") {
          onProgress({
            type: "batch",
            message: `Batch ${start}–${end}`,
            start,
            end,
            total,
          });
        }
        await fetchWithRetry(`${start}:${end}`, `Batch ${start}-${end}`);
      }
    }
  } finally {
    try {
      lock.release();
    } catch (_) {}
  }

  // Tag + mark-read on a fresh connection (avoids mid-scan dropouts)
  const byUid = new Map();
  for (const t of pendingTags) byUid.set(t.uid, t.region);
  const untagList = [...new Set(pendingUntag)].filter(
    (uid) => uid > 0 && !byUid.has(uid)
  );
  // Always mark tagged keepers as read when markAsRead is on
  if (markAsRead) {
    for (const uid of byUid.keys()) markReadUids.add(uid);
  }
  const readList = [...markReadUids].filter((uid) => uid > 0);
  const needPass =
    (tagMail && (byUid.size > 0 || untagList.length > 0)) ||
    (markAsRead && readList.length > 0);

  if (needPass) {
    const runFlagPass = async () => {
      try {
        await client.logout();
      } catch (_) {}
      client = await openClient();
      lock = await client.getMailboxLock("INBOX");

      if (tagMail && untagList.length) {
        log(`Clearing ${untagList.length} wrong Thunderbird tag(s)…`);
        for (const uid of untagList) {
          try {
            await client.messageFlagsRemove(uid, TAG_LABELS, { uid: true });
            untagged += 1;
          } catch (e) {
            log(`Untag failed uid ${uid}: ${e.message}`);
          }
        }
        log(`Cleared tags on ${untagged} message(s).`);
      }

      if (tagMail && byUid.size) {
        log(`Applying ${byUid.size} Thunderbird tag(s)…`);
        let tagFail = 0;
        for (const [uid, region] of byUid) {
          try {
            const ok = await applyThunderbirdTag(client, uid, region);
            if (ok) tagged += 1;
            else tagFail += 1;
          } catch (e) {
            tagFail += 1;
            log(`Tag failed uid ${uid}: ${e.message}`);
          }
        }
        log(
          `Tagged ${tagged} message(s) (American=red $label1; Canada/EU/Latina=yellow $label2) + starred${tagFail ? ` · ${tagFail} failed` : ""}.`
        );
        log(
          `Thunderbird tip: right-click Inbox → Properties → Repair Folder, then enable the Tags column. Server already has the flags.`
        );
      }

      if (markAsRead && readList.length) {
        log(`Marking ${readList.length} scanned message(s) as read…`);
        for (let i = 0; i < readList.length; i += batchSize) {
          const chunk = readList.slice(i, i + batchSize);
          try {
            await client.messageFlagsAdd(chunk, ["\\Seen"], { uid: true });
            markedRead += chunk.length;
          } catch (e) {
            for (const uid of chunk) {
              try {
                await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
                markedRead += 1;
              } catch (err) {
                log(`Mark-read failed uid ${uid}: ${err.message}`);
              }
            }
          }
        }
        log(`Marked ${markedRead} message(s) as read.`);
      }
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
  const filledRows = [];
  const dedupe = new Set();
  for (const r of rows) {
    const name = clean(r.Name);
    const loc = clean(r["Current location"]);
    const rate = clean(r["Location correct rate"]);
    const region = clean(r.Region);
    if (!name && !loc && (rate === "0%" || !rate)) continue;
    // Drop empty-location / unknown / hubs from kept sheets
    if (!loc || region === "Unknown" || rate === "0%") continue;
    if (isJobHub(loc) || isVagueMetro(loc)) continue;
    if (!KEEP_REGIONS.includes(region)) continue;
    if (!isRealPersonName(name)) continue;
    const emailKey = clean(r.Email).toLowerCase();
    const dk = emailKey || `n:${name.toLowerCase()}|${loc.toLowerCase()}`;
    if (dedupe.has(dk)) continue;
    dedupe.add(dk);
    // Keep scan Region — do NOT reclassify
    r["Current location"] = enrichKnownCity(sanitizeLocation(loc) || loc) || loc;
    filledRows.push(r);
  }

  const out = path.join(exportsDir, exportFileNameFor(account));
  const { path: written, counts } = await writeExcelSafe(filledRows, out);
  const wellfoundCount =
    counts.Wellfound ??
    filledRows.filter((r) => /wellfound/i.test(r["Job site name"] || "")).length;
  const doneMsg = `Done → ${written} | scanned ${scanLabel} | apps=${filledRows.length} | Wellfound=${wellfoundCount} | tagged=${tagged} | markedRead=${markedRead} | American=${counts.American || 0} Canada=${counts.Canada || 0} European=${counts.European || 0} Latina=${counts.Latina || 0}`;
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
