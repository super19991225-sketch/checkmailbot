# Mail Check

Recruiting inbox checker for several job sites. It reads each mailbox over IMAP, keeps candidates in the US, Canada, the EU, and Latin America, writes Excel, and records the result as tags.

## What it checks

Job-site and forwarded applicant mail:

Wellfound, Hubstaff, Sulekha, CazVid, GoHire, Indeed, ZipRecruiter, Glassdoor, LinkedIn Easy Apply, Workable, Lever, Greenhouse, Dice, Idealist, Zorqiva Careers, Tek4Real, and GeniusXLab forms.

Location for those messages uses the **profile city** and the **university** on the job-site mail. Resume text and LinkedIn are not used for that location. Asia and Africa are rejected.

Direct email still uses the resume header and the message itself.

## Excel

`exports/{Mailbox} - YYYY-MM-DD.xlsx`

| Sheet | Who is on it |
| --- | --- |
| American | Confirmed US, including Wellfound and other job sites |
| Canada | Confirmed Canada |
| European | Confirmed EU |
| Latina | Confirmed Latin America |
| Possible | Real applicants whose home city is only a continent, or is missing |
| Summary | Counts |

There is no separate Wellfound sheet. The **Job site** cell names the platform. Wellfound cells are gold.

## Tags on any mail app

Each kept message gets:

- A star (`\Flagged`) and, when enabled, marked read (`\Seen`)
- A Thunderbird color: US red (`$label1`), Canada/EU/Latina yellow (`$label2`), possible third tag (`$label3`)
- A copy in an IMAP folder: `Mail Check/American`, `Mail Check/Canada`, `Mail Check/European`, `Mail Check/Latina`, or `Mail Check/Possible`

Thunderbird and Betterbird show the colors. Outlook, Apple Mail, and webmail show the star, the read state, and the **Mail Check** folders. The Excel file is the full list either way.

Checked messages are remembered in `data/records/` so the next run only opens new mail.

## Run

```bash
npm install
npm run desktop
```

Or double-click `Mail Check.bat`.

```bash
npm run ui          # http://127.0.0.1:3855
npm run test:filter
node scripts/run-scan.js
```

Keep **Entire inbox**, **Tag mail**, and **Mark as read** checked.

If Thunderbird still shows old unread mail or no colors: right-click Inbox → Properties → Repair Folder, then turn on the Tags column.

## Layout

```
index.js            scanner, Excel, tags, Mail Check folders
lib/regions.js      location filter
lib/parsers.js      job-site and forwarded mail
lib/accounts.js     mailboxes (local)
server.js           local API
public/             window UI
electron/main.js    desktop window
```

## Before you share the project

`data/` is gitignored. It holds mailbox passwords (`data/accounts.json`) and candidate records. Do not upload that folder.
