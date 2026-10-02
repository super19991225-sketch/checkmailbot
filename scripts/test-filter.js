/**
 * Golden regression tests for mail check location filter.
 * Run: node scripts/test-filter.js
 */
const {
  filterApplicantLocation,
  isJobHub,
} = require("../lib/regions");

let failed = 0;
function expect(label, cond, detail = "") {
  if (cond) {
    console.log(`  OK  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function check(name, input, want) {
  const r = filterApplicantLocation(input);
  const ok =
    r.action === want.action &&
    r.region === want.region &&
    (!want.tier || r.tier === want.tier) &&
    (!want.location ||
      String(r.location).toLowerCase().includes(String(want.location).toLowerCase()));
  expect(
    name,
    ok,
    `got ${r.tier || "-"}/${r.action}/${r.region}/${r.location} (want ${want.tier || "*"}/${want.action}/${want.region}/${want.location || "*"})`
  );
}

console.log("Hubs");
expect("US Based is hub", isJobHub("US Based"));
expect("U.S. Based is hub", isJobHub("U.S. Based"));
expect("Remote is hub", isJobHub("Remote"));
expect("Europe is NOT hub", !isJobHub("Europe"));
expect("Fremont is NOT hub", !isJobHub("Fremont"));

console.log("\nScreenshot / Wellfound profile cities (preferPlatform)");
check(
  "Omotayo Europe",
  { platformCity: "Europe", lookingFor: "US Based", preferPlatform: true },
  { action: "accept", region: "EU", location: "Europe", tier: "possible" }
);
check(
  "Maitri Fremont",
  { platformCity: "Fremont", lookingFor: "US Based", preferPlatform: true },
  { action: "accept", region: "American", location: "Fremont", tier: "confirmed" }
);
check(
  "Hamir Bay Area",
  {
    platformCity: "San Francisco Bay Area",
    lookingFor: "Remote",
    preferPlatform: true,
  },
  { action: "accept", region: "American", location: "Bay Area" }
);
check(
  "John F Kenny Washington DC",
  {
    platformCity: "Washington DC",
    lookingFor: "US Based",
    preferPlatform: true,
  },
  { action: "accept", region: "American", location: "Washington" }
);
check(
  "Jesús Monterrey",
  {
    platformCity: "Monterrey",
    lookingFor: "US Based",
    preferPlatform: true,
  },
  { action: "accept", region: "Latin American", location: "Monterrey" }
);

console.log("\nProfile city beats resume client noise");
check(
  "WF Europe over India resume body",
  {
    platformCity: "Europe",
    resume:
      "Software Engineer\n\nBuilt products for clients across India and Asia. Worked with teams in Bangalore.",
    preferPlatform: true,
  },
  { action: "accept", region: "EU", location: "Europe", tier: "possible" }
);
check(
  "WF Fremont over Mumbai looking-for dump",
  {
    platformCity: "Fremont",
    lookingFor: "US Based",
    form: "US Based",
    body: "US Based",
    preferPlatform: true,
  },
  { action: "accept", region: "American", location: "Fremont", tier: "confirmed" }
);

console.log("\nContinent-only profile label defers to university / phone");
check(
  "European + Kenyatta University → reject",
  {
    platformCity: "European",
    university: "Kenyatta University",
    preferPlatform: true,
  },
  { action: "reject", region: "African" }
);
check(
  "Europe + Indian phone → reject",
  { platformCity: "Europe", phone: "+91 98765 43210", preferPlatform: true },
  { action: "reject", region: "Asian" }
);
check(
  "Europe with no other evidence → keep EU",
  { platformCity: "Europe", preferPlatform: true },
  { action: "accept", region: "EU", location: "Europe", tier: "possible" }
);

console.log("\nReject Asia / Africa");
check(
  "Delhi reject",
  { platformCity: "Delhi", preferPlatform: true },
  { action: "reject", region: "Asian", location: "Delhi" }
);
check(
  "Lagos reject",
  { platformCity: "Lagos", preferPlatform: true },
  { action: "reject", region: "African", location: "Lagos" }
);

console.log("\nWeak signals stay possible, real cities stay confirmed");
check(
  "Only US Based → possible American",
  { lookingFor: "US Based", form: "US Based" },
  { action: "accept", region: "American", tier: "possible" }
);
check(
  "Austin is a real city",
  { platformCity: "Austin" },
  { action: "accept", region: "American", location: "Austin", tier: "confirmed" }
);
check(
  "Brooklyn is a real city",
  { platformCity: "Brooklyn" },
  { action: "accept", region: "American", location: "Brooklyn", tier: "confirmed" }
);
check(
  "Phone only is possible",
  { phone: "+1 415 555 1212" },
  { action: "accept", region: "American", tier: "possible" }
);
check(
  ".edu only is possible",
  { email: "student@mit.edu" },
  { action: "accept", region: "American", tier: "possible" }
);

console.log("\nCanada / US keeps");
check(
  "Toronto",
  { platformCity: "Toronto", preferPlatform: true },
  { action: "accept", region: "Canada", location: "Toronto" }
);
check(
  "Houston",
  { platformCity: "Houston", preferPlatform: true },
  { action: "accept", region: "American", location: "Houston" }
);

console.log("\nWellfound: profile city + university only");
check(
  "WF Europe + Kenyatta reject",
  { wellfound: true, platformCity: "Europe", university: "Kenyatta University", phone: "+1 415 555 1212", resumeLoc: "Fremont" },
  { action: "reject", region: "African" }
);
check(
  "WF Fremont + IIT Delhi reject",
  { wellfound: true, platformCity: "Fremont", university: "Indian Institute of Technology Delhi" },
  { action: "reject", region: "Asian" }
);
check(
  "WF Europe + Lisbon university confirmed",
  { wellfound: true, platformCity: "Europe", university: "University of Lisbon" },
  { action: "accept", region: "EU", location: "Europe", tier: "confirmed" }
);
check(
  "WF university .edu only confirmed American",
  { wellfound: true, university: "Stanford University stanford.edu" },
  { action: "accept", region: "American", tier: "confirmed" }
);
check(
  "WF Europe + US university confirms from the school",
  { wellfound: true, platformCity: "Europe", university: "Stanford University stanford.edu" },
  { action: "accept", region: "American", tier: "confirmed" }
);
check(
  "WF long Bay Area line is still a city",
  { platform: true, platformCity: "San Francisco Bay Area, California, United States, open to hybrid" },
  { action: "accept", region: "American", location: "Bay Area", tier: "confirmed" }
);
check(
  "WF Europe only stays possible",
  { wellfound: true, platformCity: "Europe", lookingFor: "US Based", phone: "+91 98765 43210", resumeLoc: "Mumbai" },
  { action: "accept", region: "EU", location: "Europe", tier: "possible" }
);
check(
  "WF Fremont ignores resume Mumbai",
  { wellfound: true, platformCity: "Fremont", resumeLoc: "Mumbai", lookingFor: "Remote" },
  { action: "accept", region: "American", location: "Fremont", tier: "confirmed" }
);
check(
  "WF Lagos reject",
  { wellfound: true, platformCity: "Lagos" },
  { action: "reject", region: "African" }
);
check(
  "WF no city and no school stays possible",
  { wellfound: true },
  { action: "accept", region: "Unknown", tier: "possible" }
);

console.log("\nJob-site platforms share the same location rule");
check(
  "Hubstaff Austin confirmed",
  { platform: true, platformCity: "Austin, TX", resumeLoc: "Mumbai" },
  { action: "accept", region: "American", location: "Austin", tier: "confirmed" }
);
check(
  "GoHire Europe + Kenyatta reject",
  { platform: true, platformCity: "Europe", university: "Kenyatta University" },
  { action: "reject", region: "African" }
);
check(
  "Sulekha Delhi reject",
  { platform: true, platformCity: "Delhi" },
  { action: "reject", region: "Asian" }
);
check(
  "Forwarded form Monterrey confirmed",
  { platform: true, platformCity: "Monterrey", university: "" },
  { action: "accept", region: "Latin American", location: "Monterrey", tier: "confirmed" }
);

console.log(
  failed ? `\n${failed} FAILED` : "\nAll filter checks passed."
);
process.exit(failed ? 1 : 0);
