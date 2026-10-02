const $ = (sel) => document.querySelector(sel);

const els = {
  accountList: $("#accountList"),
  emptyAccounts: $("#emptyAccounts"),
  formPane: $("#formPane"),
  form: $("#accountForm"),
  formTitle: $("#formTitle"),
  formError: $("#formError"),
  formOk: $("#formOk"),
  accountId: $("#accountId"),
  companyName: $("#companyName"),
  email: $("#email"),
  password: $("#password"),
  passwordHint: $("#passwordHint"),
  provider: $("#provider"),
  providerHint: $("#providerHint"),
  host: $("#host"),
  hostLabel: $("#hostLabel"),
  port: $("#port"),
  portLabel: $("#portLabel"),
  scanLimit: $("#scanLimit"),
  scanLimitLabel: $("#scanLimitLabel"),
  formScanAll: $("#formScanAll"),
  unreadOnly: $("#unreadOnly"),
  saveBtn: $("#saveBtn"),
  testBtn: $("#testBtn"),
  deleteBtn: $("#deleteBtn"),
  newAccountBtn: $("#newAccountBtn"),
  cancelFormBtn: $("#cancelFormBtn"),
  runBtn: $("#runBtn"),
  runUnreadOnly: $("#runUnreadOnly"),
  runTagMail: $("#runTagMail"),
  runMarkRead: $("#runMarkRead"),
  runScanAll: $("#runScanAll"),
  runRecheckAll: $("#runRecheckAll"),
  sheetId: $("#sheetId"),
  googleStatus: $("#googleStatus"),
  googleSetup: $("#googleSetup"),
  googleKey: $("#googleKey"),
  googleSaveBtn: $("#googleSaveBtn"),
  googleRemoveBtn: $("#googleRemoveBtn"),
  googleError: $("#googleError"),
  refreshBtn: $("#refreshBtn"),
  logView: $("#logView"),
  jobStatus: $("#jobStatus"),
  results: $("#results"),
  exportList: $("#exportList"),
};

let accounts = [];
let providers = [];
let selected = new Set();
let editingId = null;
let pollTimer = null;
let lastLogCount = 0;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function currentProvider() {
  return providers.find((p) => p.id === els.provider.value) || null;
}

function syncProviderFields() {
  const p = currentProvider();
  const custom = !p || p.id === "custom";
  if (!custom && p) {
    els.host.value = p.host || "";
    els.port.value = p.port || 993;
    els.host.readOnly = true;
  } else {
    els.host.readOnly = false;
    if (!els.host.value && p?.host) els.host.value = p.host;
    if (!els.port.value) els.port.value = 993;
  }
  els.host.required = custom;
  // Port is automatic (993) — only show for custom IMAP
  if (els.portLabel) els.portLabel.hidden = !custom;
  if (p?.hint) {
    els.providerHint.textContent = p.hint;
    els.providerHint.hidden = false;
  } else {
    els.providerHint.hidden = true;
  }
}

function syncRunEnabled() {
  els.runBtn.disabled = selected.size === 0;
}

function fillProviderSelect(selectedId = "hostinger") {
  els.provider.innerHTML = "";
  providers.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    els.provider.appendChild(opt);
  });
  els.provider.value = selectedId;
  if (!els.provider.value && providers[0]) els.provider.value = providers[0].id;
}

function openForm(account = null) {
  editingId = account?.id || null;
  els.formPane.hidden = false;
  els.formTitle.textContent = account ? "Edit mail" : "Add mail";
  els.accountId.value = account?.id || "";
  els.companyName.value = account?.companyName || "";
  els.email.value = account?.email || "";
  els.password.value = "";
  els.password.required = !account;
  els.passwordHint.hidden = !account;
  fillProviderSelect(account?.provider || "hostinger");
  els.host.value = account?.host || "";
  els.port.value = account?.port || 993;
  const lim = Number(account?.scanLimit);
  const allMail = !Number.isFinite(lim) || lim <= 0;
  if (els.formScanAll) els.formScanAll.checked = allMail;
  els.scanLimit.value = allMail ? 0 : lim;
  syncFormScanAll();
  els.unreadOnly.checked = !!account?.unreadOnly;
  if (els.sheetId) els.sheetId.value = account?.sheetId || "";
  els.deleteBtn.hidden = !account;
  els.formError.hidden = true;
  els.formOk.hidden = true;
  syncProviderFields();
  if (account?.host && account.provider === "custom") {
    els.host.value = account.host;
  }
  els.companyName.focus();
}

function closeForm() {
  editingId = null;
  els.formPane.hidden = true;
  els.form.reset();
  if (els.formScanAll) els.formScanAll.checked = true;
  if (els.scanLimit) {
    els.scanLimit.value = 0;
    els.scanLimit.disabled = false;
  }
  syncFormScanAll();
  els.formError.hidden = true;
  els.formOk.hidden = true;
  els.deleteBtn.hidden = true;
  els.password.required = true;
  els.passwordHint.hidden = true;
  fillProviderSelect("hostinger");
  syncProviderFields();
}

