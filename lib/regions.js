const EU = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "NO", "CH", "GB", "UK",
]);
const LATAM = new Set([
  "AR", "BO", "BR", "CL", "CO", "CR", "CU", "DO", "EC", "SV", "GT", "HN", "MX",
  "NI", "PA", "PY", "PE", "PR", "UY", "VE",
]);
const ASIA = new Set([
  "AF", "AM", "AZ", "BH", "BD", "BT", "BN", "KH", "CN", "GE", "IN", "ID", "IR",
  "IQ", "IL", "JP", "JO", "KZ", "KW", "KG", "LA", "LB", "MY", "MV", "MN", "MM",
  "NP", "KP", "OM", "PK", "PH", "QA", "SA", "SG", "KR", "LK", "SY", "TW", "TJ",
  "TH", "TR", "TM", "AE", "UZ", "VN", "YE", "HK", "MO",
]);
const AFRICA = new Set([
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CM", "CV", "CF", "TD", "KM", "CG", "CD",
  "CI", "DJ", "EG", "GQ", "ER", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS",
  "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW",
  "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "SZ", "TZ", "TG", "TN", "UG",
  "ZM", "ZW",
]);

const LOCATION_PATTERNS = [
  [/university of south carolina|\busc\b/i, "US"],
  [/university of north florida|\bunf\b/i, "US"],
  [/university of texas|ut austin/i, "US"],
  [/luther college|luther\.edu/i, "US"],
  // Canada — before US. City + province only (never bare "ON Location")
  [/\b[a-z][a-z .'-]{1,40},\s*(?:on|bc|ab|qc|mb|sk|ns|nb|nl|pe|nt|yt|nu)\b(?!\s*location)/i, "CA"],
  [/toronto|ottawa|vancouver|montr[eé]al|calgary|edmonton|winnipeg|victoria(?!\s*,?\s*(?:tx|australia))|halifax|mississauga|brampton|hamilton(?!\s*,?\s*(?:oh|nz|bermuda))|london,\s*on\b|quebec(?:\s*city)?|saskatoon|regina|kelowna|burnaby|surrey,\s*bc|laval|gatineau|markham|vaughan|kitchener|waterloo(?!\s*,?\s*ia)|\bcanada\b|\bontario\b|\bquebec\b|british columbia|alberta|manitoba|saskatchewan|nova scotia|newfoundland|prince edward island/i, "CA"],
  // City, ST (US) — Bradenton, FL / Seattle, WA (exclude CA provinces already handled)
  [/\b[a-z][a-z .'-]{1,40},\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i, "US"],
  [/jacksonville,\s*fl|dallas,\s*tx|san antonio,\s*tx|chicago,\s*il|new york,\s*ny|los angeles,\s*ca|miami,\s*fl|atlanta,\s*ga|boston,\s*ma|seattle,\s*wa|austin,\s*tx|houston,\s*tx|philadelphia,\s*pa|phoenix,\s*az|denver,\s*co|portland,\s*or|columbia,\s*sc|jefferson city|crete,\s*il|new brunswick,\s*nj|decorah|bradenton|savannah,\s*ga|savannah georgia/i, "US"],
  [/santo domingo|dominican republic|\bcosta rica\b|\bpanama\b|guatemala|mexico city|\bmexico\b|\bbrazil\b|são paulo|sao paulo|buenos aires|argentina|colombia|\bbogota\b|\bchile\b|\bsantiago\b|\bperu\b|\blima\b|ecuador|venezuela|uruguay|paraguay|latin america|latam|puerto rico|monterrey|guadalajara|tijuana|puebla|quer[eé]taro|canc[uú]n|m[eé]rida|leon,\s*mexico|le[oó]n,\s*gto/i, "LATAM"],
  [/lombardy|corte franca|\bmilan\b|\brome\b|\bitaly\b|portugal|lisbon|algés|oeiras|madrid|\bspain\b|catalonia|catalunya|barcelona|\bparis\b|\bfrance\b|berlin|germany|\blondon\b|united kingdom|england|scotland|wales|dublin|ireland|amsterdam|netherlands|brussels|belgium|vienna|austria|zurich|switzerland|warsaw|\bpoland\b|bucharest|romania|athens|greece|stockholm|sweden|oslo|norway|copenhagen|denmark|helsinki|finland|prague|czech|budapest|hungary|moldova|ukraine|kyiv|kiev|croatia|dubrovnik|zagreb|murcia|\beurope\b|\beuropean\b|\beu\b/i, "EU"],
  [/tbilisi|batumi|kutaisi|\bgeorgia\b|thimphu|bhutan|peshawar|sindh|gujrat|punjab|university of central punjab|university of engineering and technology|kanpur|gurgaon|gurugram|noida|vadodara|bhopal|bhilai|rampur|indore|lucknow|jaipur|faridabad|ghaziabad|north goa|\bgoa\b|\bindia\b|bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|kolkata|pune|ahmedabad|surat|gujarat|pakistan|karachi|lahore|bangladesh|dhaka|philippines|manila|\bchina\b|beijing|shanghai|\bjapan\b|tokyo|\bkorea\b|seoul|singapore|malaysia|indonesia|thailand|vietnam|\bnepal\b|sri lanka|dubai|uae|saudi|israel|\bturkey\b|istanbul|\biran\b|\biraq\b|kazakhstan|uzbekistan|armenia|azerbaijan|belarus|minsk|russia|moscow|saint petersburg|st\.?\s*petersburg/i, "ASIA"],
  [/kenyatta|makerere|strathmore|obafemi|covenant university|university of ibadan|university of ghana|kwame nkrumah|addis ababa|tetouan|nigeria|lagos|abuja|\bkenya\b|nairobi|\bghana\b|accra|south africa|johannesburg|cape town|\begypt\b|cairo|ethiopia|morocco|algeria|tunisia|uganda|tanzania|cameroon|senegal|zimbabwe|madagascar|antananarivo|africa/i, "AFRICA"],
  [/university of tulsa|university of central florida|\bucf\b/i, "US"],
  [/united states|u\.s\.a?|\busa\b|u\.s\. based|american citizen|us citizen/i, "US"],
  [/washington,?\s*d\.?c\.?|district of columbia|\bdc\b/i, "US"],
  [/san francisco bay area|sf bay area|\bbay area\b|san francisco/i, "US"],
  [/san francisco|bay area|fresno|las vegas|fullerton|princeton|brooklyn|the woodlands|tampa|texas|florida|california|new york|illinois|missouri|iowa|georgia,\s*usa|south carolina|north carolina|ohio|michigan|colorado|arizona|nevada|virginia|maryland|pennsylvania|massachusetts|connecticut|new jersey|tennessee|louisiana|alabama|utah|oregon|washington state|minnesota|wisconsin|kansas|indiana|dallas|frisco|austin|jacksonville|san antonio|chicago|seattle|atlanta|boston|denver|houston|philadelphia|phoenix|portland|detroit|miami|orlando|raleigh|charlotte|nashville|baltimore|pittsburgh|columbus|indianapolis|milwaukee|omaha|sacramento|salt lake|honolulu|alaska|hawaii|walnut|potomac|corona,\s*ca|grapevine|fremont|sunnyvale|mountain view|palo alto|san jose|oakland|berkeley|santa clara|cupertino|redwood city|san mateo|milpitas|hayward|concord|irvine|san diego|long beach|anaheim|santa monica|pasadena|burbank|glendale|torrance|plainsboro|reston|arlington,\s*va|alexandria|bethesda|rockville|silver spring|cambridge|somerville|bellevue|redmond|kirkland|tacoma|plano|irving|arlington,\s*tx|fort worth|san marcos|round rock|cedar park/i, "US"],
];

function stripNoise(text = "") {
  return String(text)
    .replace(/\([^)]*\balso\b[^)]*\)/gi, " ")
    .replace(/\balso\b[^,;\n]{0,50}\bexperience\b/gi, " ")
    .replace(/GoHire[\s\S]{0,500}?(?:York|United Kingdom)[\s\S]{0,120}/gi, " ")
    .replace(/\bUnited Kingdom\b(?![^\n]{0,40}(?:candidate|applicant|based|live|living))/gi, " ")
    .replace(/\bon[\s-]?location\b/gi, " ")
    .replace(/\bon[\s-]?site\b/gi, " ")
    .replace(
      /\b(?:for|across|with|throughout|serving|clients?(?:\s+in|\s+across)?|products?\s+for|projects?\s+for|built\s+(?:for|products?\s+for)|working\s+with\s+clients?\s+(?:in|across))\s+(?:the\s+)?(?:united states|u\.s\.a?\.?|usa|canada|europe|latin america|latam|india|asia|africa|pakistan|bangladesh)\b/gi,
      " "
    )
    .replace(
      /\b(?:clients?|products?|projects?)\s+(?:across|throughout|in)\s+(?:india|asia|africa|pakistan|bangladesh|europe|latin america)\b/gi,
      " "
    )
    .replace(
      /\b(?:remote\s+)?(?:within\s+)?(?:european|eu|africa|asia|us|u\.s\.?)\s+time\s*zones?\b/gi,
      " "
    );
}

/** True job-board / preference vagueness — NOT real Wellfound profile places */
function isJobHub(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  return /^(us[\s\-]?based|u\.s\.?[\s\-]?based|united states[\s\-]?based|usa[\s\-]?based|america|american|remote(?:\s*\(us\))?|open to remote|fully remote|flexible|worldwide|anywhere|relocat(?:e|ion)|willing to reloc(?:ate|e)|greater twin cities(?: area)?|twin cities|nyc metro|on[\s\-]?site|hybrid|full[\s\-]?time|part[\s\-]?time|contract)$/i.test(
    t
  );
}

function isVagueMetro(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // Real Wellfound / profile regions we keep
  if (
    /^(san francisco(?: bay area)?|sf bay area|bay area|new york(?: city)?|nyc|los angeles|la|washington,?\s*d\.?c\.?|district of columbia|europe|european(?:\s+union)?|\beu\b|united states|u\.s\.a?\.?|usa|canada|latin america|latam)$/i.test(
      t
    )
  ) {
    return false;
  }
  return (
    /^(greater\s+.+|twin cities|.+\s+metro(?:politan)?(?:\s+area)?)$/i.test(t) ||
    /^(european|eu|africa|asia)\s+time/i.test(t) ||
    /^remote\b/i.test(t)
  );
}

/** Usable short place string for channel matching */
function usablePlace(text) {
  const t = stripNoise(String(text || "").trim());
  if (!t || isWeakLocation(t) || isJobHub(t) || isVagueMetro(t)) return "";
  return t;
}

/**
 * Try short place channels in order — first decisive accept/reject wins.
 */
function placeFromChannels(channels) {
  for (const raw of channels) {
    const t = usablePlace(raw);
    if (!t) continue;
    const hit = classifyForm(t);
    if (hit.action !== "skip") return { place: hit, channel: t };
  }
  return null;
}

function actionFor(region, label) {
  const raw = String(label || "");
  let home = "";
  if (raw.startsWith("match:")) home = raw.slice(6);
  else if (raw.startsWith("phone:")) home = regionCountryLabel(region);
  if (region === "US" || region === "CA" || region === "EU" || region === "LATAM") {
    return { region, action: "accept", signals: [raw], home };
  }
  if (region === "ASIA" || region === "AFRICA") {
    return { region, action: "reject", signals: [raw], home };
  }
  return { region: "UNKNOWN", action: "skip", signals: [raw || "weak-location"], home: "" };
}

function regionCountryLabel(code) {
  const map = {
    US: "United States",
    CA: "Canada",
    EU: "Europe",
    LATAM: "Latin America",
    ASIA: "India",
    AFRICA: "Africa",
  };
  return map[code] || "";
}

function fromPhone(phone) {
  const raw = String(phone || "");
  if (!raw || /5261935173/.test(raw)) {
    return { region: "UNKNOWN", action: "skip", signals: ["weak-location"], home: "" };
  }
  const region = phoneRegion(raw);
  if (!region) return { region: "UNKNOWN", action: "skip", signals: ["weak-location"], home: "" };
  return actionFor(region, `phone:${raw}`);
}

/** Canadian NANP area codes (subset of common ones) */
const CA_AREA = new Set([
  "204", "226", "236", "249", "250", "289", "306", "343", "365", "367", "403", "416",
  "418", "431", "437", "438", "450", "506", "514", "519", "548", "579", "581", "587",
  "604", "613", "639", "647", "672", "705", "709", "778", "780", "782", "807", "819",
  "825", "867", "873", "902", "905",
]);

function phoneRegion(phone) {
  const raw = String(phone || "");
  const p = raw.replace(/\s/g, "");
  const digits = raw.replace(/\D/g, "");

  // Dominican Republic / Caribbean NANP — not US mainland
  if (/^\+?1?(809|829|849)/.test(digits) || /\((809|829|849)\)/.test(raw)) {
    return "LATAM";
  }

  // NANP first: +1XXXXXXXXXX or bare 10-digit (US/Canada area codes)
  // Do NOT treat bare 10-digit 6–9… as India — that wrongly rejects Boston/LA.
  const nanp =
    digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  if (nanp.length === 10) {
    if (CA_AREA.has(nanp.slice(0, 3))) return "CA";
    // Puerto Rico NANP → LATAM keep sheet
    if (/^(787|939)/.test(nanp)) return "LATAM";
    return "US";
  }
  if (/^\+1/.test(p) || /^1\d{10}$/.test(digits)) {
    const rest = digits.startsWith("1") ? digits.slice(1) : digits;
    if (rest.length >= 10) {
      const area = rest.slice(0, 3);
      if (CA_AREA.has(area)) return "CA";
      if (/^(787|939|809|829|849)/.test(area)) return "LATAM";
      return "US";
    }
  }

  // India / Asia — require explicit country code (+91 or 91 + 10-digit mobile)
  if (/^\+91/.test(p) || /^91[6-9]\d{9}$/.test(digits)) return "ASIA";
  if (/^\+92|^\+880|^\+63|^\+86|^\+81|^\+82|^\+65|^\+60|^\+62|^\+66|^\+84|^\+995/.test(p))
    return "ASIA";
  if (digits.startsWith("995") && digits.length >= 11) return "ASIA"; // Georgia country

  if (/^\+44|^\+49|^\+33|^\+34|^\+39|^\+351|^\+31|^\+48|^\+40|^\+43|^\+41|^\+46|^\+47|^\+45|^\+358|^\+353|^\+32|^\+30|^\+36|^\+420|^\+421/.test(p))
    return "EU";
  if (/^\+55|^\+52|^\+54|^\+57|^\+56|^\+51|^\+58|^\+506|^\+507|^\+502|^\+503|^\+504|^\+505/.test(p))
    return "LATAM";
  if (/^\+234|^\+254|^\+233|^\+27|^\+20|^\+261|^\+256|^\+255|^\+237|^\+221/.test(p))
    return "AFRICA";
  return null;
}

function extractPhone(text = "") {
  const match = String(text).match(/\+?\d[\d\s().-]{8,}\d/g) || [];
  // Prefer numbers with explicit country code (+)
  const scored = match
    .map((item) => {
      const digits = item.replace(/\D/g, "");
      let score = 0;
      if (item.trim().startsWith("+")) score += 5;
      if (digits.length >= 10 && digits.length <= 15) score += 2;
      if (/^91[6-9]\d{9}$/.test(digits) || /^\+91/.test(item)) score += 3;
      return { item, digits, score };
    })
    .filter((x) => x.digits.length >= 10 && x.digits.length <= 15)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.item || "";
}

function locationHits(text) {
  const source = String(text || "");
  const hits = [];
  for (const [pattern, region] of LOCATION_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match;
    while ((match = re.exec(source))) {
      hits.push({ region, index: match.index, text: match[0] });
      if (!match[0]) re.lastIndex += 1;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

function matchLocation(text) {
  const source = stripNoise(text);
  if (!source.trim() || isJobHub(source) || isVagueMetro(source)) {
    return { region: "UNKNOWN", signals: [] };
  }
  const hits = locationHits(source);
  if (!hits.length) return { region: "UNKNOWN", signals: [] };

  const headerHits = source.length > 240 ? hits.filter((hit) => hit.index < 700) : hits;
  const pool = headerHits.length ? headerHits : hits;
  const chosen = pool[0];
  // Georgia country (Asia) vs US state — only when the chosen hit is Georgia/Tbilisi
  // (do not flip a US city just because "Georgia" appears later in the doc)
  if (/tbilisi|batumi|kutaisi/i.test(chosen.text)) {
    return { region: "ASIA", signals: [`match:${chosen.text}`, "context:georgia-country"] };
  }
  if (/\bgeorgia\b/i.test(chosen.text)) {
    const usGeorgia =
      /\b(usa|united states|u\.?s\.?a?|atlanta|savannah|augusta|columbus|macon|marietta|,?\s*ga\b)\b/i.test(
        source
      ) ||
      /\bgeorgia\s+(?:institute|tech|university|state|southern|college)\b/i.test(source) ||
      /\b(?:institute|university|tech|college)\s+of\s+georgia\b/i.test(source);
    if (usGeorgia) {
      return { region: "US", signals: [`match:${chosen.text}`, "context:georgia-us-state"] };
    }
    if (/tbilisi|batumi|kutaisi/i.test(source)) {
      return { region: "ASIA", signals: [`match:${chosen.text}`, "context:georgia-country"] };
    }
    // Bare "Georgia" with no US/country context → skip (ambiguous)
    return { region: "UNKNOWN", signals: [`match:${chosen.text}`, "ambiguous:georgia"] };
  }
  return { region: chosen.region, signals: [`match:${chosen.text}`] };
}

function resumeHome(text) {
  const head = String(text || "").split(
    /\n(?=\s*(?:professional summary|professional experience|work experience|experience|education|technical skills|projects|certifications)\b)/i
  )[0];
  const lines = head
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  let best = null;
  let bestScore = 0;
  for (const line of lines) {
    if (line.length > 160 && !/\|/.test(line)) continue;

    // Explicit Location / Address / Based in labels — strongest
    const labeled = line.match(
      /(?:^|\b)(?:location|based in|address|lives? in|current location|residing in)\s*[:|]?\s*(.+)$/i
    );
    if (labeled) {
      const hit = matchLocation(labeled[1]);
      if (hit.region !== "UNKNOWN") {
        const score = 20;
        if (score > bestScore) {
          best = hit;
          bestScore = score;
        }
        continue;
      }
    }

    const hit = matchLocation(line);
    if (hit.region === "UNKNOWN") continue;
    let score = 1;
    if (line.length <= 90) score += 2;
    if (/\|/.test(line) || /@/.test(line)) score += 6;
    if (/,/.test(line)) score += 3;
    if (/\+\d{1,3}[\s-]?\d/.test(line)) score += 4; // phone on header line
    // Prefer Asia/Africa/Latam/EU over US hubs in header when both appear later
    if (["ASIA", "AFRICA", "LATAM", "EU"].includes(hit.region)) score += 2;
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }

  // Phone in resume header (e.g. +91) when no place line
  if (!best || bestScore < 4) {
    const phone = extractPhone(head);
    const pr = phoneRegion(phone);
    if (pr) {
      return {
        region: pr,
        signals: [`phone:${phone}`, "context:resume-header-phone"],
      };
    }
  }
  return best;
}

function basedIn(text) {
  const match = String(text || "").match(
    /(?:based in|located in|live in|living in|i live in|hometown(?: is|:)?|currently in|residing in)\s+([A-Za-z .,'-]{2,60})/i
  );
  if (!match) return null;
  const hit = matchLocation(match[1]);
  return hit.region === "UNKNOWN" ? null : hit;
}

function classifyDocument(text) {
  const header = resumeHome(text);
  if (header) return actionFor(header.region, header.signals[0] || "match:header");
  const phrase = basedIn(text);
  if (phrase) return actionFor(phrase.region, phrase.signals[0] || "match:based-in");
  // Deep pass only on cleaned text — client/country noise already stripped.
  // Prefer City,ST / labeled places; skip bare continent/country-only hits from body.
  const deepSrc = stripNoise(String(text || "").slice(0, 2500));
  const deep = matchLocation(deepSrc);
  if (deep.region !== "UNKNOWN") {
    const label = (deep.signals.find((s) => String(s).startsWith("match:")) || "").slice(6);
    const bareCountry =
      /^(india|pakistan|bangladesh|china|japan|korea|asia|africa|europe|canada|mexico|brazil|germany|spain|france|italy|poland|russia|belarus)$/i.test(
        String(label || "").trim()
      );
    // Bare country from deep body without header → too weak (client mentions survive stripNoise)
    if (!bareCountry) {
      return actionFor(deep.region, deep.signals[0] || "match:resume-body");
    }
  }
  const phone = extractPhone(text);
  const pr = phoneRegion(phone);
  if (pr) return actionFor(pr, `phone:${phone}`);
  return { region: "UNKNOWN", action: "skip", signals: ["no-header"], home: "" };
}

function classifyForm(location) {
  const parts = stripNoise(location)
    .split(/\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  // First decisive part wins (preserves form → location_field order).
  // Avoids "Austin, TX; Mumbai" wrongly rejecting a US local.
  for (const part of parts) {
    const hit = matchLocation(part);
    if (hit.region === "UNKNOWN") continue;
    const label = hit.signals.find((item) => item.startsWith("match:")) || `match:${part}`;
    return actionFor(hit.region, label);
  }
  return { region: "UNKNOWN", action: "skip", signals: ["job-hub"], home: "" };
}

function classifyCandidate({ resume = "", location = "", phone = "", email = "" } = {}) {
  const resumeText = String(resume || "").trim();
  const form = String(location || "");
  if (resumeText.length > 20) {
    const header = classifyDocument(resumeText);
    if (header.action !== "skip") return header;
  } else if (form.length > 240 || form.includes("\n")) {
    const header = classifyDocument(form);
    if (header.action !== "skip") return header;
    return fromPhone(phone);
  }

  if (!isWeakLocation(form)) {
    const place = classifyForm(form);
    if (place.action !== "skip") return place;
  }
  return fromPhone(phone);
}

function inferRegion(text = "", email = "", phone = "", nested = false) {
  const signals = [];
  const cleaned = stripNoise(text);
  const phoneText = phone || extractPhone(cleaned);
  const haystack = `${cleaned}\n${email}\n${phoneText}`;

  const direct = matchLocation(cleaned);
  if (direct.region !== "UNKNOWN") return direct;

  if (!nested) {
    const live = haystack.match(
      /(?:based in|located in|live in|living in|i live in|hometown(?: is|:)?|from)\s+([A-Za-z .,'-]{2,60})/i
    );
    if (live) {
      signals.push(`phrase:${live[0]}`);
      const fromPhrase = inferRegion(live[1], email, phoneText, true);
      if (fromPhrase.region !== "UNKNOWN") {
        return { region: fromPhrase.region, signals: [...signals, ...fromPhrase.signals] };
      }
    }

    const school = haystack.match(
      /((?:university|college|institute|politecnico|universidad|universidade|universit[aä]|école|ecole)[^,\n]{0,80})/i
    );
    if (school) {
      signals.push(`university:${school[1].trim()}`);
      if (/\.edu\b/i.test(school[1]) || /\.edu\b/i.test(email)) {
        return { region: "US", signals: [...signals, "university:.edu"] };
      }
      const fromSchool = matchLocation(school[1]);
      if (fromSchool.region !== "UNKNOWN") {
        return { region: fromSchool.region, signals: [...signals, ...fromSchool.signals] };
      }
    }
  }

  const pr = phoneRegion(phoneText);
  if (pr) return { region: pr, signals: [`phone:${phoneText}`] };

  if (/\.edu\b/i.test(email) || /\.edu\b/i.test(cleaned)) {
    return { region: "US", signals: ["email:.edu"] };
  }

  if (/\b(remote|flexible|anywhere|worldwide)\b/i.test(haystack)) {
    return { region: "UNKNOWN", signals: ["ambiguous:remote"] };
  }

  return { region: "UNKNOWN", signals };
}

function decide(region, acceptRegions, rejectRegions, reviewIfUnknown) {
  if (acceptRegions.includes(region)) {
    return { action: "accept", reason: `Region ${region} is allowed` };
  }
  if (rejectRegions.includes(region)) {
    return { action: "reject", reason: `Region ${region} is blocked` };
  }
  if (reviewIfUnknown) {
    return { action: "review", reason: "Location could not be confirmed" };
  }
  return { action: "reject", reason: "Unknown region defaults to reject" };
}

function isWeakLocation(location) {
  const text = String(location || "").trim();
  if (!text) return true;
  return /^(remote|flexible|anywhere|worldwide|unknown|n\/?a|-|—|you\.?|day one\.?)(\s*\(us\))?$/i.test(text)
    || /not in email|google drive only|could not be confirmed/i.test(text);
}

function classifyPlace(location, email = "", phone = "") {
  return classifyCandidate({ location, email, phone });
}

/** Map Mail-bot region codes → check-mail sheet labels */
const CHECK_MAIL_REGION = {
  US: "American",
  CA: "Canada",
  EU: "EU",
  LATAM: "Latin American",
  ASIA: "Asian",
  AFRICA: "African",
  UNKNOWN: "Unknown",
};

function toCheckMailRegion(code) {
  return CHECK_MAIL_REGION[code] || "Unknown";
}

/** Expand bare cities so Asia/etc is obvious — Delhi → Delhi, India */
function enrichKnownCity(loc) {
  const s = String(loc || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || /,/.test(s)) return s;

  const map = {
    delhi: "Delhi, India",
    "new delhi": "New Delhi, India",
    mumbai: "Mumbai, India",
    bangalore: "Bangalore, India",
    bengaluru: "Bengaluru, India",
    hyderabad: "Hyderabad, India",
    chennai: "Chennai, India",
    pune: "Pune, India",
    kolkata: "Kolkata, India",
    noida: "Noida, India",
    gurgaon: "Gurgaon, India",
    gurugram: "Gurugram, India",
    ahmedabad: "Ahmedabad, India",
    jaipur: "Jaipur, India",
    indore: "Indore, India",
    surat: "Surat, India",
    goa: "Goa, India",
    "north goa": "North Goa, India",
    "south goa": "South Goa, India",
    lahore: "Lahore, Pakistan",
    karachi: "Karachi, Pakistan",
    islamabad: "Islamabad, Pakistan",
    dhaka: "Dhaka, Bangladesh",
    singapore: "Singapore",
    jakarta: "Jakarta, Indonesia",
    manila: "Manila, Philippines",
    bangkok: "Bangkok, Thailand",
    seoul: "Seoul, South Korea",
    tokyo: "Tokyo, Japan",
    dubai: "Dubai, UAE",
    "mexico city": "Mexico City, Mexico",
    cdmx: "Mexico City, Mexico",
    bogota: "Bogotá, Colombia",
    bogotá: "Bogotá, Colombia",
    lima: "Lima, Peru",
    "buenos aires": "Buenos Aires, Argentina",
    "sao paulo": "São Paulo, Brazil",
    "são paulo": "São Paulo, Brazil",
    lagos: "Lagos, Nigeria",
    nairobi: "Nairobi, Kenya",
    cairo: "Cairo, Egypt",
    berlin: "Berlin, Germany",
    paris: "Paris, France",
    london: "London, United Kingdom",
    madrid: "Madrid, Spain",
    barcelona: "Barcelona, Spain",
    lisbon: "Lisbon, Portugal",
    amsterdam: "Amsterdam, Netherlands",
    warsaw: "Warsaw, Poland",
    tbilisi: "Tbilisi, Georgia",
    toronto: "Toronto, Canada",
    ottawa: "Ottawa, Canada",
    vancouver: "Vancouver, Canada",
    montreal: "Montreal, Canada",
    montréal: "Montreal, Canada",
    calgary: "Calgary, Canada",
    edmonton: "Edmonton, Canada",
    winnipeg: "Winnipeg, Canada",
    halifax: "Halifax, Canada",
    mississauga: "Mississauga, Canada",
    brampton: "Brampton, Canada",
    hamilton: "Hamilton, Canada",
    victoria: "Victoria, Canada",
  };
  return map[s.toLowerCase()] || s;
}

function isBareKeepLabel(text) {
  return /^(europe|european(?:\s+union)?|eu|united states|u\.s\.a?\.?|usa|america|canada|latin america|latam)$/i.test(
    String(text || "").trim()
  );
}

function isWorkClaim(text) {
  return /^(us[\s\-]?based|u\.s\.?[\s\-]?based|united states[\s\-]?based|usa[\s\-]?based|remote(?:\s*\(us\))?|open to remote|fully remote|flexible|hybrid|worldwide|anywhere|relocat(?:e|ion)|willing to relocate)$/i.test(
    String(text || "").trim()
  );
}

function bareCode(text) {
  const t = String(text || "");
  if (/latin|latam/i.test(t)) return "LATAM";
  if (/canada/i.test(t)) return "CA";
  if (/europe|\beu\b/i.test(t)) return "EU";
  if (/united states|u\.s|usa|america/i.test(t)) return "US";
  return "UNKNOWN";
}

/** One location string → specific city, bare country, work claim, or unknown */
function readPlace(text) {
  const raw = String(text || "").trim();
  if (!raw || isWeakLocation(raw) || raw.split(/\s+/).length > 8) return null;
  if (isWorkClaim(raw)) return { kind: "claim", text: raw };
  const t = stripNoise(raw);
  if (!t || isWeakLocation(t)) return null;
  if (isWorkClaim(t)) return { kind: "claim", text: t };
  if (isBareKeepLabel(t)) return { kind: "bare", text: t, region: bareCode(t) };
  if (isJobHub(t)) return { kind: "claim", text: t };
  const hit = matchLocation(t);
  if (!hit || hit.region === "UNKNOWN") return { kind: "unknown", text: t };
  return { kind: "specific", text: t, region: hit.region };
}

function phonePlace(phone) {
  const region = phoneRegion(phone);
  if (!region) return null;
  return { kind: "phone", region, text: regionCountryLabel(region) };
}

function packTier(tier, regionCode, location, signals, rate) {
  const region =
    regionCode && regionCode !== "UNKNOWN" ? toCheckMailRegion(regionCode) : "Unknown";
  const loc = enrichKnownCity(location) || location || "";
  if (tier === "reject") {
    return {
      location: loc || regionCountryLabel(regionCode) || "",
      region,
      action: "reject",
      tier,
      signals,
      solid: false,
      rate: "0%",
    };
  }
  if (tier === "confirmed") {
    return {
      location: loc,
      region,
      action: "accept",
      tier,
      signals,
      solid: true,
      rate: rate || "90%",
    };
  }
  if (tier === "possible") {
    return {
      location: loc,
      region,
      action: "accept",
      tier,
      signals,
      solid: false,
      rate: rate || "50%",
    };
  }
  return {
    location: "",
    region: "Unknown",
    action: "skip",
    tier: "skip",
    signals: signals || ["no-signal"],
    solid: false,
    rate: "0%",
  };
}

/**
 * Location decision for Excel + Thunderbird.
 * Confirmed = a real city in US / Canada / EU / Latin America (tagged red or yellow).
 * Possible = weak or missing home (continent, phone, school, "US Based", unknown city) — still a candidate.
 * Reject = a real Asia/Africa place, or a bare "Europe"/"United States" contradicted by school or phone.
 */
function filterApplicantLocation({
  resumeLoc = "",
  form = "",
  body = "",
  platformCity = "",
  workCity = "",
  lookingFor = "",
  university = "",
  phone = "",
  email = "",
  wellfound = false,
  platform = false,
} = {}) {
  if (wellfound || platform) return filterPlatformLocation({ platformCity, university });
  const keep = (code) => code === "US" || code === "CA" || code === "EU" || code === "LATAM";
  const reject = (code) => code === "ASIA" || code === "AFRICA";
  const strong = [platformCity, workCity, resumeLoc, form, body]
    .map(readPlace)
    .filter(Boolean);
  const look = readPlace(lookingFor);
  const uni = readPlace(university);
  const phoneHit = phonePlace(phone);
  const edu = /\.edu\b/i.test(university || "") || /\.edu\b/i.test(email || "");

  const specific = strong.find((p) => p.kind === "specific");
  if (specific && reject(specific.region)) {
    return packTier("reject", specific.region, specific.text, [`match:${specific.text}`, "specific-city"], "0%");
  }
  if (specific && keep(specific.region)) {
    return packTier("confirmed", specific.region, specific.text, [`match:${specific.text}`, "specific-city"], "90%");
  }

  const bare = strong.find((p) => p.kind === "bare");
  const unknown = strong.find((p) => p.kind === "unknown");
  const claim = strong.find((p) => p.kind === "claim");
  const weakReject = [uni, phoneHit].find((p) => p && reject(p.region));

  if (weakReject && !(specific && keep(specific.region))) {
    return packTier(
      "reject",
      weakReject.region,
      weakReject.text,
      [`${weakReject.kind}:${weakReject.text}`, bare ? `bare:${bare.text}` : ""].filter(Boolean),
      "0%"
    );
  }
  if (bare && keep(bare.region)) {
    return packTier("possible", bare.region, bare.text, [`bare:${bare.text}`], "55%");
  }
  if (unknown) {
    return packTier("possible", "UNKNOWN", unknown.text, [`unknown-city:${unknown.text}`], "40%");
  }
  if (look && look.kind === "specific" && reject(look.region)) {
    return packTier("reject", look.region, look.text, [`looking-for:${look.text}`], "0%");
  }
  if (look && look.kind === "specific" && keep(look.region)) {
    return packTier("possible", look.region, look.text, [`looking-for:${look.text}`], "50%");
  }
  if (uni && uni.kind === "specific" && keep(uni.region)) {
    return packTier("possible", uni.region, uni.text.slice(0, 80), [`university:${uni.text.slice(0, 80)}`], "50%");
  }
  if (edu) {
    return packTier("possible", "US", "United States", ["university:.edu"], "50%");
  }
  if (phoneHit && keep(phoneHit.region)) {
    return packTier("possible", phoneHit.region, phoneHit.text, [`phone:${phone}`], "50%");
  }
  if (look && look.kind === "bare" && keep(look.region)) {
    return packTier("possible", look.region, look.text, [`looking-for:${look.text}`], "45%");
  }
  if (look && look.kind === "unknown") {
    return packTier("possible", "UNKNOWN", look.text, [`looking-for:${look.text}`], "40%");
  }
  if (claim || (look && look.kind === "claim")) {
    const text = (claim || look).text;
    const usClaim = /us[\s-]?based|u\.s|united states|\busa\b/i.test(text);
    return packTier("possible", usClaim ? "US" : "UNKNOWN", text, [`claim:${text}`], "45%");
  }
  return packTier("skip", "UNKNOWN", "", ["no-signal"], "0%");
}

/**
 * Job-site platforms (Wellfound, Hubstaff, GoHire, Sulekha, etc.): profile city + university.
 * No resume, LinkedIn, or phone. Asia / Africa from either source is a reject.
 * A bare "Europe" or "United States" becomes confirmed when the university is in that same region.
 */
function platformSchool(university) {
  const raw = String(university || "");
  const text = stripNoise(raw);
  if (!text.trim()) {
    return /\.edu\b/i.test(raw) ? { code: "US", place: "United States" } : { code: null, place: "" };
  }
  const hits = locationHits(text);
  const bad = hits.find((hit) => {
    if (hit.region !== "ASIA" && hit.region !== "AFRICA") return false;
    if (/\bgeorgia\b/i.test(hit.text) && /\b(?:institute|university|tech|college)\b/i.test(text)) return false;
    return true;
  });
  if (bad) return { code: bad.region, place: bad.text };
  const hit = matchLocation(text);
  if (hit && hit.region && hit.region !== "UNKNOWN") {
    const label = (hit.signals || []).find((s) => String(s).startsWith("match:"));
    return { code: hit.region, place: label ? label.slice(6) : regionCountryLabel(hit.region) };
  }
  if (/\.edu\b/i.test(raw)) return { code: "US", place: "United States" };
  return { code: null, place: "" };
}

/** Profile city, including a long location line. readPlace ignores strings over 8 words. */
function platformCityPlace(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const direct = readPlace(raw);
  if (direct) return direct;
  const head = raw.split(/[|·•\n]/)[0].trim();
  const clauses = [head, ...head.split(",").map((part) => part.trim()).filter(Boolean)];
  for (const clause of clauses) {
    const place = readPlace(clause);
    if (place && place.kind !== "unknown") return place;
  }
  const clipped = head.split(/\s+/).slice(0, 8).join(" ");
  return readPlace(clipped) || readPlace(head);
}

function filterPlatformLocation({ platformCity = "", university = "" } = {}) {
  const keep = (code) => code === "US" || code === "CA" || code === "EU" || code === "LATAM";
  const reject = (code) => code === "ASIA" || code === "AFRICA";
  const city = platformCityPlace(platformCity);
  const school = platformSchool(university);
  const schoolCode = school.code;
  const schoolPlace = school.place;

  if (schoolCode && reject(schoolCode)) {
    return packTier("reject", schoolCode, schoolPlace || schoolCode, ["platform-university", `university:${String(university).slice(0, 80)}`], "0%");
  }
  if (city && (city.kind === "specific" || city.kind === "bare") && reject(city.region)) {
    return packTier("reject", city.region, city.text, ["platform-city", `match:${city.text}`], "0%");
  }
  if (city && city.kind === "specific" && keep(city.region)) {
    return packTier("confirmed", city.region, city.text, ["platform-city", schoolCode ? "university" : ""].filter(Boolean), "90%");
  }
  if (city && city.kind === "bare" && keep(city.region) && schoolCode && schoolCode === city.region) {
    return packTier("confirmed", city.region, city.text, ["platform-city", "university-agrees"], "85%");
  }
  // University decides when the city is missing, unrecognized, or a different continent.
  if (schoolCode && keep(schoolCode)) {
    return packTier("confirmed", schoolCode, schoolPlace || regionCountryLabel(schoolCode), ["platform-university"], "80%");
  }
  if (city && city.kind === "bare" && keep(city.region)) {
    return packTier("possible", city.region, city.text, ["platform-bare"], "55%");
  }
  if (city && city.kind === "unknown") {
    return packTier("possible", "UNKNOWN", city.text, ["platform-unknown-city"], "40%");
  }
  return packTier("possible", "UNKNOWN", "Not in email", ["platform-no-city"], "40%");
}

/** @deprecated alias */
function filterWellfoundLocation(opts) {
  return filterPlatformLocation(opts);
}

/** @deprecated use filterApplicantLocation — kept for callers */
function resolveApplicantPlace(opts = {}) {
  return filterApplicantLocation({
    resume: opts.resume || "",
    resumeLoc: "",
    form: opts.location || opts.fallbackLocation || "",
    body: "",
    platformCity: "",
    lookingFor: "",
    phone: opts.phone || "",
    email: opts.email || "",
    preferPlatform: false,
  });
}

module.exports = {
  inferRegion,
  decide,
  classifyPlace,
  classifyCandidate,
  isWeakLocation,
  isJobHub,
  isVagueMetro,
  stripNoise,
  extractPhone,
  phoneRegion,
  enrichKnownCity,
  toCheckMailRegion,
  resolveApplicantPlace,
  filterApplicantLocation,
  matchLocation,
  regionCountryLabel,
  EU,
  LATAM,
  ASIA,
  AFRICA,
};
