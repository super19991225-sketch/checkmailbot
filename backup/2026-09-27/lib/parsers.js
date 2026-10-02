function fieldValue(body, label) {
  const match = body.match(new RegExp(`${label}\\s*[:\\-]\\s*(.+?)(?:\\n|$)`, "i"));
  return match ? match[1].trim() : null;
}

function detectEmailType(subject, body, sender) {
  const subjectLower = String(subject || "")
    .replace(/^((?:fwd?|fw|re)\s*:\s*)+/i, "")
    .toLowerCase();
  const bodyLower = String(body || "").toLowerCase();
  const senderLower = String(sender || "").toLowerCase();
  // Wellfound is PRIMARY — check first
  if (
    subjectLower.includes("is interested in") ||
    /wellfound|angel\.co|angellist|talent@wellfound/.test(
      senderLower + " " + bodyLower + " " + subjectLower
    )
  ) {
    return "wellfound";
  }
  if (subjectLower.includes("application —") || bodyLower.includes("tek4real"))
    return "tek4real";
  if (subjectLower.includes("applied to zorqiva") || bodyLower.includes("zorqiva"))
    return "zorqiva";
  if (subjectLower.includes("job application") && bodyLower.includes("position:"))
    return "tek4real";
  if (/(noreply|jobs|applications|gohire|barefoot)/.test(senderLower))
    return "platform";
  return "direct";
}

function parseWellfound(subject, body) {
  const subj = String(subject || "").replace(/^((?:fwd?|fw|re)\s*:\s*)+/i, "").trim();
  const nameMatch = subj.match(/^(.+?)\s+is interested in\s+/i);
  const skipMail =
    /talent@wellfound|@wellfound\.com|noreply|no-reply|angel\.co/i;
  const emailMatches = String(body || "").match(
    /[\w.+-]+@[\w-]+\.[\w.-]+/g
  );
  const email =
    (emailMatches || []).find((e) => !skipMail.test(e)) || null;
  const linkedinMatch = body.match(
    /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w\-_/]+/i
  );
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const name = nameMatch ? nameMatch[1].trim() : "";

  let location_text = null;
  if (name) {
    const idx = lines.findIndex((l) => {
      const a = l.toLowerCase().replace(/\./g, "");
      const b = name.toLowerCase().replace(/\./g, "");
      if (a === b) return true;
      const pa = a.split(/\s+/);
      const pb = b.split(/\s+/);
      return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
    });
    if (idx >= 0) {
      for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i++) {
        const line = lines[i];
        if (/linkedin|github|http|@|interested|message|experience|accept|reject/i.test(line))
          continue;
        if (line === "·" || line === "•") continue;
        if (
          /^[A-Za-z .'-]{2,40}(?:,\s*[A-Za-z .'-]{2,40})?$/.test(line) &&
          line.length < 50
        ) {
          location_text = line;
          break;
        }
      }
    }
  }

  // School / university lines under "School"
  let university = null;
  const schoolAt = lines.findIndex((l) => /^school$/i.test(l));
  if (schoolAt >= 0) {
    for (let i = schoolAt + 1; i < Math.min(schoolAt + 12, lines.length); i++) {
      if (/^work$|^skills$|^looking for$/i.test(lines[i])) break;
      if (/^[—\-–]$/.test(lines[i])) continue;
      if (
        /university|college|institute|campus/i.test(lines[i]) &&
        lines[i].length > 3 &&
        lines[i].length < 120
      ) {
        university = lines[i];
        break;
      }
    }
  }

  // Looking for … in City
  let looking_for = null;
  const lookAt = lines.findIndex((l) => /^looking for$/i.test(l));
  if (lookAt >= 0) {
    for (let i = lookAt + 1; i < Math.min(lookAt + 12, lines.length); i++) {
      if (/^in$/i.test(lines[i]) && lines[i + 1]) {
        looking_for = lines[i + 1].replace(/\.+$/, "").trim();
        break;
      }
    }
  }

  const phoneMatch = String(body || "").match(/\+?\d[\d\s().-]{8,}\d/);

  // Never promote looking-for hubs ("US Based", Remote) as the profile city
  const hubLooking =
    looking_for &&
    /^(us[\s\-]?based|u\.s\.?[\s\-]?based|united states[\s\-]?based|remote|flexible|anywhere|worldwide)/i.test(
      looking_for
    );
  const safeLooking = hubLooking ? null : looking_for;

  return {
    applicant_name: name || null,
    applicant_email: email,
    location_text: location_text || safeLooking || null,
    linkedin_url: linkedinMatch ? linkedinMatch[0] : null,
    university: university || null,
    phone: phoneMatch ? phoneMatch[0] : null,
    looking_for: looking_for || null,
  };
}