function syncFormScanAll() {
  const all = els.formScanAll ? !!els.formScanAll.checked : true;
  if (els.scanLimit) {
    els.scanLimit.disabled = all;
    if (all) els.scanLimit.value = 0;
  }
  if (els.scanLimitLabel) els.scanLimitLabel.hidden = all;
}

function formPayload() {
  const all = els.formScanAll ? !!els.formScanAll.checked : true;
  const lim = Number(els.scanLimit.value);
  const body = {
    companyName: els.companyName.value.trim(),
    email: els.email.value.trim(),
    provider: els.provider.value,
    host: els.host.value.trim(),
    port: Number(els.port.value || 993),
    scanLimit: all ? 0 : Number.isFinite(lim) && lim > 0 ? lim : 0,
    unreadOnly: els.unreadOnly.checked,
    sheetId: els.sheetId ? els.sheetId.value.trim() : "",
  };
  if (els.password.value) body.password = els.password.value;
  return body;
}

function renderAccounts() {
  els.accountList.innerHTML = "";
  els.emptyAccounts.hidden = accounts.length > 0;

  accounts.forEach((a, i) => {
    const li = document.createElement("li");
    li.style.animationDelay = `${i * 40}ms`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(a.id);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(a.id);
      else selected.delete(a.id);
      syncRunEnabled();
      // If any selected mailbox defaults to unread, tip the Run toggle on
      const anyUnreadDefault = [...selected].some(
        (id) => accounts.find((x) => x.id === id)?.unreadOnly
      );
      if (els.runUnreadOnly && anyUnreadDefault) els.runUnreadOnly.checked = true;
    });

    const meta = document.createElement("div");
    meta.className = "account-meta";
    const pLabel =
      providers.find((p) => p.id === a.provider)?.label || a.provider;
    const lim = Number(a.scanLimit);
    const scanTxt = !Number.isFinite(lim) || lim <= 0 ? "all mail" : `last ${lim}`;
    meta.innerHTML = `<strong>${escapeHtml(a.companyName || a.label || a.email)}</strong><span>${escapeHtml(a.email)} · ${escapeHtml(pLabel)}${a.unreadOnly ? " · unread default" : ""} · ${scanTxt}${a.sheetId ? " · Google Sheet" : ""}</span>`;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn text edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(a));

    li.append(check, meta, edit);
    els.accountList.appendChild(li);
  });

  selected = new Set([...selected].filter((id) => accounts.some((a) => a.id === id)));
  syncRunEnabled();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadProviders() {
  const data = await api("/api/providers");
  providers = data.providers || [];
  fillProviderSelect("hostinger");
  syncProviderFields();
}

async function loadAccounts() {
  const data = await api("/api/accounts");
  accounts = data.accounts || [];
  renderAccounts();
}

async function loadExports() {
  const data = await api("/api/exports");
  els.exportList.innerHTML = "";
  (data.files || []).forEach((f) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = f.url;
    a.textContent = f.name;
    a.download = f.name;
    const time = document.createElement("time");
    time.textContent = new Date(f.mtime).toLocaleString();
    li.append(a, time);
    els.exportList.appendChild(li);
  });
}

function setJobStatus(status) {
  els.jobStatus.textContent = status || "Idle";
  els.jobStatus.className = "status-pill";
  if (status === "running") els.jobStatus.classList.add("running");
  if (status === "error") els.jobStatus.classList.add("error");
}

function renderJob(job) {
  if (!job) return;
  setJobStatus(job.status || "idle");
  const lines = (job.logs || []).map((l) => l.message).filter(Boolean);
  if (lines.length) {
    els.logView.textContent = lines.join("\n");
    if ((job.logs || []).length !== lastLogCount) {
      els.logView.scrollTop = els.logView.scrollHeight;
      lastLogCount = job.logs.length;
    }
  }

  els.results.innerHTML = "";
  (job.results || []).forEach((r) => {
    if (!r.downloadUrl && !r.fileName) return;
    const a = document.createElement("a");
    a.className = "result-link";
    a.href = r.downloadUrl || `/api/exports/${encodeURIComponent(r.fileName)}`;
    a.download = r.fileName || "export.xlsx";
    const secs = r.elapsedMs ? ` · ${(r.elapsedMs / 1000).toFixed(1)}s` : "";
    a.innerHTML = `${escapeHtml(r.fileName || "Download")} <small>new ${r.newKeeps || 0} · A ${r.counts?.American || 0} · C ${r.counts?.Canada || 0} · E ${r.counts?.European || 0} · L ${r.counts?.Latina || 0}${secs}</small>`;
    els.results.appendChild(a);
    if (r.sheet?.url) {
      const g = document.createElement("a");
      g.className = "result-link";
      g.href = r.sheet.url;
      g.target = "_blank";
      g.rel = "noopener";
      g.textContent = `Open Google Sheet — ${r.companyName || r.email}`;
      els.results.appendChild(g);
    }
  });

  if (job.status === "running") {
    els.runBtn.disabled = true;
    els.runBtn.textContent = "Scanning…";
  } else {
    els.runBtn.textContent = "Run selected";
    syncRunEnabled();
    if (job.status === "done") loadExports();
  }
}

