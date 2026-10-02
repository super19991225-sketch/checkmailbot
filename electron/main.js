const path = require("path");
const http = require("http");
const { app, BrowserWindow, Menu, shell } = require("electron");

const PORT = Number(process.env.UI_PORT || 3855);
const ROOT = path.join(__dirname, "..");

// Avoid GPU/renderer crashes on some Windows setups
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

// Start Express in-process (same server as npm run ui)
process.chdir(ROOT);
require(path.join(ROOT, "server.js"));

function waitForServer(url, triesLeft, cb) {
  if (triesLeft <= 0) {
    console.error("Mail Check server did not start.");
    app.quit();
    return;
  }
  http
    .get(url, (res) => {
      res.resume();
      cb();
    })
    .on("error", () =>
      setTimeout(() => waitForServer(url, triesLeft - 1, cb), 200)
    );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Mail Check",
    backgroundColor: "#1a1612",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open external browser for app URLs
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "deny" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });

  app.whenReady().then(() => {
    waitForServer(`http://127.0.0.1:${PORT}/`, 50, createWindow);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