function parseTek4real(subject, body) {
  const fromSubject = subject.match(/Application\s+[—\-]\s+.+?\s+[—\-]\s+(.+)$/i);
  return {
    applicant_name: fieldValue(body, "APPLICANT") || (fromSubject ? fromSubject[1].trim() : null),
    applicant_email: fieldValue(body, "EMAIL"),
    location_text: fieldValue(body, "LOCATION"),
    linkedin_url: fieldValue(body, "LINKEDIN"),
  };
}

function parseZorqiva(body) {
  const nameMatch = body.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s*\n/m);
  const locationMatch = body.match(/([A-Za-z .'-]+)\s·\s(?:Software Engineer|Developer|Engineer)/);
  const emailMatch = body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const schoolMatch = body.match(/University Of ([A-Za-z ]+)/i);

  let location_text = locationMatch ? locationMatch[1].trim() : null;
  if (schoolMatch) {
    location_text = location_text ? `${location_text}; ${schoolMatch[0]}` : schoolMatch[0];
  }

  return {
    applicant_name: nameMatch ? nameMatch[1].trim() : null,
    applicant_email: emailMatch ? emailMatch[0] : null,
    location_text,
    linkedin_url: null,
  };
}

function parseDirect(body) {
  const linkedinMatch = body.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w\-_/]+/i);
  const emailMatch = body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const locationMatch = body.match(/(?:based in|located in|live in|living in|from)\s+([A-Za-z .,'-]{2,60})/i);
  return {
    applicant_name: null,
    applicant_email: emailMatch ? emailMatch[0] : null,
    location_text: locationMatch ? locationMatch[1].trim() : null,
    linkedin_url: linkedinMatch ? linkedinMatch[0] : null,
  };
}

function parsePlatform(subject, body) {
  const gohire = subject.match(/:\s*(.+?)\s+applied for/i);
  let applicant_name = gohire ? gohire[1].trim() : null;
  if (!applicant_name) {
    const fromName = (body.match(/From:\s*(.+)/i) || [])[1]?.trim();
    if (fromName && !/gohire|barefoot|linkedin/i.test(fromName)) applicant_name = fromName;
  }

  let applicant_email = "";
  const contact = body.match(/Contact:\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
  if (contact) applicant_email = contact[1];
  else {
    applicant_email =
      (body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).find((email) => !/gohire|barefoot|linkedin|noreply/i.test(email)) ||
      "";
  }

  const linkedinMatch = body.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w\-_/]+/i);
  return {
    applicant_name,
    applicant_email,
    location_text: null,
    linkedin_url: linkedinMatch ? linkedinMatch[0] : null,
  };
}

async function extractPdfText(attachment) {
  if (!attachment?.content) return "";
  try {
    const { PDFParse } = require("pdf-parse");
    const bytes =
      attachment.content instanceof Uint8Array
        ? attachment.content
        : new Uint8Array(attachment.content);
    const parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    return result?.text || "";
  } catch {
    return "";
  }
}

function isPdfAttachment(item) {
  const fname = (item.filename || "").toLowerCase();
  const ctype = (item.contentType || "").toLowerCase();
  return fname.endsWith(".pdf") || ctype.includes("pdf");
}

function resumeAttachmentScore(item) {
  const fname = (item.filename || "").toLowerCase();
  let score = 0;
  if (/resume|cv|curriculum|vitae|biodata/.test(fname)) score += 10;
  if (/harshvardhan|candidate|applicant|profile/.test(fname)) score += 3;
  if (/image|photo|logo|signature|cid:/.test(fname)) score -= 20;
  if (isPdfAttachment(item)) score += 2;
  return score;
}

/** Prefer CV/resume-named PDFs; skip images; try several until we get real text */
async function extractBestResumeText(attachments = []) {
  const pdfs = (attachments || [])
    .filter(isPdfAttachment)
    .map((item) => ({ item, score: resumeAttachmentScore(item) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  let best = "";
  let bestName = null;
  for (const { item } of pdfs.slice(0, 5)) {
    const text = await extractPdfText(item);
    if (!text || text.trim().length < 40) continue;
    // Prefer longer / clearer header text
    if (text.length > best.length) {
      best = text;
      bestName = item.filename || null;
    }
    // Strong enough — stop early
    if (
      text.length > 400 &&
      /(?:location|based in|address|india|pakistan|united states|@)/i.test(
        text.slice(0, 800)
      )
    ) {
      return { resume_text: text, resume_filename: item.filename || null };
    }
  }
  // Fallback: plain-text attachments
  if (!best) {
    for (const item of attachments || []) {
      const fname = (item.filename || "").toLowerCase();
      const ctype = (item.contentType || "").toLowerCase();
      if (fname.endsWith(".txt") || ctype.includes("text/plain")) {
        const text = item.content?.toString?.("utf8")?.slice(0, 80000) || "";
        if (text.trim().length > 40) {
          return { resume_text: text, resume_filename: item.filename || null };
        }
      }
    }
  }
  return { resume_text: best, resume_filename: bestName };
}

async function parseCandidate(parsedMail, accountName) {
  const subject = parsedMail.subject || "";
  const sender = parsedMail.from?.text || "";
  const body = parsedMail.text || parsedMail.html || "";
  const email_type = detectEmailType(subject, body, sender);

  let fields;
  if (email_type === "tek4real") fields = parseTek4real(subject, body);
  else if (email_type === "zorqiva") fields = parseZorqiva(body);
  else if (email_type === "wellfound") fields = parseWellfound(subject, body);
  else if (email_type === "platform") fields = parsePlatform(subject, body);
  else fields = parseDirect(body);

  const { resume_text, resume_filename } = await extractBestResumeText(
    parsedMail.attachments || []
  );
  const location_field = fields.location_text || "";
  // Resume header first in location_text so classifiers see it before form noise
  const location_text = [resume_text.slice(0, 4000), location_field]
    .filter(Boolean)
    .join("\n");
  const links = extractLinks(`${body}\n${resume_text}\n${fields.linkedin_url || ""}`);

  return {
    account_name: accountName,
    message_id: parsedMail.messageId || "",
    subject,
    sender,
    email_type,
    applicant_name: fields.applicant_name,
    applicant_email: fields.applicant_email,
    role: extractRole(subject, body),
    phone: fields.phone || extractPhone(`${resume_text}\n${body}`),
    location_field,
    location_text,
    university: fields.university || null,
    looking_for: fields.looking_for || null,
    linkedin_url: fields.linkedin_url || links.linkedin,
    github_url: links.github,
    portfolio_url: links.portfolio,
    resume_filename,
    resume_text,
    raw_body: String(body).slice(0, 4000),
  };
}

function extractRole(subject, body) {
  const application = subject.match(/Application\s+[—\-]\s+(.+?)\s+[—\-]\s+/i);
  if (application) return application[1].trim();
  const applied = subject.match(/applied for\s+(.+?)(?:\s+on\b|\s+at\b|$)/i);
  if (applied) return applied[1].trim();
  const position = fieldValue(body, "POSITION") || fieldValue(body, "ROLE");
  return position || "";
}

function extractPhone(text) {
  const match = String(text).match(/\+?\d[\d\s().-]{8,}\d/g) || [];
  return (
    match.find((item) => {
      const digits = item.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15;
    }) || ""
  );
}

function extractLinks(text) {
  const source = String(text || "");
  const linkedin = (source.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)>\]]+/i) || [])[0] || "";
  const github = (source.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)>\]]+/i) || [])[0] || "";
  const portfolio =
    (source.match(/https?:\/\/[^\s)>\]]+/gi) || []).find(
      (url) => !/linkedin\.com|github\.com|gohire|google\.com|mailto:|hostinger|barefoot/i.test(url)
    ) || "";
  return {
    linkedin: linkedin.replace(/[.,;]+$/, ""),
    github: github.replace(/[.,;]+$/, ""),
    portfolio: portfolio.replace(/[.,;]+$/, ""),
  };
}

module.exports = { parseCandidate, extractBestResumeText };