async function pollJob() {
  try {
    const data = await api("/api/scan");
    renderJob(data.job);
    if (data.job?.status === "running") {
      pollTimer = setTimeout(pollJob, 1000);
    } else {
      pollTimer = null;
    }
  } catch {
    pollTimer = setTimeout(pollJob, 2000);
  }
}

els.provider.addEventListener("change", syncProviderFields);
if (els.formScanAll) {
  els.formScanAll.addEventListener("change", syncFormScanAll);
}

els.newAccountBtn.addEventListener("click", () => openForm());
els.cancelFormBtn.addEventListener("click", closeForm);

els.testBtn.addEventListener("click", async () => {
  els.formError.hidden = true;
  els.formOk.hidden = true;
  const body = formPayload();
  if (editingId) body.id = editingId;
  if (!body.email) {
    els.formError.textContent = "Email is required";
    els.formError.hidden = false;
    return;
  }
  if (!body.password && !editingId) {
    els.formError.textContent = "Password is required to check login";
    els.formError.hidden = false;
    return;
  }
  if (body.provider === "custom" && !body.host) {
    els.formError.textContent = "IMAP host is required for custom provider";
    els.formError.hidden = false;
    return;
  }
  els.testBtn.disabled = true;
  els.testBtn.textContent = "Checking…";
  try {
    const result = await api("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    els.formOk.textContent = `Login OK · ${result.messages} messages · ${result.unseen} unread · ${result.host}:${result.port}`;
    els.formOk.hidden = false;
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  } finally {
    els.testBtn.disabled = false;
    els.testBtn.textContent = "Check login";
  }
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.formError.hidden = true;
  els.formOk.hidden = true;
  const body = formPayload();

  try {
    if (editingId) {
      if (!body.password) delete body.password;
      await api(`/api/accounts/${editingId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } else {
      if (!body.password) throw new Error("Password is required");
      const created = await api("/api/accounts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (created.account?.id) selected.add(created.account.id);
    }
    closeForm();
    await loadAccounts();
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  }
});

els.deleteBtn.addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Delete this mailbox from Mail Check?")) return;
  try {
    await api(`/api/accounts/${editingId}`, { method: "DELETE" });
    selected.delete(editingId);
    closeForm();
    await loadAccounts();
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  }
});

els.runBtn.addEventListener("click", async () => {
  if (!selected.size) return;
  const unreadOnly = !!els.runUnreadOnly?.checked;
  const tagThunderbird = els.runTagMail ? !!els.runTagMail.checked : true;
  const markAsRead = els.runMarkRead ? !!els.runMarkRead.checked : true;
  const scanAll = els.runScanAll ? !!els.runScanAll.checked : true;
  const recheckAll = !!els.runRecheckAll?.checked;
  els.logView.textContent = unreadOnly
    ? "Starting unread-only scan…"
    : scanAll
      ? "Starting full-inbox scan…"
      : "Starting scan (last N per mailbox)…";
  lastLogCount = 0;
  els.results.innerHTML = "";
  try {
    const data = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({
        accountIds: [...selected],
        unreadOnly,
        tagThunderbird,
        markAsRead: unreadOnly ? true : markAsRead,
        scanAll,
        scanLimit: scanAll ? 0 : undefined,
        recheckAll,
      }),
    });
    renderJob(data.job);
    if (!pollTimer) pollJob();
  } catch (err) {
    els.logView.textContent = err.message;
    setJobStatus("error");
    syncRunEnabled();
  }
});

function renderGoogle(status) {
  if (!els.googleStatus) return;
  if (status?.configured) {
    els.googleStatus.innerHTML = `Connected as <code>${escapeHtml(status.clientEmail)}</code> — share each sheet with this email as Editor, then add the sheet URL on the mailbox.`;
  } else {
    els.googleStatus.textContent =
      "Not set up. Add a service account key below to write results to Google Sheets.";
    if (els.googleSetup) els.googleSetup.open = true;
  }
}

async function loadGoogle() {
  try {
    renderGoogle(await api("/api/google"));
  } catch (err) {
    els.googleStatus.textContent = err.message;
  }
}

els.googleSaveBtn?.addEventListener("click", async () => {
  els.googleError.hidden = true;
  try {
    const status = await api("/api/google", {
      method: "POST",
      body: JSON.stringify({ key: els.googleKey.value }),
    });
    els.googleKey.value = "";
    els.googleSetup.open = false;
    renderGoogle(status);
  } catch (err) {
    els.googleError.textContent = err.message;
    els.googleError.hidden = false;
  }
});

els.googleRemoveBtn?.addEventListener("click", async () => {
  if (!confirm("Remove the Google service account key?")) return;
  renderGoogle(await api("/api/google", { method: "DELETE" }));
});

els.refreshBtn.addEventListener("click", async () => {
  await Promise.all([loadProviders(), loadAccounts(), loadExports(), loadGoogle(), pollJob()]);
});

(async function init() {
  await loadProviders();
  await loadAccounts();
  await loadExports();
  await loadGoogle();
  await pollJob();
})();
