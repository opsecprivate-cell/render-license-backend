const state = {
  bootstrap: null,
  currentKeyId: ""
};

const elements = {
  loginCard: document.getElementById("login-card"),
  appShell: document.getElementById("app-shell"),
  loginForm: document.getElementById("login-form"),
  adminKeyInput: document.getElementById("admin-key-input"),
  logoutButton: document.getElementById("logout-button"),
  sessionLabel: document.getElementById("session-label"),
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
  recentKeysBody: document.getElementById("recent-keys-body"),
  usersBody: document.getElementById("users-body"),
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

function setLoggedIn(isLoggedIn) {
  elements.loginCard.classList.toggle("hidden", isLoggedIn);
  elements.appShell.classList.toggle("hidden", !isLoggedIn);
  elements.logoutButton.classList.toggle("hidden", !isLoggedIn);
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast${isError ? " error" : ""}`;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3600);
}

function setOutput(element, value) {
  element.textContent = value;
  element.classList.toggle("empty", !value);
}

function formatDate(value) {
  if (!value) {
    return "Lifetime";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
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
  return `${hours}h ago`;
}

function renderStats(stats) {
  const entries = [
    ["Total Keys", stats.totalKeys],
    ["Single Keys", stats.singleKeys],
    ["Shared Keys", stats.sharedKeys],
    ["Admin Keys", stats.adminKeys],
    ["Live Sessions", stats.liveSessions],
    ["Shared Activations", stats.sharedActivations]
  ];

  elements.statsGrid.innerHTML = entries.map(([label, value]) => `
    <article class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
    </article>
  `).join("");
}

function renderRecentKeys(keys) {
  if (!keys.length) {
    elements.recentKeysBody.innerHTML = `<tr><td colspan="6">No keys found.</td></tr>`;
    return;
  }

  elements.recentKeysBody.innerHTML = keys.map((key) => {
    const type = key.isAdmin ? "Admin" : (key.shared ? "Shared" : "Single");
    const status = [
      key.paused ? "Paused" : "Active",
      key.blacklisted ? "Blacklisted" : null
    ].filter(Boolean).join(", ");

    return `
      <tr class="key-row" data-key="${key.keyId}">
        <td>${key.displayKey}</td>
        <td>${type}</td>
        <td>${status || "Active"}</td>
        <td>${key.liveSessions}</td>
        <td>${key.lastUsername || "Unknown"}</td>
        <td>${formatDate(key.expiresAt)}</td>
      </tr>
    `;
  }).join("");

  elements.recentKeysBody.querySelectorAll(".key-row").forEach((row) => {
    row.addEventListener("click", () => {
      const keyId = row.dataset.key || "";
      elements.keyInput.value = keyId;
      void loadKeyInfo(keyId);
    });
  });
}

function renderUsers(users) {
  if (!users.length) {
    elements.usersBody.innerHTML = `<tr><td colspan="6">No live users.</td></tr>`;
    return;
  }

  elements.usersBody.innerHTML = users.map((user) => `
    <tr>
      <td>
        <strong>${user.username}</strong><br>
        <span class="pill">${formatLastSeen(user.lastSeen)}</span>
      </td>
      <td>${user.displayKey}</td>
      <td>${user.server || "Unknown"}</td>
      <td>${[
        user.frozen ? "Frozen" : null,
        user.blinded ? "Blinded" : null,
        user.adminMessage ? "Message queued" : null
      ].filter(Boolean).join(", ") || "None"}</td>
      <td>${Math.round(user.playerX)}, ${Math.round(user.playerY)}</td>
      <td>
        <button class="secondary-button user-action" data-action="freeze" data-session="${user.sessionId}" data-value="${!user.frozen}">
          ${user.frozen ? "Unfreeze" : "Freeze"}
        </button>
        <button class="secondary-button user-action" data-action="blind" data-session="${user.sessionId}" data-value="${!user.blinded}">
          ${user.blinded ? "Unblind" : "Blind"}
        </button>
        <button class="secondary-button user-message" data-session="${user.sessionId}">Message</button>
        <button class="danger-button user-action" data-action="kick" data-session="${user.sessionId}">Kick</button>
      </td>
    </tr>
  `).join("");

  elements.usersBody.querySelectorAll(".user-action").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionId = button.dataset.session || "";
      const action = button.dataset.action || "";
      const value = button.dataset.value === "true";
      await handleUserAction(sessionId, action, value);
    });
  });

  elements.usersBody.querySelectorAll(".user-message").forEach((button) => {
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
    elements.serviceActions.innerHTML = `<div class="pill">SERVICE_SSH_ENABLED is off</div>`;
    return;
  }
  if (!configured) {
    elements.serviceActions.innerHTML = `<div class="pill">SSH target is not configured</div>`;
    return;
  }
  if (!actions.length) {
    elements.serviceActions.innerHTML = `<div class="pill">No service actions configured</div>`;
    return;
  }

  elements.serviceActions.innerHTML = actions.map((action) => `
    <button class="secondary-button service-action" data-action="${action}" type="button">${action}</button>
  `).join("");

  elements.serviceActions.querySelectorAll(".service-action").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action || "";
      await runServiceAction(action);
    });
  });
}

function renderKeyInfo(key) {
  state.currentKeyId = key.keyId;
  const output = [
    `Key: ${key.displayKey}`,
    `Type: ${key.isAdmin ? "Admin" : (key.shared ? "Shared" : "Single")}`,
    `Paused: ${key.paused}`,
    `Blacklisted: ${key.blacklisted}`,
    `Expires: ${formatDate(key.expiresAt)}`,
    `Live Sessions: ${key.liveSessions}`,
    `Last User: ${key.lastUsername || "Unknown"}`,
    `Last Server: ${key.lastServer || "Unknown"}`,
    `Last HWID: ${key.lastHwid || "N/A"}`,
    `Last IP: ${key.lastIp || "N/A"}`,
    key.shared ? `Activations: ${key.activationCount} / ${key.maxUses || "Unlimited"}` : `HWID: ${key.hwid || "N/A"}`,
    key.onlineNow
      ? `Online Now: ${key.onlineNow.username} on ${key.onlineNow.server} (${key.onlineNow.frozen ? "Frozen" : "Mobile"}, ${key.onlineNow.blinded ? "Blinded" : "Visible"})`
      : "Online Now: No"
  ].join("\n");
  setOutput(elements.keyInfoOutput, output);
}

async function loadBootstrap() {
  const data = await api("/panel/api/bootstrap");
  state.bootstrap = data;
  setLoggedIn(true);
  elements.sessionLabel.textContent = `Signed in as ${data.session.displayKey}`;
  renderStats(data.stats);
  renderRecentKeys(data.recentKeys);
  renderUsers(data.users);
  renderServiceActions(data.serviceActions, data.serviceEnabled, data.serviceConfigured);
}

async function loadUsers() {
  const data = await api("/panel/api/users");
  renderUsers(data.users);
}

async function loadKeyInfo(keyId) {
  try {
    const data = await api("/panel/api/keys/info", {
      method: "POST",
      body: { key: keyId || elements.keyInput.value }
    });
    renderKeyInfo(data.key);
  } catch (error) {
    setOutput(elements.keyInfoOutput, error.message);
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
    await loadUsers();
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
    await loadUsers();
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
    const result = data.result;
    setOutput(
      elements.serviceOutput,
      [
        `Action: ${result.action}`,
        `Target: ${result.target}`,
        `Success: ${result.success}`,
        `Exit Code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        "",
        "STDOUT:",
        result.stdout || "(empty)",
        "",
        "STDERR:",
        result.stderr || "(empty)"
      ].join("\n")
    );
    showToast(`Service action "${action}" completed.`);
  } catch (error) {
    setOutput(elements.serviceOutput, error.message);
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
    const days = window.prompt("How many days should be added?", "7");
    if (!days) {
      return;
    }
    body = { key, days: Number(days) };
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
    const generated = data.generated;
    setOutput(
      elements.generateOutput,
      [
        `Generated ${generated.keys.length} key(s)`,
        `Duration: ${generated.duration}`,
        `Expires: ${formatDate(generated.expiresAt)}`,
        "",
        ...generated.keys
      ].join("\n")
    );
    showToast("Keys generated.");
    await loadBootstrap();
  } catch (error) {
    setOutput(elements.generateOutput, error.message);
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
  await loadUsers();
  showToast("Users refreshed.");
});

elements.deleteAllKeys.addEventListener("click", async () => {
  if (!window.confirm("Delete every key, session, activation, blacklist entry, and chat record?")) {
    return;
  }
  try {
    const data = await api("/panel/api/keys/delete-all", { method: "POST" });
    setOutput(elements.keyInfoOutput, `Deleted ${data.result.deletedKeys} key(s).`);
    showToast("All keys deleted.");
    await loadBootstrap();
  } catch (error) {
    showToast(error.message, true);
  }
});

boot().catch((error) => {
  showToast(error.message || "Panel failed to load.", true);
});
