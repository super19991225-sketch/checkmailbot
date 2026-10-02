/**
 * Legacy SEA launcher — kept for old MailCheck.exe builds.
 * Prefer: "Mail Check.bat" or `npm run desktop` (Electron window, no browser).
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const appDir = path.dirname(process.execPath);
const root = fs.existsSync(path.join(appDir, "electron", "main.js"))
  ? appDir
  : path.join(__dirname);
const electronExe = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "electron.exe"
);

console.log("Starting Mail Check desktop app...");

if (fs.existsSync(electronExe)) {
  const child = spawn(electronExe, ["."], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

// Fallback: start server only (no browser open)
const serverPath = path.join(root, "server.js");
spawn(process.execPath.includes("MailCheck") ? "node" : process.execPath, [serverPath], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
