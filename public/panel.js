const state = {
  bootstrap: null,
  currentKeyId: "",
  usersRefreshTimer: null
};

const elements = {
  loginCard: document.getElementById("login-card"),
  appShell: document.getElementById("app-shell"),
  loginForm: document.getElementById("login-form"),
  adminKeyInput: document.getElementById("admin-key-input"),
  logoutButton: document.getElementById("logout-button"),
  sessionLabel: document.getElementById("session-label"),
  heroSessionDisplay: document.getElementById("hero-session-display"),
  statsGrid: document.getElementById("stats-grid"),
  generateForm: document.getElementById("generate-form"),
  generateAmount: document.getElementById("generate-amount"),
  generateDuration: document.getElementById("generate-duration"),
  generateShared: document.getElementById("generate-shared"),
  generateAdmin: document.getElementById("generate-admin"),
  generateMaxUses: document.getElementById("generate-max-uses"),
  generateOutput: document.getElementById("generate-output"),
  keyInfoForm: document.getElementById("key-info-form"),
  keyInput: document.getElementById("key-input"),
  keyInfoOutput: document.getElementById("key-info-output"),
  compensateDays: document.getElementById("compensate-days"),
  recentKeysGrid: document.getElementById("recent-keys-grid"),
  usersGrid: document.getElementById("users-grid"),
  refreshUsers: document.getElementById("refresh-users"),
  deleteAllKeys: document.getElementById("delete-all-keys"),
  serviceActions: document.getElementById("service-actions"),
  serviceOutput: document.getElementById("service-output"),
  toast: document.getElementById("toast")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin"
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed with ${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setLoggedIn(isLoggedIn) {
  elements.loginCard.classList.toggle("hidden", isLoggedIn);
  elements.appShell.classList.toggle("hidden", !isLoggedIn);
  elements.logoutButton.classList.toggle("hidden", !isLoggedIn);

  if (isLoggedIn) {
    startUsersAutoRefresh();
  } else {
    stopUsersAutoRefresh();
  }
}

function stopUsersAutoRefresh() {
  if (state.usersRefreshTimer) {
    clearInterval(state.usersRefreshTimer);
    state.usersRefreshTimer = null;
  }
}

function startUsersAutoRefresh() {
  stopUsersAutoRefresh();
  state.usersRefreshTimer = setInterval(() => {
    void loadUsers(false);
  }, 20000);
}

function showToast(message, isError = false) {
  elements.toast.textContent = String(message || "");
  elements.toast.className = `toast ${isError ? "error" : "success"} visible`;
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 3400);
}

function formatDate(value) {
  if (!value) {
    return "Lifetime";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? escapeHtml(String(value))
    : parsed.toLocaleString();
}

function formatLastSeen(value) {
  if (!value) {
    return "Never";
  }
  const deltaMs = Date.now() - Number(value);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "Just now";
  }
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusPill(label, tone = "") {
  return `<span class="flag-pill ${tone}">${escapeHtml(label)}</span>`;
}

function renderEmptyState(title, subtitle) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(subtitle)}</span>
    </div>
  `;
}

function renderStats(stats) {
  const entries = [
    ["Total Keys", stats.totalKeys, "All generated licenses in the system"],
    ["Single Keys", stats.singleKeys, "Bound to one HWID at a time"],
    ["Shared Keys", stats.sharedKeys, "Event-style keys with multi-use support"],
    ["Admin Keys", stats.adminKeys, "Full control access licenses"],
    ["Live Sessions", stats.liveSessions, "Currently active authenticated sessions"],
    ["Shared Activations", stats.sharedActivations, "Tracked shared-key HWID slots"]
  ];

  elements.statsGrid.innerHTML = entries.map(([label, value, meta]) => `
    <article class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-meta">${escapeHtml(meta)}</div>
    </article>
  `).join("");
}

function renderGenerateResult(generated) {
  if (!generated || !generated.keys?.length) {
    elements.generateOutput.classList.add("empty");
    elements.generateOutput.innerHTML = renderEmptyState(
      "No keys generated yet.",
      "The forge output will appear here with formatted results."
    );
    return;
  }

  const modeLabel = generated.isAdmin
    ? "Admin issue"
    : generated.shared
      ? "Shared event issue"
      : "Single-device issue";
  const outputHtml = `
    <div class="result-stack">
      <div class="result-header">
        <div>
          <strong>${escapeHtml(generated.keys.length)} key(s) minted</strong>
          <div class="result-meta">${escapeHtml(modeLabel)}</div>
        </div>
        <div class="metric-chip-row">
          <span class="metric-chip"><span>Duration</span><code>${escapeHtml(generated.duration)}</code></span>
          <span class="metric-chip"><span>Expires</span><code>${escapeHtml(formatDate(generated.expiresAt))}</code></span>
          <span class="metric-chip"><span>Max Uses</span><code>${escapeHtml(generated.shared ? (generated.maxUses || "Unlimited") : "1")}</code></span>
        </div>
      </div>
      <div class="key-pill-row">
        ${generated.keys.map((key) => `<span class="key-output-pill"><code>${escapeHtml(key)}</code></span>`).join("")}
      </div>
    </div>
  `;
  elements.generateOutput.classList.remove("empty");
  elements.generateOutput.innerHTML = outputHtml;
}

function renderRecentKeys(keys) {
  if (!keys.length) {
    elements.recentKeysGrid.innerHTML = renderEmptyState("No keys found.", "Generate one to start filling the board.");
    return;
  }

  elements.recentKeysGrid.innerHTML = keys.map((key) => {
    const statuses = [
      key.isAdmin ? statusPill("Admin", "accent") : statusPill(key.shared ? "Shared" : "Single"),
      key.paused ? statusPill("Paused", "alert") : statusPill("Active", "accent"),
      key.blacklisted ? statusPill("Blacklisted", "alert") : ""
    ].join("");

    return `
      <article class="key-tile" data-key="${escapeHtml(key.keyId)}">
        <div class="tile-top">
          <div>
            <div class="tile-title">${escapeHtml(key.displayKey)}</div>
            <div class="tile-meta">${escapeHtml(key.lastUsername || "No recent user")}</div>
          </div>
          <div class="flag-row">${statuses}</div>
        </div>
        <div class="tile-stats">
          <div class="tile-stat"><span>Sessions</span><strong>${escapeHtml(key.liveSessions)}</strong></div>
          <div class="tile-stat"><span>Expires</span><strong>${escapeHtml(formatDate(key.expiresAt))}</strong></div>
          <div class="tile-stat"><span>Last Server</span><strong>${escapeHtml(key.lastServer || "Unknown")}</strong></div>
        </div>
      </article>
    `;
  }).join("");

  elements.recentKeysGrid.querySelectorAll(".key-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      const keyId = tile.dataset.key || "";
      elements.keyInput.value = keyId;
      void loadKeyInfo(keyId);
    });
  });
}

function renderUsers(users) {
  if (!users.length) {
    elements.usersGrid.innerHTML = renderEmptyState("No live users.", "Presence data will appear here when sessions are active.");
    return;
  }

  elements.usersGrid.innerHTML = users.map((user) => {
    const flags = [
      statusPill(formatLastSeen(user.lastSeen)),
      user.frozen ? statusPill("Frozen", "alert") : "",
      user.blinded ? statusPill("Blinded", "alert") : "",
      user.adminMessage ? statusPill("Message queued", "accent") : ""
    ].join("");

    return `
      <article class="user-tile">
        <div class="user-top">
          <div>
            <div class="user-title">${escapeHtml(user.username)}</div>
            <div class="user-meta">${escapeHtml(user.displayKey)} on ${escapeHtml(user.server || "Unknown")}</div>
          </div>
          <div class="flag-row">${flags}</div>
        </div>
        <div class="user-stats">
          <div class="user-stat"><span>Position</span><strong>${escapeHtml(Math.round(user.playerX))}, ${escapeHtml(Math.round(user.playerY))}</strong></div>
          <div class="user-stat"><span>Server ID</span><strong>${escapeHtml(user.serverId || "Unknown")}</strong></div>
          <div class="user-stat"><span>Message</span><strong>${escapeHtml(user.adminMessage || "None")}</strong></div>
        </div>
        <div class="user-actions">
          <button class="secondary-button user-action" data-action="freeze" data-session="${escapeHtml(user.sessionId)}" data-value="${String(!user.frozen)}" type="button">
            ${user.frozen ? "Unfreeze" : "Freeze"}
          </button>
          <button class="secondary-button user-action" data-action="blind" data-session="${escapeHtml(user.sessionId)}" data-value="${String(!user.blinded)}" type="button">
            ${user.blinded ? "Unblind" : "Blind"}
          </button>
          <button class="secondary-button user-message" data-session="${escapeHtml(user.sessionId)}" type="button">Message</button>
          <button class="danger-button user-action" data-action="kick" data-session="${escapeHtml(user.sessionId)}" type="button">Kick</button>
        </div>
      </article>
    `;
  }).join("");

  elements.usersGrid.querySelectorAll(".user-action").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionId = button.dataset.session || "";
      const action = button.dataset.action || "";
      const value = button.dataset.value === "true";
      await handleUserAction(sessionId, action, value);
    });
  });

  elements.usersGrid.querySelectorAll(".user-message").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionId = button.dataset.session || "";
      const message = window.prompt("Admin message to send");
      if (!message) {
        return;
      }
      await handleUserMessage(sessionId, message);
    });
  });
}

function renderServiceActions(actions, enabled, configured) {
  if (!enabled) {
    elements.serviceActions.innerHTML = statusPill("SERVICE_SSH_ENABLED is off", "alert");
    return;
  }
  if (!configured) {
    elements.serviceActions.innerHTML = statusPill("SSH target is not configured", "alert");
    return;
  }
  if (!actions.length) {
    elements.serviceActions.innerHTML = statusPill("No service actions configured");
    return;
  }

  elements.serviceActions.innerHTML = actions.map((action) => `
    <button class="secondary-button service-action" data-action="${escapeHtml(action)}" type="button">${escapeHtml(action)}</button>
  `).join("");

  elements.serviceActions.querySelectorAll(".service-action").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action || "";
      await runServiceAction(action);
    });
  });
}

function renderServiceOutput(result) {
  if (!result) {
    elements.serviceOutput.classList.add("empty");
    elements.serviceOutput.innerHTML = renderEmptyState(
      "No service action run yet.",
      "Action output will stream here as a terminal-style report."
    );
    return;
  }

  elements.serviceOutput.classList.remove("empty");
  elements.serviceOutput.innerHTML = `
    <div class="terminal-stack">
      <div class="detail-header">
        <div>
          <strong>${escapeHtml(result.action)}</strong>
          <div class="detail-meta">${escapeHtml(result.target)}</div>
        </div>
        <div class="metric-chip-row">
          <span class="metric-chip"><span>Status</span><code>${escapeHtml(result.success ? "Success" : "Failed")}</code></span>
          <span class="metric-chip"><span>Exit</span><code>${escapeHtml(result.exitCode ?? "N/A")}</code></span>
          <span class="metric-chip"><span>Duration</span><code>${escapeHtml(result.durationMs)}ms</code></span>
        </div>
      </div>
      <div>
        <div class="terminal-label">STDOUT</div>
        <pre>${escapeHtml(result.stdout || "(empty)")}</pre>
      </div>
      <div>
        <div class="terminal-label">STDERR</div>
        <pre>${escapeHtml(result.stderr || "(empty)")}</pre>
      </div>
    </div>
  `;
}

function renderKeyInfo(key) {
  state.currentKeyId = key.keyId;
  elements.keyInput.value = key.displayKey;

  const statusRow = [
    key.isAdmin ? statusPill("Admin", "accent") : statusPill(key.shared ? "Shared" : "Single"),
    key.paused ? statusPill("Paused", "alert") : statusPill("Active", "accent"),
    key.blacklisted ? statusPill("Blacklisted", "alert") : "",
    key.onlineNow ? statusPill("Online now", "accent") : statusPill("Offline")
  ].join("");

  const detailHtml = `
    <div class="detail-stack">
      <div class="detail-header">
        <div>
          <strong>${escapeHtml(key.displayKey)}</strong>
          <div class="detail-meta">${escapeHtml(key.lastUsername || "Unknown user")} on ${escapeHtml(key.lastServer || "Unknown server")}</div>
        </div>
        <div class="flag-row">${statusRow}</div>
      </div>

      <div class="metric-chip-row">
        <span class="metric-chip"><span>Expires</span><code>${escapeHtml(formatDate(key.expiresAt))}</code></span>
        <span class="metric-chip"><span>Sessions</span><code>${escapeHtml(key.liveSessions)}</code></span>
        <span class="metric-chip"><span>Last Seen</span><code>${escapeHtml(formatDate(key.lastSeenAt || key.onlineNow?.lastSeen))}</code></span>
        <span class="metric-chip"><span>Jumpscare</span><code>${escapeHtml(key.jumpscareQueued ? "Queued" : "Idle")}</code></span>
      </div>

      <div class="tile-grid">
        <div class="key-tile">
          <div class="tile-title">Identity</div>
          <div class="tile-stats">
            <div class="tile-stat"><span>Key ID</span><strong>${escapeHtml(key.keyId)}</strong></div>
            <div class="tile-stat"><span>HWID</span><strong>${escapeHtml(key.shared ? "Shared key" : (key.hwid || "None"))}</strong></div>
            <div class="tile-stat"><span>Last HWID</span><strong>${escapeHtml(key.lastHwid || "None")}</strong></div>
            <div class="tile-stat"><span>Last IP</span><strong>${escapeHtml(key.lastIp || "None")}</strong></div>
          </div>
        </div>
        <div class="key-tile">
          <div class="tile-title">Usage</div>
          <div class="tile-stats">
            <div class="tile-stat"><span>Type</span><strong>${escapeHtml(key.isAdmin ? "Admin" : (key.shared ? "Shared" : "Single"))}</strong></div>
            <div class="tile-stat"><span>Activation Count</span><strong>${escapeHtml(key.activationCount || 0)}</strong></div>
            <div class="tile-stat"><span>Max Uses</span><strong>${escapeHtml(key.shared ? (key.maxUses || "Unlimited") : "1")}</strong></div>
            <div class="tile-stat"><span>Created</span><strong>${escapeHtml(formatDate(key.createdAt))}</strong></div>
          </div>
        </div>
      </div>

      ${key.onlineNow ? `
        <div class="key-tile">
          <div class="tile-title">Online Presence</div>
          <div class="tile-stats">
            <div class="tile-stat"><span>User</span><strong>${escapeHtml(key.onlineNow.username)}</strong></div>
            <div class="tile-stat"><span>Server</span><strong>${escapeHtml(key.onlineNow.server)}</strong></div>
            <div class="tile-stat"><span>Flags</span><strong>${escapeHtml(key.onlineNow.frozen ? "Frozen" : "Mobile")} / ${escapeHtml(key.onlineNow.blinded ? "Blinded" : "Visible")}</strong></div>
            <div class="tile-stat"><span>Message</span><strong>${escapeHtml(key.onlineNow.adminMessage || "None")}</strong></div>
          </div>
        </div>
      ` : ""}
    </div>
  `;

  elements.keyInfoOutput.classList.remove("empty");
  elements.keyInfoOutput.innerHTML = detailHtml;
}

async function loadBootstrap() {
  const data = await api("/panel/api/bootstrap");
  state.bootstrap = data;
  setLoggedIn(true);
  const displayKey = data.session.displayKey || "Admin session";
  elements.sessionLabel.textContent = `Signed in as ${displayKey}`;
  elements.heroSessionDisplay.textContent = displayKey;
  renderStats(data.stats);
  renderRecentKeys(data.recentKeys);
  renderUsers(data.users);
  renderServiceActions(data.serviceActions, data.serviceEnabled, data.serviceConfigured);
}

async function loadUsers(showFeedback = false) {
  const data = await api("/panel/api/users");
  renderUsers(data.users);
  if (showFeedback) {
    showToast("Live grid refreshed.");
  }
}

async function loadKeyInfo(keyId) {
  try {
    const data = await api("/panel/api/keys/info", {
      method: "POST",
      body: { key: keyId || elements.keyInput.value }
    });
    renderKeyInfo(data.key);
  } catch (error) {
    elements.keyInfoOutput.classList.remove("empty");
    elements.keyInfoOutput.innerHTML = renderEmptyState("Unable to load key.", error.message);
    showToast(error.message, true);
  }
}

async function handleUserAction(sessionId, action, value) {
  try {
    const path = action === "kick"
      ? "/panel/api/users/kick"
      : action === "freeze"
        ? "/panel/api/users/freeze"
        : "/panel/api/users/blind";

    const body = action === "kick"
      ? { targetSession: sessionId }
      : action === "freeze"
        ? { targetSession: sessionId, freeze: value }
        : { targetSession: sessionId, blind: value };

    await api(path, { method: "POST", body });
    showToast(`User action "${action}" completed.`);
    await loadUsers(false);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleUserMessage(sessionId, message) {
  try {
    await api("/panel/api/users/message", {
      method: "POST",
      body: { targetSession: sessionId, message }
    });
    showToast("Admin message queued.");
    await loadUsers(false);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function runServiceAction(action) {
  try {
    const data = await api("/panel/api/service/run", {
      method: "POST",
      body: { action }
    });
    renderServiceOutput(data.result);
    showToast(`Service action "${action}" completed.`);
  } catch (error) {
    renderServiceOutput({
      action,
      target: "Service bridge",
      success: false,
      exitCode: "N/A",
      durationMs: 0,
      stdout: "",
      stderr: error.message
    });
    showToast(error.message, true);
  }
}

async function handleKeyAction(action) {
  const key = state.currentKeyId || elements.keyInput.value;
  if (!key) {
    showToast("Load a key first.", true);
    return;
  }

  const routeMap = {
    "toggle-pause": "/panel/api/keys/toggle-pause",
    "reset-hwid": "/panel/api/keys/reset-hwid",
    blacklist: "/panel/api/keys/blacklist",
    jumpscare: "/panel/api/keys/jumpscare",
    delete: "/panel/api/keys/delete",
    compensate: "/panel/api/keys/compensate"
  };

  let body = { key };
  if (action === "compensate") {
    body = {
      key,
      days: Number(elements.compensateDays.value || 0)
    };
  }
  if (action === "delete" && !window.confirm(`Delete ${key}?`)) {
    return;
  }

  try {
    await api(routeMap[action], { method: "POST", body });
    showToast(`Key action "${action}" completed.`);
    await loadBootstrap();
    await loadKeyInfo(key);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function boot() {
  renderGenerateResult(null);
  renderServiceOutput(null);

  try {
    const session = await api("/panel/api/session");
    if (session.authenticated) {
      await loadBootstrap();
      return;
    }
  } catch {
  }

  setLoggedIn(false);
  elements.sessionLabel.textContent = "Not signed in";
  elements.heroSessionDisplay.textContent = "No active session";
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/panel/api/login", {
      method: "POST",
      body: { adminKey: elements.adminKeyInput.value }
    });
    elements.adminKeyInput.value = "";
    showToast("Panel unlocked.");
    await loadBootstrap();
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await api("/panel/api/logout", { method: "POST" });
  setLoggedIn(false);
  elements.sessionLabel.textContent = "Not signed in";
  elements.heroSessionDisplay.textContent = "No active session";
  showToast("Logged out.");
});

elements.generateAdmin.addEventListener("change", () => {
  const adminMode = elements.generateAdmin.checked;
  elements.generateAmount.disabled = adminMode;
  elements.generateShared.disabled = adminMode;
  elements.generateMaxUses.disabled = adminMode || !elements.generateShared.checked;
});

elements.generateShared.addEventListener("change", () => {
  elements.generateMaxUses.disabled = !elements.generateShared.checked || elements.generateAdmin.checked;
});

elements.generateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/panel/api/keys/generate", {
      method: "POST",
      body: {
        amount: Number(elements.generateAmount.value || 1),
        duration: elements.generateDuration.value,
        shared: elements.generateShared.checked,
        maxUses: Number(elements.generateMaxUses.value || 0),
        isAdmin: elements.generateAdmin.checked
      }
    });
    renderGenerateResult(data.generated);
    showToast("Keys generated.");
    await loadBootstrap();
  } catch (error) {
    renderGenerateResult(null);
    showToast(error.message, true);
  }
});

elements.keyInfoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadKeyInfo(elements.keyInput.value);
});

document.querySelectorAll("[data-key-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    await handleKeyAction(button.dataset.keyAction || "");
  });
});

elements.refreshUsers.addEventListener("click", async () => {
  await loadUsers(true);
});

elements.deleteAllKeys.addEventListener("click", async () => {
  if (!window.confirm("Delete every key, session, activation, blacklist entry, and chat record?")) {
    return;
  }

  try {
    const data = await api("/panel/api/keys/delete-all", { method: "POST" });
    elements.keyInfoOutput.classList.remove("empty");
    elements.keyInfoOutput.innerHTML = renderEmptyState(
      "Keyspace wiped.",
      `Deleted ${data.result.deletedKeys} key(s) and cleared related session data.`
    );
    showToast("All keys deleted.");
    await loadBootstrap();
  } catch (error) {
    showToast(error.message, true);
  }
});

boot().catch((error) => {
  showToast(error.message || "Panel failed to load.", true);
});
