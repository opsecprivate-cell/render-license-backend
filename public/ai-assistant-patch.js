(() => {
  if (window.__renderAiAssistantPatchLoaded) {
    return;
  }
  window.__renderAiAssistantPatchLoaded = true;

  const VERSION = "20260331.5";
  const TAB_ID = "ai";
  const TAB_HTML = `
    <i class="bx bx-bot"></i>
    <span class="menu-tab-copy">
      <span class="menu-tab-title">AI Assistant</span>
      <span class="menu-tab-note">debug</span>
    </span>
    <span class="menu-tab-index">I9</span>
  `;
  const STORE_KEY = "render_ai_assistant_state_v1";
  const MAX_MESSAGES = 28;
  const MAX_CONSOLE = 180;
  const MAX_NETWORK = 120;
  const MAX_PACKET_RECORDS = 28;
  const MAX_IMAGE_BYTES = 4_800_000;
  const ASSISTANT_REQUEST_TIMEOUT_MS = 90_000;
  const MAX_CONTEXT_WINDOW_CHARS = 48_000;
  const SOURCE_FIELD_KEYS = new Set([
    "source",
    "script",
    "code",
    "botCode",
    "customPvpCode",
    "customAntiBotCode"
  ]);
  const CODE_SLOT_DEFS = Object.freeze({
    pvp: {
      id: "pvp",
      aliases: ["pvp", "pvpbot", "pvp_bot", "custompvpcode"],
      modKey: "customPvpCode",
      applyMethod: "applyCustomAttackCode",
      label: "PVP Bot"
    },
    antiBot: {
      id: "antiBot",
      aliases: ["antibot", "anti-bot", "anti_bot", "customantibotcode"],
      modKey: "customAntiBotCode",
      applyMethod: "applyCustomAntiBotCode",
      label: "Anti-Bot"
    },
    bot: {
      id: "bot",
      aliases: ["bot", "mainbot", "main_bot", "botcode"],
      modKey: "botCode",
      applyMethod: "",
      label: "Main Bot"
    }
  });
  const DEFAULT_PREFS = {
    autoContext: true,
    includeStorage: true,
    includePackets: true,
    includeSensitive: false,
    allowAutomation: true
  };
  const state = {
    feed: [],
    messages: [],
    composerDraft: "",
    consoleEntries: [],
    networkEntries: [],
    attachment: null,
    pending: false,
    pendingLabel: "",
    prefs: { ...DEFAULT_PREFS },
    lastContextAt: 0,
    lastContextChars: 0,
    lastContextAreas: [],
    lastModel: "",
    booted: false
  };

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch] || ch));
  const text = (value, max = 600) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  const draftText = (value, max = 8000) => String(value == null ? "" : value).replace(/\r\n/g, "\n").slice(0, max);
  const clip = (value, max = 1600) => {
    const stringValue = String(value == null ? "" : value);
    return stringValue.length > max ? `${stringValue.slice(0, max)}\n/* clipped */` : stringValue;
  };
  const fastHash = (value) => {
    const input = String(value == null ? "" : value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  };
  const countLines = (value) => {
    const input = String(value == null ? "" : value);
    return input ? input.split(/\r\n|\r|\n/).length : 0;
  };
  const looksLikeSource = (value) => {
    const input = String(value == null ? "" : value);
    if (input.length < 120) {
      return false;
    }
    let score = 0;
    if (/\bfunction\b/.test(input)) score += 2;
    if (/=>/.test(input)) score += 2;
    if (/\breturn\b/.test(input)) score += 1;
    if (/\b(const|let|var|class|async|await)\b/.test(input)) score += 2;
    if (/[{};]/.test(input)) score += 1;
    if (/\b(window|document|Math|Array|Object)\./.test(input)) score += 1;
    if (/\n/.test(input)) score += 1;
    return score >= 4;
  };
  const summarizeCodeBlob = (value, kind = "source") => {
    const input = String(value == null ? "" : value);
    return {
      redacted: true,
      kind,
      chars: input.length,
      lines: countLines(input),
      hash: fastHash(input)
    };
  };
  const stable = (value, max = 3200) => {
    try {
      return clip(JSON.stringify(value, null, 2), max);
    } catch {
      return clip(String(value), max);
    }
  };
  const countContextChars = (value) => {
    try {
      return JSON.stringify(value).length;
    } catch {
      return String(value == null ? "" : value).length;
    }
  };
  const formatCompactCount = (value) => {
    const number = Number(value) || 0;
    if (number >= 1_000_000) {
      return `${Math.round(number / 100_000) / 10}m`;
    }
    if (number >= 1_000) {
      return `${Math.round(number / 100) / 10}k`;
    }
    return String(number);
  };
  const describeContextBudget = () => {
    const used = Math.max(0, Number(state.lastContextChars) || 0);
    const budget = MAX_CONTEXT_WINDOW_CHARS;
    const remaining = Math.max(0, budget - used);
    const percent = Math.max(0, Math.min(100, Math.round((used / budget) * 100)));
    const areas = Array.isArray(state.lastContextAreas) ? state.lastContextAreas.slice(0, 8) : [];
    return {
      used,
      budget,
      remaining,
      percent,
      areas,
      compact: `${percent}%`,
      detail: `${formatCompactCount(used)} / ${formatCompactCount(budget)} chars`
    };
  };
  const pushLimited = (list, item, max) => {
    list.push(item);
    if (list.length > max) {
      list.splice(0, list.length - max);
    }
  };
  const saveState = () => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          messages: state.messages.slice(-MAX_MESSAGES),
          feed: state.feed.slice(-MAX_MESSAGES),
          composerDraft: state.composerDraft,
          prefs: state.prefs,
          attachment: state.attachment
            ? {
                name: state.attachment.name,
                type: state.attachment.type,
                size: state.attachment.size,
                width: state.attachment.width,
                height: state.attachment.height,
                dataUrl: state.attachment.dataUrl
              }
            : null
        })
      );
    } catch {}
  };
  const loadState = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (Array.isArray(parsed.messages)) {
        state.messages = parsed.messages
          .map((entry) => ({
            role: String(entry && entry.role || "user"),
            content: clip(entry && entry.content || "", 5000)
          }))
          .filter((entry) => entry.content)
          .slice(-MAX_MESSAGES);
      }
      if (Array.isArray(parsed.feed)) {
        state.feed = parsed.feed
          .map((entry) => ({
            id: String(entry && entry.id || `${Date.now()}-${Math.random()}`),
            role: String(entry && entry.role || "assistant"),
            text: clip(entry && entry.text || "", 6000),
            meta: text(entry && entry.meta || "", 220),
            summary: Array.isArray(entry && entry.summary) ? entry.summary.map((item) => text(item, 240)).slice(0, 8) : [],
            nextActions: Array.isArray(entry && entry.nextActions) ? entry.nextActions.map((item) => text(item, 240)).slice(0, 8) : []
          }))
          .slice(-MAX_MESSAGES);
      }
      state.composerDraft = draftText(parsed && parsed.composerDraft || "", 8000);
      state.prefs = { ...DEFAULT_PREFS, ...(parsed && parsed.prefs && typeof parsed.prefs === "object" ? parsed.prefs : {}) };
      if (parsed && parsed.attachment && typeof parsed.attachment === "object") {
        const dataUrl = String(parsed.attachment.dataUrl || "").trim();
        if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
          state.attachment = {
            name: text(parsed.attachment.name || "attachment", 120),
            type: text(parsed.attachment.type || "image/png", 80),
            size: Number(parsed.attachment.size) || 0,
            width: Number(parsed.attachment.width) || 0,
            height: Number(parsed.attachment.height) || 0,
            dataUrl
          };
        }
      }
    } catch {}
  };
  const notify = (message, type = "info") => {
    if (window.menu && typeof window.menu.showNotification === "function") {
      try {
        window.menu.showNotification(String(message || ""), type);
        return;
      } catch {}
    }
    try {
      console[type === "error" ? "error" : type === "warn" ? "warn" : "log"](`[AI Assistant] ${message}`);
    } catch {}
  };
  const nowIso = () => new Date().toISOString();
  const bridge = () =>
    window.__RENDER_SECURE && typeof window.__RENDER_SECURE.callApi === "function"
      ? window.__RENDER_SECURE
      : null;
  const readStorageJson = (storage, key, fallbackValue = "") => {
    try {
      const raw = storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
      return raw == null ? fallbackValue : JSON.parse(raw);
    } catch {
      return fallbackValue;
    }
  };
  const getBackendUrl = () => {
    const configured = String(window.__RENDER_LIGHT_LOADER_BACKEND__ || "").trim();
    return configured || "https://render-license-backend.onrender.com";
  };
  const canonicalizeSecurePayload = (value) => {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalizeSecurePayload(entry)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeSecurePayload(value[key])}`).join(",")}}`;
  };
  const toHex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const hmacSha256Hex = async (secret, message) => {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(secret || "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(String(message || "")));
    return toHex(new Uint8Array(signature));
  };
  const getStoredAssistantAuth = () => {
    const liveAuth = window.__RENDER_AI_AUTH__;
    if (liveAuth && typeof liveAuth === "object") {
      const sessionToken = String(liveAuth.sessionToken || "").trim();
      const requestSecret = String(liveAuth.requestSecret || "").trim();
      const hwid = String(liveAuth.hwid || "").trim().toUpperCase();
      if (sessionToken && requestSecret && /^[A-F0-9]{16}$/.test(hwid)) {
        return { sessionToken, requestSecret, hwid };
      }
    }
    const sessionToken = String(readStorageJson(sessionStorage, "_st_v2", "") || "").trim();
    const requestSecret = String(readStorageJson(sessionStorage, "_rs_v2", "") || "").trim();
    const storedHwid = String(readStorageJson(localStorage, "_hw_v2", "") || "").trim().toUpperCase();
    const hwid = /^[A-F0-9]{16}$/.test(storedHwid)
      ? storedHwid
      : (bridge() && typeof bridge().getHwid === "function" ? String(bridge().getHwid() || "").trim().toUpperCase() : "");
    return sessionToken && requestSecret && /^[A-F0-9]{16}$/.test(hwid)
      ? { sessionToken, requestSecret, hwid }
      : null;
  };
  const getStoredAdminKey = () => {
    const liveAuth = window.__RENDER_AI_AUTH__;
    const liveKey = String(liveAuth && liveAuth.licenseKey || "").trim();
    if (liveKey) {
      return liveKey;
    }
    const storedKey = String(readStorageJson(localStorage, "_mk_v2", "") || "").trim();
    return storedKey || "";
  };
  const hasAssistantAccess = () => hasSession() || !!getStoredAdminKey();
  const createDirectSecurePayload = async (endpoint, payload, auth) => {
    const basePayload = payload && typeof payload === "object" ? { ...payload } : {};
    delete basePayload.__secureTs;
    delete basePayload.__secureNonce;
    delete basePayload.__secureSig;
    delete basePayload.sessionToken;
    delete basePayload.hwid;
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const ts = Date.now();
    const nonce = `${Date.now().toString(36)}.${toHex(nonceBytes)}`;
    const canonicalPayload = canonicalizeSecurePayload(basePayload);
    const base = `${endpoint}|${auth.sessionToken}|${auth.hwid}|${ts}|${nonce}|${canonicalPayload}`;
    const sig = await hmacSha256Hex(auth.requestSecret, base);
    return {
      ...basePayload,
      sessionToken: auth.sessionToken,
      hwid: auth.hwid,
      __secureTs: ts,
      __secureNonce: nonce,
      __secureSig: sig
    };
  };
  const directAssistantRequest = async (messages, context) => {
    const auth = getStoredAssistantAuth();
    const adminKey = getStoredAdminKey();
    if (!auth && !adminKey) {
      throw new Error("Active admin session or admin key required.");
    }
    let payload = {
      messages,
      context,
      image: attachmentPayload()
    };
    if (auth) {
      payload = await createDirectSecurePayload("/ai/assistant", payload, auth);
    }
    if (adminKey) {
      payload.adminKey = adminKey;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ASSISTANT_REQUEST_TIMEOUT_MS);
    let response;
    let responseText = "";
    try {
      response = await fetch(`${getBackendUrl()}/ai/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      responseText = await response.text();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error(`AI request timed out after ${Math.floor(ASSISTANT_REQUEST_TIMEOUT_MS / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    let json = {};
    if (responseText) {
      try {
        json = JSON.parse(responseText);
      } catch {
        json = {};
      }
    }
    if (!response.ok) {
      throw new Error(json && json.error ? json.error : responseText || `Assistant request failed (${response.status})`);
    }
    return json;
  };
  const hasSession = () => {
    const api = bridge();
    return !!(api && typeof api.hasSession === "function" && api.hasSession());
  };
  const isAdmin = () => {
    const api = bridge();
    return !!(api && typeof api.getAdmin === "function" && api.getAdmin());
  };
  const addFeed = (role, message, meta = "", extra = {}) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role,
      text: clip(message || "", role === "tool" ? 5000 : 7000),
      meta: text(meta || "", 220),
      summary: Array.isArray(extra.summary) ? extra.summary.map((item) => text(item, 240)).slice(0, 8) : [],
      nextActions: Array.isArray(extra.nextActions) ? extra.nextActions.map((item) => text(item, 240)).slice(0, 8) : []
    };
    pushLimited(state.feed, entry, MAX_MESSAGES);
    saveState();
    renderIfVisible();
    return entry;
  };
  const pushConversation = (role, content) => {
    pushLimited(state.messages, { role, content: clip(content || "", 5000) }, MAX_MESSAGES);
    saveState();
  };
  const summarizeArgs = (args) => {
    if (!args || typeof args !== "object") {
      return "";
    }
    const entries = Object.entries(args)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, 4)
      .map(([key, value]) => `${key}=${text(typeof value === "string" ? value : stable(value, 180), 180)}`);
    return entries.join(" | ");
  };
  const toSelector = (node) => {
    if (!node || node.nodeType !== 1) {
      return "";
    }
    if (node.id) {
      return `#${CSS.escape(node.id)}`;
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.classList && current.classList.length) {
        part += `.${Array.from(current.classList).slice(0, 2).map((cls) => CSS.escape(cls)).join(".")}`;
      }
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const safeValuePreview = (node, includeSensitive) => {
    if (!node || typeof node !== "object") {
      return "";
    }
    const value = "value" in node ? String(node.value || "") : "";
    if (!value) {
      return "";
    }
    if (includeSensitive) {
      return clip(value, 200);
    }
    if (String(node.type || "").toLowerCase() === "password") {
      return "[redacted password]";
    }
    return value.length > 12 ? `${value.slice(0, 3)}...(${value.length})` : "[redacted]";
  };
  const summarizeElement = (node, includeSensitive = false) => {
    if (!node || node.nodeType !== 1) {
      return null;
    }
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    return {
      selector: toSelector(node),
      tag: String(node.tagName || "").toLowerCase(),
      id: text(node.id || "", 120),
      classes: Array.from(node.classList || []).slice(0, 8),
      name: text(node.getAttribute && node.getAttribute("name") || "", 120),
      role: text(node.getAttribute && node.getAttribute("role") || "", 120),
      placeholder: text(node.getAttribute && node.getAttribute("placeholder") || "", 160),
      ariaLabel: text(node.getAttribute && (node.getAttribute("aria-label") || node.getAttribute("aria-labelledby")) || "", 160),
      text: text(node.innerText || node.textContent || "", 220),
      value: safeValuePreview(node, includeSensitive),
      disabled: !!node.disabled,
      visible: !!(rect && rect.width > 0 && rect.height > 0),
      rect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : null
    };
  };
  const formatError = (error) => {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error.message === "string") {
      return error.message;
    }
    return stable(error, 1200);
  };
  const jsonSafe = (value, depth = 0) => {
    if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      return value;
    }
    if (depth > 2) {
      return "[depth]";
    }
    if (Array.isArray(value)) {
      return value.slice(0, 24).map((item) => jsonSafe(item, depth + 1));
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: clip(value.stack || "", 1200) };
    }
    if (value && value.nodeType === 1) {
      return summarizeElement(value, state.prefs.includeSensitive);
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      out[key] = jsonSafe(item, depth + 1);
    }
    return out;
  };
  const sanitizeToolPayload = (value, path = "", depth = 0) => {
    const leafKey = path ? path.split(".").pop() : "";
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    if (typeof value === "string") {
      if (SOURCE_FIELD_KEYS.has(String(leafKey || "").trim()) || looksLikeSource(value)) {
        return summarizeCodeBlob(value, SOURCE_FIELD_KEYS.has(String(leafKey || "").trim()) ? "protected-source" : "code-like-string");
      }
      return clip(value, 2000);
    }
    if (depth > 5) {
      return "[depth]";
    }
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item, index) => sanitizeToolPayload(item, `${path}[${index}]`, depth + 1));
    }
    if (value && value.nodeType === 1) {
      return summarizeElement(value, state.prefs.includeSensitive);
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: clip(value.stack || "", 1200)
      };
    }
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      output[key] = sanitizeToolPayload(item, path ? `${path}.${key}` : key, depth + 1);
    }
    return output;
  };
  const recordConsole = (level, args) => {
    pushLimited(
      state.consoleEntries,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        level,
        time: nowIso(),
        message: clip(args.map((item) => (typeof item === "string" ? item : stable(jsonSafe(item), 500))).join(" "), 1200)
      },
      MAX_CONSOLE
    );
    renderIfVisible();
  };
  const recordNetwork = (entry) => {
    pushLimited(
      state.networkEntries,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        time: nowIso(),
        method: text(entry.method || "GET", 16),
        url: clip(entry.url || "", 520),
        status: entry.status == null ? null : entry.status,
        ok: entry.ok !== false,
        transport: text(entry.transport || "fetch", 24),
        durationMs: Math.round(Number(entry.durationMs) || 0),
        contentType: text(entry.contentType || "", 120),
        preview: clip(entry.preview || "", 800),
        error: text(entry.error || "", 260)
      },
      MAX_NETWORK
    );
    renderIfVisible();
  };
  const installConsoleCapture = () => {
    if (window.__renderAiConsoleCaptureInstalled) {
      return;
    }
    window.__renderAiConsoleCaptureInstalled = true;
    ["log", "info", "warn", "error"].forEach((level) => {
      const original = console[level];
      if (typeof original !== "function") {
        return;
      }
      console[level] = function (...args) {
        try {
          recordConsole(level, args);
        } catch {}
        return original.apply(this, args);
      };
    });
    window.addEventListener("error", (event) => {
      recordConsole("error", [
        event.message || "Window error",
        event.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : ""
      ]);
    });
    window.addEventListener("unhandledrejection", (event) => {
      recordConsole("error", ["Unhandled rejection", formatError(event.reason)]);
    });
  };
  const installNetworkCapture = () => {
    if (window.__renderAiNetworkCaptureInstalled) {
      return;
    }
    window.__renderAiNetworkCaptureInstalled = true;
    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (...args) {
        const request = args[0];
        const init = args[1] || {};
        const method = request instanceof Request ? request.method : init.method || "GET";
        const url = request instanceof Request ? request.url : String(request || "");
        const started = performance.now();
        try {
          const response = await originalFetch(...args);
          const durationMs = performance.now() - started;
          let preview = "";
          let contentType = "";
          try {
            contentType = String(response.headers.get("content-type") || "");
            if (/json|text|javascript|xml|html/i.test(contentType)) {
              preview = clip(await response.clone().text(), 1000);
            }
          } catch {}
          recordNetwork({
            transport: "fetch",
            method,
            url,
            status: response.status,
            ok: response.ok,
            durationMs,
            contentType,
            preview
          });
          return response;
        } catch (error) {
          recordNetwork({
            transport: "fetch",
            method,
            url,
            status: "ERR",
            ok: false,
            durationMs: performance.now() - started,
            error: formatError(error)
          });
          throw error;
        }
      };
    }
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      const xhrProto = window.XMLHttpRequest.prototype;
      const originalOpen = xhrProto.open;
      const originalSend = xhrProto.send;
      xhrProto.open = function (method, url, ...rest) {
        this.__raiMeta = { method: method || "GET", url: String(url || ""), started: 0 };
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrProto.send = function (...args) {
        if (this.__raiMeta) {
          this.__raiMeta.started = performance.now();
        }
        this.addEventListener("loadend", () => {
          const meta = this.__raiMeta || { method: "GET", url: "" };
          let preview = "";
          let contentType = "";
          try {
            contentType = String(this.getResponseHeader("content-type") || "");
            if (typeof this.responseText === "string" && /json|text|javascript|xml|html/i.test(contentType || "")) {
              preview = clip(this.responseText, 1000);
            }
          } catch {}
          recordNetwork({
            transport: "xhr",
            method: meta.method,
            url: meta.url,
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            durationMs: performance.now() - (meta.started || performance.now()),
            contentType,
            preview
          });
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }
  };
  const snapshotStorageMap = (storageObject, includeSensitive) => {
    const output = {};
    try {
      for (let index = 0; index < storageObject.length && index < 60; index += 1) {
        const key = storageObject.key(index);
        if (!key) {
          continue;
        }
        const rawValue = storageObject.getItem(key);
        output[key] = includeSensitive ? clip(rawValue, 240) : `[${String(rawValue || "").length} chars]`;
      }
    } catch {}
    return output;
  };
  const collectStorageSnapshot = async () => {
    const includeSensitive = !!state.prefs.includeSensitive;
    const output = {
      localStorage: snapshotStorageMap(window.localStorage, includeSensitive),
      sessionStorage: snapshotStorageMap(window.sessionStorage, includeSensitive),
      cookies: includeSensitive ? clip(document.cookie || "", 1200) : document.cookie ? "[redacted]" : "",
      indexedDB: [],
      caches: [],
      storageEstimate: null
    };
    try {
      if (window.indexedDB && typeof window.indexedDB.databases === "function") {
        const databases = await window.indexedDB.databases();
        output.indexedDB = (Array.isArray(databases) ? databases : []).slice(0, 20).map((item) => ({
          name: text(item && item.name || "", 120),
          version: item && item.version != null ? item.version : null
        }));
      }
    } catch {}
    try {
      if (window.caches && typeof window.caches.keys === "function") {
        output.caches = (await window.caches.keys()).slice(0, 20);
      }
    } catch {}
    try {
      if (navigator.storage && typeof navigator.storage.estimate === "function") {
        const estimate = await navigator.storage.estimate();
        output.storageEstimate = {
          usage: estimate && Number(estimate.usage) || 0,
          quota: estimate && Number(estimate.quota) || 0
        };
      }
    } catch {}
    return output;
  };
  const collectDomSnapshot = () => {
    const activeElement = document.activeElement && document.activeElement !== document.body
      ? summarizeElement(document.activeElement, state.prefs.includeSensitive)
      : null;
    const controls = Array.from(document.querySelectorAll("input, textarea, select"))
      .slice(0, 18)
      .map((node) => summarizeElement(node, state.prefs.includeSensitive))
      .filter(Boolean);
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], a[href]"))
      .slice(0, 24)
      .map((node) => summarizeElement(node, state.prefs.includeSensitive))
      .filter(Boolean);
    const canvases = Array.from(document.querySelectorAll("canvas"))
      .slice(0, 8)
      .map((canvas) => ({
        selector: toSelector(canvas),
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight
      }));
    const notable = Array.from(document.querySelectorAll(".error, .warning, .alert, .toast, [data-error], [aria-live]"))
      .slice(0, 12)
      .map((node) => summarizeElement(node, state.prefs.includeSensitive))
      .filter(Boolean);
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      visibility: document.visibilityState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      activeElement,
      controls,
      buttons,
      canvases,
      notable
    };
  };
  const collectPerformanceSnapshot = () => {
    const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType
      ? performance.getEntriesByType("resource")
          .slice(-18)
          .map((entry) => ({
            name: clip(entry.name, 220),
            initiatorType: entry.initiatorType,
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize || 0,
            encodedBodySize: entry.encodedBodySize || 0
          }))
      : [];
    const memory = performance && performance.memory
      ? {
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          usedJSHeapSize: performance.memory.usedJSHeapSize
        }
      : null;
    return {
      now: Math.round(performance.now()),
      navigation: navigation
        ? {
            type: navigation.type,
            duration: Math.round(navigation.duration),
            domComplete: Math.round(navigation.domComplete || 0),
            loadEventEnd: Math.round(navigation.loadEventEnd || 0)
          }
        : null,
      memory,
      resources
    };
  };
  const summarizePacketRecord = (record) => ({
    id: record && record.id != null ? record.id : null,
    kind: text(record && record.kind || "", 40),
    label: text(record && record.label || "", 120),
    direction: text(record && record.direction || "", 40),
    socket: text(record && record.socket || "", 40),
    typeId: record && record.typeId != null ? record.typeId : null,
    timestamp: record && record.timestamp || null,
    details: record && record.details ? clip(stable(record.details, 1000), 1000) : "",
    state: record && record.state ? clip(stable(record.state, 1000), 1000) : ""
  });
  const collectPacketSnapshot = () => {
    const packetAnalyzer = window.menu && window.menu.packetAnalyzer ? window.menu.packetAnalyzer : null;
    const records = Array.isArray(packetAnalyzer && packetAnalyzer.records)
      ? packetAnalyzer.records.slice(-MAX_PACKET_RECORDS).map(summarizePacketRecord)
      : [];
    return {
      enabled: !!(packetAnalyzer && packetAnalyzer.enabled),
      paused: !!(packetAnalyzer && packetAnalyzer.paused),
      recordCount: Array.isArray(packetAnalyzer && packetAnalyzer.records) ? packetAnalyzer.records.length : 0,
      query: text(packetAnalyzer && packetAnalyzer.query || "", 120),
      directionFilter: text(packetAnalyzer && packetAnalyzer.directionFilter || "", 40),
      socketFilter: text(packetAnalyzer && packetAnalyzer.socketFilter || "", 40),
      runtime: jsonSafe(window.__renderPacketAnalyzerRuntimeState || {}),
      recent: records
    };
  };
  const isCodeSlotField = (key) =>
    Object.values(CODE_SLOT_DEFS).some((entry) => entry.modKey === String(key || ""));
  const getCodeSlotDef = (slotName) => {
    const normalized = String(slotName || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!normalized) {
      return null;
    }
    return Object.values(CODE_SLOT_DEFS).find((entry) =>
      entry.aliases.some((alias) => alias.replace(/[^a-z0-9]+/g, "") === normalized)
    ) || null;
  };
  const getCodeSlotValue = (slotName) => {
    const def = getCodeSlotDef(slotName);
    if (!def || !window.mod) {
      return "";
    }
    return String(window.mod[def.modKey] || "");
  };
  const summarizeCodeSlot = (slotName) => {
    const def = getCodeSlotDef(slotName);
    if (!def) {
      return null;
    }
    const code = getCodeSlotValue(def.id);
    const present = !!code.trim();
    return {
      id: def.id,
      label: def.label,
      modKey: def.modKey,
      present,
      chars: code.length,
      lines: countLines(code),
      hash: present ? fastHash(code) : "",
      liveApply: !!def.applyMethod
    };
  };
  const summarizePrimitiveSetting = (value) => {
    if (typeof value === "string") {
      return text(value, 180);
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    return value == null ? null : text(String(value), 180);
  };
  const summarizeModValue = (value, key = "", depth = 0) => {
    if (isCodeSlotField(key)) {
      return summarizeCodeSlot(key);
    }
    if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      return summarizePrimitiveSetting(value);
    }
    if (depth > 2) {
      return "[depth]";
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: value.slice(0, 8).map((item) => summarizeModValue(item, "", depth + 1))
      };
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
      output[childKey] = summarizeModValue(childValue, childKey, depth + 1);
    }
    return output;
  };
  const summarizeModSettings = () => {
    if (!window.mod || typeof window.mod !== "object") {
      return null;
    }
    const output = {};
    for (const key of Object.keys(window.mod).sort()) {
      output[key] = summarizeModValue(window.mod[key], key, 0);
    }
    return output;
  };
  const parseModPath = (path) =>
    String(path || "")
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
  const getModSetting = (path) => {
    if (!window.mod || typeof window.mod !== "object") {
      return { ok: false, error: "window.mod is unavailable." };
    }
    const parts = parseModPath(path);
    if (!parts.length) {
      return { ok: false, error: "A mod setting path is required." };
    }
    let cursor = window.mod;
    for (let index = 0; index < parts.length; index += 1) {
      const key = parts[index];
      if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
        return { ok: false, error: `Setting path not found: ${parts.join(".")}` };
      }
      cursor = cursor[key];
    }
    return {
      ok: true,
      path: parts.join("."),
      value: sanitizeToolPayload(summarizeModValue(cursor, parts[parts.length - 1], 0), parts.join("."))
    };
  };
  const syncRuntimeAfterModChange = () => {
    try {
      if (window.menu && typeof window.menu.saveSettings === "function") {
        window.menu.saveSettings();
      }
    } catch {}
    try {
      if (window.menu && typeof window.menu.applyPerformanceMode === "function") {
        window.menu.applyPerformanceMode();
      }
    } catch {}
    try {
      if (window.menu && typeof window.menu.renderTabContent === "function" && window.menu.currentTab) {
        window.menu.renderTabContent();
      }
    } catch {}
  };
  const setModSetting = (path, value) => {
    if (!window.mod || typeof window.mod !== "object") {
      return { ok: false, error: "window.mod is unavailable." };
    }
    const parts = parseModPath(path);
    if (!parts.length) {
      return { ok: false, error: "A mod setting path is required." };
    }
    if (isCodeSlotField(parts[parts.length - 1])) {
      return { ok: false, error: "Use set_code_slot for code fields." };
    }
    let cursor = window.mod;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!cursor[key] || typeof cursor[key] !== "object") {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
    syncRuntimeAfterModChange();
    return {
      ok: true,
      path: parts.join("."),
      value: sanitizeToolPayload(summarizeModValue(cursor[parts[parts.length - 1]], parts[parts.length - 1], 0), parts.join("."))
    };
  };
  const setModSettings = (updates) => {
    const entries = Array.isArray(updates)
      ? updates
      : updates && typeof updates === "object"
        ? Object.entries(updates).map(([path, value]) => ({ path, value }))
        : [];
    if (!entries.length) {
      return { ok: false, error: "No mod settings were provided." };
    }
    const results = [];
    for (const entry of entries.slice(0, 24)) {
      const result = setModSetting(entry && entry.path, entry && entry.value);
      results.push({
        path: String(entry && entry.path || ""),
        ok: !!result.ok,
        value: result.value || null,
        error: result.error || ""
      });
    }
    return {
      ok: results.some((item) => item.ok),
      results
    };
  };
  const listModSettings = () => ({
    ok: !!window.mod,
    count: window.mod && typeof window.mod === "object" ? Object.keys(window.mod).length : 0,
    settings: sanitizeToolPayload(summarizeModSettings(), "mod")
  });
  const applyCodeSlot = (slotName, code) => {
    const def = getCodeSlotDef(slotName);
    if (!def) {
      return { ok: false, error: `Unknown code slot: ${slotName}` };
    }
    if (!window.mod || typeof window.mod !== "object") {
      return { ok: false, error: "window.mod is unavailable." };
    }
    const nextCode = String(code == null ? "" : code);
    window.mod[def.modKey] = nextCode;
    try {
      if (def.applyMethod && window.fighter && typeof window.fighter[def.applyMethod] === "function") {
        const applyResult = window.fighter[def.applyMethod](nextCode);
        if (!applyResult || applyResult.ok !== true) {
          throw applyResult && applyResult.error ? applyResult.error : new Error("Live apply failed.");
        }
        syncRuntimeAfterModChange();
        return {
          ok: true,
          slot: def.id,
          liveApplied: true,
          cleared: !!applyResult.cleared,
          version: applyResult.version || null,
          summary: summarizeCodeSlot(def.id)
        };
      }
      syncRuntimeAfterModChange();
      return {
        ok: true,
        slot: def.id,
        liveApplied: false,
        note: "Slot updated in runtime; no dedicated live compiler is exposed for this slot.",
        summary: summarizeCodeSlot(def.id)
      };
    } catch (error) {
      return {
        ok: false,
        slot: def.id,
        error: formatError(error),
        summary: summarizeCodeSlot(def.id)
      };
    }
  };
  const getDumpRegistry = () =>
    window.__renderFunctionDumpRegistry && typeof window.__renderFunctionDumpRegistry === "object"
      ? window.__renderFunctionDumpRegistry
      : {};
  const analyzeDumpSource = (source) => {
    const input = String(source || "");
    return {
      available: !!input,
      native: /\[native code\]/i.test(input),
      chars: input.length,
      lines: countLines(input),
      hash: input ? fastHash(input) : "",
      capabilities: {
        network: /\b(fetch|XMLHttpRequest|WebSocket)\b/.test(input),
        packetIO: /\b(writeUInt|readUInt|packet|reader|writer)\b/i.test(input),
        socket: /\bsocket\b/i.test(input),
        render: /\b(drawImage|fillText|stroke|canvas|ctx)\b/i.test(input),
        dom: /\b(querySelector|createElement|appendChild|document\.)\b/.test(input),
        session: /\b(session|reconnect|handshake)\b/i.test(input),
        movement: /\b(move|mouse|keydown|keyup|canvas)\b/i.test(input)
      }
    };
  };
  const summarizeDumpTarget = (target) => {
    if (!target || typeof target !== "object") {
      return null;
    }
    const meta = target.meta && typeof target.meta === "object" ? target.meta : {};
    return {
      name: text(target.name || "", 120),
      alias: text(meta.alias || "", 120),
      type: text(target.type || typeof target.value || "", 48),
      arity: typeof target.value === "function" ? target.value.length : null,
      group: text(meta.group || "", 48),
      role: text(meta.role || "", 160),
      opcode: Number.isFinite(meta.opcode) ? meta.opcode : null,
      updatedAt: meta.updatedAt || null,
      notes: text(meta.note || "", 220),
      paramAliases: sanitizeToolPayload(meta.paramAliases || {}, "dump.paramAliases"),
      sourceMeta: analyzeDumpSource(target.source)
    };
  };
  const listDumpTargets = (query) => {
    const registry = getDumpRegistry();
    const needle = text(query || "", 80).toLowerCase();
    const targets = Object.values(registry)
      .filter((entry) => entry && typeof entry === "object")
      .filter((entry) => {
        if (!needle) {
          return true;
        }
        const haystack = [
          entry.name,
          entry.meta && entry.meta.alias,
          entry.meta && entry.meta.group,
          entry.meta && entry.meta.role
        ].map((value) => String(value || "").toLowerCase()).join(" ");
        return haystack.includes(needle);
      })
      .slice(0, 80)
      .map((entry) => summarizeDumpTarget(entry));
    return {
      ok: true,
      total: Object.keys(registry).length,
      matches: targets.length,
      targets
    };
  };
  const inspectDumpTarget = (name) => {
    const registry = getDumpRegistry();
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) {
      return { ok: false, error: "A dump target name or alias is required." };
    }
    const match = Object.values(registry).find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const meta = entry.meta && typeof entry.meta === "object" ? entry.meta : {};
      return String(entry.name || "").toLowerCase() === needle || String(meta.alias || "").toLowerCase() === needle;
    });
    if (!match) {
      return { ok: false, error: `Dump target not found: ${name}` };
    }
    return {
      ok: true,
      target: summarizeDumpTarget(match)
    };
  };
  const summarizeEntity = (entity) => {
    if (!entity || typeof entity !== "object") {
      return null;
    }
    return {
      id: entity.id != null ? entity.id : null,
      x: Number(entity.nx != null ? entity.nx : entity.x) || 0,
      y: Number(entity.ny != null ? entity.ny : entity.y) || 0,
      radius: Number(entity.nRad != null ? entity.nRad : entity.rad) || 0,
      animalType: entity.animalType != null ? entity.animalType : null,
      species: entity.animalSpecies != null ? entity.animalSpecies : null,
      subSpecies: entity.animalSubSpecies != null ? entity.animalSubSpecies : null,
      nickName: text(entity.nickName || entity.name || "", 80)
    };
  };
  const summarizeGameRef = () => {
    const ref = window._gameRef && typeof window._gameRef === "object" ? window._gameRef : null;
    return ref
      ? {
          player: summarizeEntity(ref.player),
          enemy: summarizeEntity(ref.enemy),
          playersCount: Array.isArray(ref.players) ? ref.players.length : null,
          helpers: {
            send: typeof ref.send === "function",
            sender: typeof ref.sender === "function",
            getDist: typeof ref.getDist === "function",
            getDir: typeof ref.getDir === "function"
          }
        }
      : null;
  };
  const summarizePvpRuntime = () => {
    const bot = window.pvpBot && typeof window.pvpBot === "object" ? window.pvpBot : null;
    const fighter = window.fighter && typeof window.fighter === "object" ? window.fighter : null;
    return {
      pvpBot: bot
        ? {
            inFight: !!bot.inFight,
            status: text(bot.status || "", 80),
            customIndicatorText: text(bot.customIndicatorText || "", 80),
            predictedPos: bot.predictedPos
              ? {
                  x: Number(bot.predictedPos.nx != null ? bot.predictedPos.nx : bot.predictedPos.x) || 0,
                  y: Number(bot.predictedPos.ny != null ? bot.predictedPos.ny : bot.predictedPos.y) || 0
                }
              : null,
            moveToPos: bot.moveToPos
              ? {
                  x: Number(bot.moveToPos.x != null ? bot.moveToPos.x : bot.moveToPos.nx) || 0,
                  y: Number(bot.moveToPos.y != null ? bot.moveToPos.y : bot.moveToPos.ny) || 0
                }
              : null,
            antiBot: bot.antiBot
              ? {
                  enabled: !!window.mod?.antiBot,
                  label: text(bot.antiBot.label || "", 80)
                }
              : null
          }
        : null,
      fighter: fighter
        ? {
            customAttackLoaded: typeof fighter._customAttackFn === "function",
            customAntiBotLoaded: typeof fighter._customAntiBotFn === "function",
            marks: Array.isArray(fighter.marks) ? fighter.marks.length : null
          }
        : null
    };
  };
  const collectMopeSnapshot = () => {
    const canvas = document.querySelector("canvas");
    const playerPos = window.modPlayerPos && typeof window.modPlayerPos === "object"
      ? {
          x: Number(window.modPlayerPos.x) || 0,
          y: Number(window.modPlayerPos.y) || 0
        }
      : null;
    return {
      host: location.host,
      hash: location.hash,
      title: document.title,
      online: navigator.onLine,
      playerPos,
      canvas: canvas
        ? {
            selector: toSelector(canvas),
            width: canvas.width,
            height: canvas.height,
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight
          }
        : null,
      modSettings: summarizeModSettings(),
      codeSlots: Object.values(CODE_SLOT_DEFS).map((entry) => summarizeCodeSlot(entry.id)),
      player: summarizeEntity(window.player),
      enemy: summarizeEntity(window.enemy),
      playersCount: Array.isArray(window.players) ? window.players.length : null,
      gameRef: summarizeGameRef(),
      pvpRuntime: summarizePvpRuntime()
    };
  };
  const defaultAreas = () => {
    const areas = ["console", "dom", "mope"];
    if (state.prefs.includeStorage) {
      areas.push("storage");
    }
    if (state.prefs.includePackets) {
      areas.push("packet");
    }
    return areas;
  };
  const buildContextSnapshot = async (areas) => {
    const wanted = new Set(Array.isArray(areas) && areas.length ? areas : defaultAreas());
    const snapshot = {
      capturedAt: nowIso(),
      page: {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        sessionActive: hasSession(),
        admin: isAdmin()
      }
    };
    if (wanted.has("console")) {
      snapshot.console = state.consoleEntries.slice(-40);
    }
    if (wanted.has("network")) {
      snapshot.network = state.networkEntries.slice(-28);
    }
    if (wanted.has("dom")) {
      snapshot.dom = collectDomSnapshot();
    }
    if (wanted.has("performance")) {
      snapshot.performance = collectPerformanceSnapshot();
    }
    if (wanted.has("storage") || wanted.has("application")) {
      snapshot.storage = await collectStorageSnapshot();
    }
    if (wanted.has("packet")) {
      snapshot.packet = collectPacketSnapshot();
    }
    if (wanted.has("mope") || wanted.has("runtime")) {
      snapshot.mope = collectMopeSnapshot();
    }
    state.lastContextAt = Date.now();
    state.lastContextChars = countContextChars(snapshot);
    state.lastContextAreas = Array.from(wanted);
    return snapshot;
  };
  const getStyleSubset = (node) => {
    try {
      const style = getComputedStyle(node);
      return {
        display: style.display,
        position: style.position,
        visibility: style.visibility,
        opacity: style.opacity,
        color: style.color,
        background: style.background,
        border: style.border,
        zIndex: style.zIndex
      };
    } catch {
      return null;
    }
  };
  const inspectSelector = (selector) => {
    const node = document.querySelector(String(selector || ""));
    if (!node) {
      return { ok: false, error: `Selector not found: ${selector}` };
    }
    return {
      ok: true,
      element: summarizeElement(node, state.prefs.includeSensitive),
      html: clip(node.outerHTML || "", 2000),
      style: getStyleSubset(node),
      parent: node.parentElement ? summarizeElement(node.parentElement, state.prefs.includeSensitive) : null,
      children: Array.from(node.children || []).slice(0, 10).map((child) => summarizeElement(child, state.prefs.includeSensitive))
    };
  };
  const ensureAutomation = (tool) => {
    if (!state.prefs.allowAutomation) {
      return { ok: false, error: `${tool} blocked because automation is disarmed.` };
    }
    return null;
  };
  const typeIntoElement = (node, value, append) => {
    const tag = String(node.tagName || "").toLowerCase();
    if (!["input", "textarea", "select"].includes(tag) && !node.isContentEditable) {
      return { ok: false, error: "Target is not typeable." };
    }
    const finalValue = append ? `${node.value || ""}${value}` : value;
    if ("value" in node) {
      const prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(node, finalValue);
      } else {
        node.value = finalValue;
      }
    } else if (node.isContentEditable) {
      node.textContent = finalValue;
    }
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, element: summarizeElement(node, state.prefs.includeSensitive) };
  };
  const SPECIAL_KEYCODES = {
    enter: 13,
    return: 13,
    escape: 27,
    esc: 27,
    space: 32,
    tab: 9,
    shift: 16,
    control: 17,
    ctrl: 17,
    alt: 18,
    arrowup: 38,
    arrowdown: 40,
    arrowleft: 37,
    arrowright: 39,
    w: 87,
    a: 65,
    s: 83,
    d: 68,
    e: 69,
    q: 81,
    z: 90,
    x: 88,
    i: 73,
    j: 74,
    k: 75,
    l: 76,
    p: 80,
    "1": 49,
    "2": 50,
    "3": 51,
    "4": 52
  };
  const getKeyCode = (key) => {
    const normalized = String(key || "").trim();
    if (!normalized) {
      return 0;
    }
    if (normalized.length === 1) {
      return normalized.toUpperCase().charCodeAt(0);
    }
    return SPECIAL_KEYCODES[normalized.toLowerCase()] || 0;
  };
  const getKeyboardCode = (key) => {
    const normalized = String(key || "").trim();
    if (!normalized) {
      return "";
    }
    if (normalized.length === 1) {
      const upper = normalized.toUpperCase();
      return /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : upper;
    }
    const map = {
      enter: "Enter",
      return: "Enter",
      escape: "Escape",
      esc: "Escape",
      space: "Space",
      tab: "Tab",
      shift: "ShiftLeft",
      control: "ControlLeft",
      ctrl: "ControlLeft",
      alt: "AltLeft",
      arrowup: "ArrowUp",
      arrowdown: "ArrowDown",
      arrowleft: "ArrowLeft",
      arrowright: "ArrowRight"
    };
    return map[normalized.toLowerCase()] || normalized;
  };
  const isDangerousAutomationKey = (key) => {
    const normalized = String(key || "").trim().toLowerCase();
    return [
      "f5",
      "browserrefresh",
      "browserback",
      "browserforward"
    ].includes(normalized);
  };
  const elementCouldNavigate = (node) => {
    if (!node || !(node instanceof Element)) {
      return false;
    }
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "a" && node.getAttribute("href")) {
      return true;
    }
    if (tag === "form") {
      return true;
    }
    const type = String(node.getAttribute("type") || "").toLowerCase();
    if ((tag === "button" || tag === "input") && ["submit", "image", "reset"].includes(type)) {
      return true;
    }
    if (typeof node.closest === "function" && node.closest("a[href], form")) {
      return true;
    }
    return false;
  };
  const scriptContainsNavigation = (script) => {
    const input = String(script || "");
    return /\b(location\s*\.\s*(reload|assign|replace|href)\s*=?)|\b(window\s*\.\s*location\b)|\b(window\s*\.\s*open\b)|\b(history\s*\.\s*(go|back|forward)\b)|\b(requestSubmit|submit)\s*\(/i.test(input);
  };
  const invokeKeyHandler = (type, key) => {
    const keyCode = getKeyCode(key);
    const code = getKeyboardCode(key);
    const eventLike = {
      key: String(key || ""),
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      prevented: false,
      stopPropagation() {},
      stopImmediatePropagation() {},
      preventDefault() {
        this.defaultPrevented = true;
        this.prevented = true;
      }
    };
    try {
      const handler = document[`on${type}`];
      if (typeof handler === "function") {
        handler.call(document, eventLike);
      }
    } catch {}
    try {
      const event = new KeyboardEvent(type, {
        key: String(key || ""),
        code,
        bubbles: true,
        cancelable: true
      });
      Object.defineProperty(event, "keyCode", { configurable: true, get: () => keyCode });
      Object.defineProperty(event, "which", { configurable: true, get: () => keyCode });
      document.dispatchEvent(event);
      window.dispatchEvent(event);
    } catch {}
    return { key: String(key || ""), code, keyCode };
  };
  const dispatchGameKey = async (args) => {
    const blocked = ensureAutomation("dispatch_key");
    if (blocked) {
      return blocked;
    }
    const key = String(args && (args.key || args.code) || "").trim();
    if (!key) {
      return { ok: false, error: "A key is required." };
    }
    if (isDangerousAutomationKey(key)) {
      return { ok: false, error: `Navigation key ${key} is blocked.` };
    }
    const mode = String(args && args.mode || "press").trim().toLowerCase();
    const repeat = Math.min(12, Math.max(1, Number(args && args.repeat) || 1));
    const holdMs = Math.min(3000, Math.max(0, Number(args && args.holdMs) || 0));
    const events = [];
    for (let index = 0; index < repeat; index += 1) {
      if (mode === "down") {
        events.push(invokeKeyHandler("keydown", key));
      } else if (mode === "up") {
        events.push(invokeKeyHandler("keyup", key));
      } else {
        events.push(invokeKeyHandler("keydown", key));
        if (holdMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, holdMs));
        }
        events.push(invokeKeyHandler("keyup", key));
      }
    }
    return {
      ok: true,
      mode,
      repeat,
      events
    };
  };
  const resolveCanvasPoint = (args) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) {
      return { ok: false, error: "Canvas not found." };
    }
    const rect = canvas.getBoundingClientRect();
    let clientX = Number(args && args.clientX);
    let clientY = Number(args && args.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      const normalizedX = Number(args && (args.nx != null ? args.nx : args.x));
      const normalizedY = Number(args && (args.ny != null ? args.ny : args.y));
      if (Number.isFinite(normalizedX) && Number.isFinite(normalizedY)) {
        clientX = rect.left + normalizedX * rect.width;
        clientY = rect.top + normalizedY * rect.height;
      } else {
        clientX = rect.left + rect.width / 2;
        clientY = rect.top + rect.height / 2;
      }
    }
    clientX = Math.max(rect.left + 1, Math.min(rect.right - 1, clientX));
    clientY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY));
    return {
      ok: true,
      canvas,
      rect,
      clientX,
      clientY
    };
  };
  const fireCanvasMouseEvent = (canvas, type, clientX, clientY, button = 0) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: button === 2 ? 2 : 1
    });
    canvas.dispatchEvent(event);
    return {
      type,
      clientX: Math.round(clientX),
      clientY: Math.round(clientY),
      button
    };
  };
  const dispatchCanvasPointer = async (args) => {
    const blocked = ensureAutomation("dispatch_canvas_pointer");
    if (blocked) {
      return blocked;
    }
    const target = resolveCanvasPoint(args);
    if (!target.ok) {
      return target;
    }
    const action = String(args && args.action || "click").trim().toLowerCase();
    const button = action === "rightclick" || Number(args && args.button) === 2 ? 2 : 0;
    const steps = [];
    steps.push(fireCanvasMouseEvent(target.canvas, "mousemove", target.clientX, target.clientY, button));
    if (action === "move") {
      return {
        ok: true,
        action,
        point: { x: Math.round(target.clientX), y: Math.round(target.clientY) },
        steps
      };
    }
    if (action === "down") {
      steps.push(fireCanvasMouseEvent(target.canvas, "mousedown", target.clientX, target.clientY, button));
    } else if (action === "up") {
      steps.push(fireCanvasMouseEvent(target.canvas, "mouseup", target.clientX, target.clientY, button));
    } else {
      steps.push(fireCanvasMouseEvent(target.canvas, "mousedown", target.clientX, target.clientY, button));
      await new Promise((resolve) => setTimeout(resolve, Math.min(300, Math.max(0, Number(args && args.delayMs) || 24))));
      steps.push(fireCanvasMouseEvent(target.canvas, "mouseup", target.clientX, target.clientY, button));
      if (action === "rightclick") {
        steps.push(fireCanvasMouseEvent(target.canvas, "contextmenu", target.clientX, target.clientY, button));
      }
    }
    return {
      ok: true,
      action,
      point: { x: Math.round(target.clientX), y: Math.round(target.clientY) },
      steps
    };
  };
  const executeTool = async (tool, args) => {
    try {
      switch (tool) {
        case "collect_context":
          return sanitizeToolPayload(await buildContextSnapshot(Array.isArray(args && args.areas) ? args.areas : defaultAreas()), tool);
        case "list_mod_settings":
          return sanitizeToolPayload(listModSettings(), tool);
        case "get_mod_setting":
          return sanitizeToolPayload(getModSetting(args && args.path), tool);
        case "set_mod_setting": {
          const blocked = ensureAutomation("set_mod_setting");
          if (blocked) {
            return blocked;
          }
          return sanitizeToolPayload(setModSetting(args && args.path, args && args.value), tool);
        }
        case "set_mod_settings": {
          const blocked = ensureAutomation("set_mod_settings");
          if (blocked) {
            return blocked;
          }
          return sanitizeToolPayload(setModSettings(args && args.updates), tool);
        }
        case "inspect_code_slot":
          return sanitizeToolPayload({
            ok: true,
            slot: summarizeCodeSlot(args && args.slot)
          }, tool);
        case "set_code_slot": {
          const blocked = ensureAutomation("set_code_slot");
          if (blocked) {
            return blocked;
          }
          return sanitizeToolPayload(applyCodeSlot(args && args.slot, args && args.code), tool);
        }
        case "clear_code_slot": {
          const blocked = ensureAutomation("clear_code_slot");
          if (blocked) {
            return blocked;
          }
          return sanitizeToolPayload(applyCodeSlot(args && args.slot, ""), tool);
        }
        case "list_dump_targets":
          return sanitizeToolPayload(listDumpTargets(args && args.query), tool);
        case "inspect_dump_target":
          return sanitizeToolPayload(inspectDumpTarget(args && (args.name || args.alias)), tool);
        case "inspect_selector":
          return sanitizeToolPayload(inspectSelector(args && args.selector), tool);
        case "focus_selector": {
          const blocked = ensureAutomation("focus_selector");
          if (blocked) {
            return blocked;
          }
          const node = document.querySelector(String(args && args.selector || ""));
          if (!node) {
            return { ok: false, error: "Selector not found." };
          }
          node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          if (typeof node.focus === "function") {
            node.focus({ preventScroll: true });
          }
          return sanitizeToolPayload({ ok: true, element: summarizeElement(node, state.prefs.includeSensitive) }, tool);
        }
        case "click_selector": {
          const blocked = ensureAutomation("click_selector");
          if (blocked) {
            return blocked;
          }
          const node = document.querySelector(String(args && args.selector || ""));
          if (!node) {
            return { ok: false, error: "Selector not found." };
          }
          if (elementCouldNavigate(node)) {
            return { ok: false, error: "Navigation-style clicks are blocked." };
          }
          node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          if (typeof node.click === "function") {
            node.click();
          }
          node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return sanitizeToolPayload({ ok: true, element: summarizeElement(node, state.prefs.includeSensitive) }, tool);
        }
        case "type_selector": {
          const blocked = ensureAutomation("type_selector");
          if (blocked) {
            return blocked;
          }
          const node = document.querySelector(String(args && args.selector || ""));
          if (!node) {
            return { ok: false, error: "Selector not found." };
          }
          return sanitizeToolPayload(typeIntoElement(node, String(args && args.text || ""), !!(args && args.append)), tool);
        }
        case "dispatch_key":
          return sanitizeToolPayload(await dispatchGameKey(args), tool);
        case "dispatch_canvas_pointer":
          return sanitizeToolPayload(await dispatchCanvasPointer(args), tool);
        case "run_script": {
          const blocked = ensureAutomation("run_script");
          if (blocked) {
            return blocked;
          }
          const script = String(args && args.script || "").trim();
          if (!script) {
            return { ok: false, error: "No script provided." };
          }
          if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(script)) {
            return { ok: false, error: "run_script network egress is blocked." };
          }
          if (scriptContainsNavigation(script)) {
            return { ok: false, error: "run_script navigation and reload actions are blocked." };
          }
          if (/Function\.prototype\.toString|__renderFunctionDumpRegistry|\.source\b|customPvpCode|customAntiBotCode|botCode/.test(script)) {
            return { ok: false, error: "run_script cannot access protected source fields." };
          }
          const fn = new AsyncFunction(script);
          const result = await fn.call(window);
          return sanitizeToolPayload({ ok: true, result: jsonSafe(result) }, tool);
        }
        default:
          return { ok: false, error: `Unsupported tool: ${tool}` };
      }
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  };
  const togglePref = (key) => {
    if (!(key in state.prefs)) {
      return;
    }
    state.prefs[key] = !state.prefs[key];
    saveState();
    notify(`${key.replace(/([A-Z])/g, " $1").trim()} ${state.prefs[key] ? "enabled" : "disabled"}.`, "info");
    renderIfVisible();
  };
  const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  const resizeImageFile = async (file) => {
    const raw = await fileToDataUrl(file);
    if (!raw) {
      return null;
    }
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = raw;
    });
    const ratio = Math.min(1, 1280 / Math.max(1, image.naturalWidth), 1280 / Math.max(1, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);
    let dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    if (dataUrl.length > MAX_IMAGE_BYTES) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    }
    if (dataUrl.length > MAX_IMAGE_BYTES) {
      throw new Error("Image is too large after compression.");
    }
    return {
      name: text(file.name || "attachment.jpg", 120),
      type: "image/jpeg",
      size: file.size || 0,
      width,
      height,
      dataUrl
    };
  };
  const handleAttachment = async (file) => {
    if (!file) {
      return;
    }
    if (!String(file.type || "").startsWith("image/")) {
      notify("Only image uploads are supported here.", "warn");
      return;
    }
    try {
      state.attachment = await resizeImageFile(file);
      saveState();
      notify("Image attached for the assistant.", "success");
      renderIfVisible();
    } catch (error) {
      notify(formatError(error), "error");
    }
  };
  const attachmentPayload = () => {
    if (!state.attachment) {
      return null;
    }
    return {
      name: state.attachment.name,
      type: state.attachment.type,
      size: state.attachment.size,
      width: state.attachment.width,
      height: state.attachment.height,
      preview: clip(state.attachment.dataUrl, 180),
      dataUrl: state.attachment.dataUrl
    };
  };
  const callAssistant = async (messages, context) => {
    let response = null;
    let directError = null;
    try {
      response = await directAssistantRequest(messages, context);
    } catch (error) {
      directError = error;
    }
    if (!response) {
      const api = bridge();
      let bridgeError = null;
      try {
        if (api && hasSession()) {
          response = await api.callApi("/ai/assistant", {
            messages,
            context,
            image: attachmentPayload()
          });
        }
      } catch (error) {
        bridgeError = error;
      }
      if (!response) {
        if (!bridgeError) {
          throw directError || new Error("Assistant request failed.");
        }
        if (!directError) {
          throw bridgeError;
        }
        const bridgeMessage = formatError(bridgeError);
        const directMessage = formatError(directError);
        if (/blocked endpoint|secure bridge unavailable|invalid session|no active session|session invalid/i.test(bridgeMessage)) {
          throw directError || bridgeError;
        }
        throw new Error(directMessage && directMessage !== bridgeMessage
          ? `${bridgeMessage} | fallback: ${directMessage}`
          : bridgeMessage);
      }
    }
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : "Assistant request failed.");
    }
    state.lastModel = text(response.model || "", 80);
    const output = response.output || null;
    if ((!output || !output.message) && response.rawMessage) {
      return { type: "final", message: clip(String(response.rawMessage || ""), 8000) || "No output." };
    }
    return output || { type: "final", message: "No output." };
  };
  const buildPromptContext = async () => {
    if (!state.prefs.autoContext) {
      const snapshot = {
        capturedAt: nowIso(),
        page: {
          href: location.href,
          title: document.title,
          sessionActive: hasSession(),
          admin: isAdmin()
        }
      };
      state.lastContextAt = Date.now();
      state.lastContextChars = countContextChars(snapshot);
      state.lastContextAreas = ["page"];
      return snapshot;
    }
    return buildContextSnapshot(defaultAreas());
  };
  const runAssistantLoop = async (prompt, presetContext = null) => {
    const trimmedPrompt = draftText(prompt, 4000).trim();
    if (!trimmedPrompt) {
      return;
    }
    if (!hasAssistantAccess()) {
      notify("Join an active admin session or re-enter your admin key first.", "warn");
      return;
    }
    state.pending = true;
    state.pendingLabel = "Collecting runtime context";
    renderIfVisible();
    pushConversation("user", trimmedPrompt);
    addFeed("user", trimmedPrompt, state.attachment ? `image attached | ${state.attachment.width}x${state.attachment.height}` : "live prompt");
    const messages = state.messages.slice(-12);
    let context = presetContext || await buildPromptContext();
    try {
      state.pendingLabel = "Calling AI backend";
      renderIfVisible();
      for (let step = 0; step < 6; step += 1) {
        const output = await callAssistant(messages, context);
        if (output && output.type === "tool") {
          state.pendingLabel = `Running ${output.tool}`;
          renderIfVisible();
          const meta = `${output.tool}${output.args ? ` | ${summarizeArgs(output.args)}` : ""}`;
          addFeed("tool", output.message || `Tool request: ${output.tool}`, meta);
          messages.push({ role: "assistant", content: clip(stable(output, 1800), 1800) });
          const toolResult = await executeTool(output.tool, output.args || {});
          const toolText = clip(stable(toolResult, 2600), 2600);
          addFeed("assistant", `Tool result for ${output.tool}`, toolResult && toolResult.ok === false ? "tool error" : "tool complete", {
            summary: [toolText]
          });
          messages.push({
            role: "user",
            content: `Tool result from ${output.tool}:\n${toolText}`
          });
          state.pendingLabel = "Refreshing live context";
          context = await buildPromptContext();
          continue;
        }
        const finalMessage = output && output.message ? output.message : "No response returned.";
        addFeed("assistant", finalMessage, state.lastModel || "assistant", {
          summary: Array.isArray(output && output.summary) ? output.summary : [],
          nextActions: Array.isArray(output && output.nextActions) ? output.nextActions : []
        });
        pushConversation("assistant", finalMessage);
        return;
      }
      addFeed("assistant", "Stopped after 6 tool iterations.", "loop guard");
    } catch (error) {
      addFeed("assistant", formatError(error), "request failed");
      notify(formatError(error), "error");
    } finally {
      state.pending = false;
      state.pendingLabel = "";
      saveState();
      renderIfVisible();
    }
  };
  const quickPrompt = async (prompt, areas) => {
    const context = await buildContextSnapshot(areas);
    const composer = document.getElementById("renderAiComposer");
    state.composerDraft = draftText(prompt, 8000);
    saveState();
    if (composer) {
      composer.value = state.composerDraft;
    }
    await runAssistantLoop(prompt, context);
    state.composerDraft = "";
    saveState();
    if (composer) {
      composer.value = "";
    }
  };
  const renderSummaryList = (items, className) => {
    if (!Array.isArray(items) || !items.length) {
      return "";
    }
    return `<div class="${className}">${items.map((item) => `<div>${esc(text(item, 260))}</div>`).join("")}</div>`;
  };
  const renderContextMeter = () => {
    const budget = describeContextBudget();
    const areaText = budget.areas.length ? budget.areas.join(", ") : "minimal page context";
    return `
      <div class="rai-context-chip" tabindex="0" role="note" aria-label="Context usage ${esc(budget.compact)}">
        <span class="rai-context-bar"><span style="width:${esc(String(Math.max(8, budget.percent)))}%"></span></span>
        <span class="rai-context-copy">Context ${esc(budget.compact)}</span>
        <div class="rai-context-pop">
          <strong>Context window</strong>
          <div>${esc(`${budget.percent}% used (${100 - budget.percent}% left)`)}</div>
          <div>${esc(`${formatCompactCount(budget.used)} chars used`)}</div>
          <div>${esc(`${formatCompactCount(budget.remaining)} chars left`)}</div>
          <div>${esc(`Areas: ${areaText}`)}</div>
        </div>
      </div>
    `;
  };
  const renderFeedMarkup = () => {
    const pendingMarkup = state.pending ? `
      <article class="rai-msg rai-msg-pending">
        <div class="rai-msg-head">
          <span class="rai-msg-role"><span class="rai-msg-icon">◌</span>Assistant</span>
          <span class="rai-msg-meta">${esc(state.pendingLabel || "thinking")}</span>
        </div>
        <div class="rai-thinking"><span></span><span></span><span></span></div>
        <div class="rai-msg-text">Reading live page state, collecting context, and preparing a response.</div>
        <div class="rai-msg-stage">Stage · ${esc(state.pendingLabel || "Thinking")}</div>
      </article>
    ` : "";
    if (!state.feed.length && !state.pending) {
      return `
        <div class="rai-empty">
          <strong>Ready.</strong>
          Ask it to inspect mope.io state, explain console errors, trace network failures, or automate a fix.
        </div>
      `;
    }
    return state.feed.map((entry) => {
      const roleLabel = entry.role === "user" ? "You" : entry.role === "tool" ? "Tool Loop" : "Assistant";
      const roleIcon = entry.role === "user" ? "◈" : entry.role === "tool" ? "◎" : "✦";
      return `
      <article class="rai-msg rai-msg-${esc(entry.role)}">
        <div class="rai-msg-head">
          <span class="rai-msg-role"><span class="rai-msg-icon">${esc(roleIcon)}</span>${esc(roleLabel)}</span>
          <span class="rai-msg-meta">${esc(entry.meta || "")}</span>
        </div>
        <div class="rai-msg-text">${esc(entry.text).replace(/\n/g, "<br>")}</div>
        ${renderSummaryList(entry.summary, "rai-summary")}
        ${renderSummaryList(entry.nextActions, "rai-next")}
      </article>
    `;
    }).join("") + pendingMarkup;
  };
  const renderAttachmentMarkup = () => {
    if (!state.attachment) {
      return "";
    }
    return `
      <div class="rai-attachment">
        <img src="${esc(state.attachment.dataUrl)}" alt="attachment preview">
        <div class="rai-attachment-copy">
          <strong>${esc(state.attachment.name)}</strong>
          <span>${esc(`${state.attachment.width}x${state.attachment.height} | ${(Math.round((state.attachment.size || 0) / 102.4) / 10)} KB`)}</span>
        </div>
        <button class="rai-button rai-button-secondary" data-rai-action="drop-attachment">Remove</button>
      </div>
    `;
  };
  const ensureStyle = () => {
    if (document.getElementById("renderAiAssistantStyle")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "renderAiAssistantStyle";
    style.textContent = `
#renderMenu .rai-shell{position:relative;display:grid;gap:16px;min-height:700px;padding:18px;border-radius:24px;background:linear-gradient(180deg, rgba(13,20,33,.98), rgba(8,13,23,.98));border:1px solid rgba(127,151,185,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 28px 56px rgba(0,0,0,.24);overflow:hidden}
#renderMenu .rai-shell::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at top left, rgba(216,173,92,.07), transparent 32%),radial-gradient(circle at bottom right, rgba(92,140,216,.08), transparent 34%);pointer-events:none}
#renderMenu .rai-hero{position:relative;display:grid;grid-template-columns:minmax(220px, 280px) 1fr;gap:16px;align-items:stretch}
#renderMenu .rai-robot-card,#renderMenu .rai-panel,#renderMenu .rai-feed-card,#renderMenu .rai-composer{position:relative;border-radius:22px;background:linear-gradient(180deg, rgba(16,24,38,.96), rgba(10,15,25,.98));border:1px solid rgba(124,145,176,.14);box-shadow:0 14px 28px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.04)}
#renderMenu .rai-robot-card{overflow:hidden;padding:18px;display:grid;grid-template-rows:1fr auto;gap:14px;min-height:238px}
#renderMenu .rai-robot-card::after{content:"";position:absolute;inset:auto 16px 16px 16px;height:1px;background:linear-gradient(90deg, transparent, rgba(212,181,115,.28), transparent)}
#renderMenu .rai-robot{position:relative;width:156px;height:170px;display:grid;place-items:center;margin:auto}
#renderMenu .rai-robot-orbit,#renderMenu .rai-robot-orbit::before,#renderMenu .rai-robot-orbit::after{position:absolute;inset:18px;border-radius:999px;border:1px solid rgba(181,160,119,.12);animation:raiOrbit 18s linear infinite}
#renderMenu .rai-robot-orbit::before,#renderMenu .rai-robot-orbit::after{content:"";inset:-12px}
#renderMenu .rai-robot-orbit::after{animation-duration:11s;animation-direction:reverse}
#renderMenu .rai-robot-head{position:relative;width:112px;height:120px;border-radius:28px 28px 34px 34px;background:linear-gradient(180deg, rgba(34,49,72,.98), rgba(20,30,46,.98));border:1px solid rgba(191,172,133,.2);box-shadow:0 0 0 1px rgba(255,255,255,.03) inset,0 18px 30px rgba(0,0,0,.2)}
#renderMenu .rai-robot-head::before{content:"";position:absolute;left:50%;top:-22px;width:4px;height:24px;margin-left:-2px;border-radius:999px;background:linear-gradient(180deg, rgba(216,192,142,.9), rgba(92,140,216,.25))}
#renderMenu .rai-robot-head::after{content:"";position:absolute;left:50%;top:-33px;width:14px;height:14px;margin-left:-7px;border-radius:999px;background:#d7bb7f;box-shadow:0 0 16px rgba(215,187,127,.26);animation:raiPulse 2.6s ease-in-out infinite}
#renderMenu .rai-robot-face{position:absolute;inset:16px 12px 20px;border-radius:22px;background:linear-gradient(180deg, rgba(8,14,24,.96), rgba(11,17,27,.98));border:1px solid rgba(122,145,182,.16);overflow:hidden}
#renderMenu .rai-robot-face::before{content:"";position:absolute;inset:auto -30% 18px -30%;height:2px;background:linear-gradient(90deg, transparent, rgba(214,186,122,.65), transparent);box-shadow:0 0 12px rgba(214,186,122,.22);animation:raiScan 4.6s ease-in-out infinite}
#renderMenu .rai-eyes{position:absolute;top:35px;left:18px;right:18px;display:flex;justify-content:space-between}
#renderMenu .rai-eye{width:24px;height:16px;border-radius:999px;background:linear-gradient(90deg, rgba(120,174,232,.58), rgba(218,238,255,.9));animation:raiBlink 4.8s infinite}
#renderMenu .rai-mouth{position:absolute;left:50%;bottom:24px;width:54px;height:7px;margin-left:-27px;border-radius:999px;background:linear-gradient(90deg, rgba(214,186,122,.1), rgba(214,186,122,.82), rgba(214,186,122,.1))}
#renderMenu .rai-copy{display:grid;gap:12px;padding:18px 20px}
#renderMenu .rai-copy-top,#renderMenu .rai-feed-head,#renderMenu .rai-compose-head,#renderMenu .rai-msg-head,#renderMenu .rai-status-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
#renderMenu .rai-copy-side,#renderMenu .rai-feed-side,#renderMenu .rai-compose-side{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#renderMenu .rai-kicker{display:inline-flex;align-items:center;gap:8px;width:max-content;padding:7px 12px;border-radius:999px;background:rgba(32,44,65,.92);border:1px solid rgba(175,154,116,.2);color:#e7d2a0;font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}
#renderMenu .rai-kicker-dot{width:8px;height:8px;border-radius:999px;background:#d6b46e;box-shadow:0 0 0 4px rgba(214,180,110,.12)}
#renderMenu .rai-model-chip{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;background:rgba(18,27,42,.9);border:1px solid rgba(124,145,176,.16);color:rgba(228,235,245,.82);font-size:11px;font-weight:800}
#renderMenu .rai-title{font-size:30px;line-height:1.04;font-weight:900;letter-spacing:-.04em;color:#f3f6fb;text-wrap:balance;max-width:820px}
#renderMenu .rai-title span{display:block;color:#cdd7e6}
#renderMenu .rai-copy p{margin:0;max-width:820px;color:rgba(222,228,238,.76);font-size:13px;line-height:1.7}
#renderMenu .rai-pill-row,#renderMenu .rai-toolbar,#renderMenu .rai-actions,#renderMenu .rai-head-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
#renderMenu .rai-pill{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border-radius:14px;border:1px solid rgba(124,145,176,.14);background:rgba(17,24,37,.92);color:#e6edf7;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
#renderMenu .rai-pill b{color:#f0d69d;font-weight:900}
#renderMenu .rai-status-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}
#renderMenu .rai-status-card{padding:16px;border-radius:22px;background:linear-gradient(180deg, rgba(16,24,38,.96), rgba(10,15,25,.98));border:1px solid rgba(124,145,176,.14);box-shadow:0 14px 28px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.04)}
#renderMenu .rai-status-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
#renderMenu .rai-status-title{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#dbe4f0;font-weight:900}
#renderMenu .rai-status-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid rgba(124,145,176,.16);background:rgba(18,26,39,.94);color:#eff5fc;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}
#renderMenu .rai-status-dot{width:8px;height:8px;border-radius:999px;background:#7fb598;box-shadow:0 0 0 4px rgba(127,181,152,.12)}
#renderMenu .rai-status-pill.is-busy .rai-status-dot{background:#d9b068;box-shadow:0 0 0 4px rgba(217,176,104,.14);animation:raiPulse 1.5s ease-in-out infinite}
#renderMenu .rai-status-copy{font-size:12px;line-height:1.7;color:rgba(226,233,242,.76)}
#renderMenu .rai-status-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
#renderMenu .rai-status-metric{padding:12px;border-radius:16px;border:1px solid rgba(124,145,176,.12);background:rgba(14,21,32,.94)}
#renderMenu .rai-status-metric b{display:block;font-size:18px;line-height:1;color:#f2f6fb;font-weight:900;margin-bottom:6px}
#renderMenu .rai-status-metric span{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(220,227,236,.6);font-weight:900}
#renderMenu .rai-grid{display:grid;grid-template-columns:1.08fr .92fr;gap:16px}
#renderMenu .rai-panel{padding:16px}
#renderMenu .rai-panel h3,#renderMenu .rai-feed-head h3,#renderMenu .rai-compose-head h3{margin:0;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#dbe4f0;font-weight:900}
#renderMenu .rai-quick-grid,#renderMenu .rai-toggle-grid,#renderMenu .rai-feed{display:grid;gap:10px}
#renderMenu .rai-quick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
#renderMenu button.rai-quick,#renderMenu button.rai-toggle,#renderMenu button.rai-button{appearance:none;-webkit-appearance:none;font:inherit;text-align:left;text-transform:none;letter-spacing:normal}
#renderMenu .rai-quick{display:grid;align-content:start;gap:10px;min-height:144px;width:100%;padding:14px;border-radius:16px;border:1px solid rgba(124,145,176,.12);background:linear-gradient(180deg, rgba(18,28,43,.96), rgba(12,18,28,.98));cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease,background .16s ease;box-sizing:border-box}
#renderMenu .rai-quick:hover{transform:translateY(-1px);border-color:rgba(182,159,118,.28);box-shadow:0 10px 20px rgba(0,0,0,.14);background:linear-gradient(180deg, rgba(21,31,46,.98), rgba(13,20,31,.98))}
#renderMenu .rai-quick strong{display:block;font-size:13px;line-height:1.28;color:#f4f7fb;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
#renderMenu .rai-quick span,#renderMenu .rai-toggle-copy span,#renderMenu .rai-feed-head span,#renderMenu .rai-compose-head span,#renderMenu .rai-empty,#renderMenu .rai-msg-meta,#renderMenu .rai-summary div,#renderMenu .rai-next div,#renderMenu .rai-attachment-copy span,#renderMenu .rai-msg-stage{font-size:11px;line-height:1.55;color:rgba(219,227,236,.66)}
#renderMenu .rai-toggle-grid{grid-template-columns:1fr}
#renderMenu .rai-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;width:100%;min-height:96px;padding:14px 16px;border-radius:18px;border:1px solid rgba(124,145,176,.12);background:linear-gradient(180deg, rgba(14,22,34,.98), rgba(10,16,26,.98));cursor:pointer;box-sizing:border-box;transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease}
#renderMenu .rai-toggle:hover{transform:translateY(-1px);border-color:rgba(182,159,118,.22);box-shadow:0 10px 22px rgba(0,0,0,.14)}
#renderMenu .rai-toggle-copy{display:grid;gap:5px;min-width:0}
#renderMenu .rai-toggle-copy strong,#renderMenu .rai-msg-role,#renderMenu .rai-attachment-copy strong{font-size:12px;line-height:1.2;color:#f3f7fb;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
#renderMenu .rai-toggle-meta{display:grid;justify-items:end;gap:8px}
#renderMenu .rai-toggle-state{display:inline-flex;align-items:center;justify-content:center;min-width:54px;height:24px;padding:0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.04);color:rgba(229,236,244,.74);font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}
#renderMenu .rai-switch{position:relative;width:50px;height:29px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);transition:background .18s ease,border-color .18s ease}
#renderMenu .rai-switch::after{content:"";position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:999px;background:#f2f6fb;transition:transform .18s ease;box-shadow:0 4px 10px rgba(0,0,0,.22)}
#renderMenu .rai-toggle.active .rai-switch{background:linear-gradient(90deg, rgba(104,147,208,.95), rgba(214,182,118,.88));border-color:rgba(214,182,118,.34)}
#renderMenu .rai-toggle.active .rai-switch::after{transform:translateX(21px)}
#renderMenu .rai-toggle.active .rai-toggle-state{background:rgba(214,182,118,.1);border-color:rgba(214,182,118,.18);color:#edd39c}
#renderMenu .rai-feed-card{padding:16px;min-height:420px;display:grid;grid-template-rows:auto 1fr}
#renderMenu .rai-feed-head,#renderMenu .rai-compose-head,#renderMenu .rai-msg-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
#renderMenu .rai-feed{min-height:280px;max-height:680px;overflow:auto;padding-right:2px}
#renderMenu .rai-empty{display:grid;place-items:center;text-align:center;padding:28px;border-radius:18px;border:1px dashed rgba(124,145,176,.18);background:rgba(255,255,255,.02)}
#renderMenu .rai-msg{padding:15px 16px;border-radius:18px;border:1px solid rgba(124,145,176,.1);background:linear-gradient(180deg, rgba(17,25,38,.98), rgba(12,18,28,.99));box-shadow:inset 3px 0 0 rgba(124,145,176,.16)}
#renderMenu .rai-msg-user{border-color:rgba(100,144,206,.16);background:linear-gradient(180deg, rgba(16,30,49,.98), rgba(9,18,31,.98));box-shadow:inset 3px 0 0 rgba(108,152,212,.55)}
#renderMenu .rai-msg-tool{border-color:rgba(212,176,104,.16);background:linear-gradient(180deg, rgba(40,30,17,.98), rgba(20,16,10,.99));box-shadow:inset 3px 0 0 rgba(212,176,104,.62)}
#renderMenu .rai-msg-pending{border-color:rgba(212,176,104,.18);background:linear-gradient(180deg, rgba(34,28,18,.98), rgba(18,14,10,.99));box-shadow:inset 3px 0 0 rgba(212,176,104,.58)}
#renderMenu .rai-msg-head{margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em}
#renderMenu .rai-msg-role{display:inline-flex;align-items:center;gap:8px}
#renderMenu .rai-msg-icon{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);font-size:10px;color:#ebf1f8}
#renderMenu .rai-msg-text{font-size:12px;line-height:1.74;color:#edf2f8;white-space:normal;overflow-wrap:anywhere}
#renderMenu .rai-msg-stage{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
#renderMenu .rai-thinking{display:flex;align-items:center;gap:7px;margin:4px 0 10px}
#renderMenu .rai-thinking span{width:9px;height:9px;border-radius:999px;background:linear-gradient(180deg, #e3c98c, #c89b49);animation:raiThinking 1.15s ease-in-out infinite}
#renderMenu .rai-thinking span:nth-child(2){animation-delay:.12s}
#renderMenu .rai-thinking span:nth-child(3){animation-delay:.24s}
#renderMenu .rai-summary,#renderMenu .rai-next{display:grid;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
#renderMenu .rai-summary div,#renderMenu .rai-next div{padding-left:14px;position:relative}
#renderMenu .rai-summary div::before,#renderMenu .rai-next div::before{content:"";position:absolute;left:0;top:.58em;width:6px;height:6px;border-radius:999px;background:#d2b173}
#renderMenu .rai-composer{padding:16px;display:grid;gap:12px}
#renderMenu .rai-composer textarea{position:relative;z-index:2;width:100%;min-height:142px;resize:vertical;border-radius:18px;border:1px solid rgba(124,145,176,.14);background:rgba(8,13,22,.96);color:#f5f7fb;padding:16px 17px;box-sizing:border-box;font:500 14px/1.6 'Segoe UI',system-ui,Arial,sans-serif;outline:none;transition:border-color .18s ease, box-shadow .18s ease, background .18s ease;pointer-events:auto;user-select:text}
#renderMenu .rai-composer textarea:focus{border-color:rgba(182,159,118,.34);box-shadow:0 0 0 3px rgba(182,159,118,.08);background:rgba(10,16,26,.98)}
#renderMenu .rai-composer textarea::placeholder{color:rgba(210,220,232,.38)}
#renderMenu .rai-attachment{display:flex;align-items:center;gap:12px;padding:10px;border-radius:16px;border:1px solid rgba(124,145,176,.14);background:rgba(14,21,32,.94)}
#renderMenu .rai-attachment img{width:72px;height:72px;object-fit:cover;border-radius:12px;border:1px solid rgba(124,145,176,.16)}
#renderMenu .rai-button{display:inline-flex;align-items:center;gap:8px;justify-content:center;min-height:42px;padding:0 16px;border:none;border-radius:14px;background:linear-gradient(180deg, rgba(83,139,212,.96), rgba(72,119,190,.96));color:#f7fbff;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:transform .16s ease, box-shadow .16s ease, filter .16s ease}
#renderMenu .rai-button:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(54,92,145,.18)}
#renderMenu .rai-button:disabled{filter:grayscale(.12) brightness(.86);cursor:wait;transform:none}
#renderMenu .rai-button-secondary{background:rgba(19,27,41,.96);color:#edf3fb;border:1px solid rgba(124,145,176,.16)}
#renderMenu .rai-actions input[type="file"]{display:none}
#renderMenu .rai-context-chip{position:relative;display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:12px;background:rgba(18,27,41,.94);border:1px solid rgba(124,145,176,.14);cursor:default;color:#e6edf7;font-size:11px;font-weight:800}
#renderMenu .rai-context-bar{position:relative;width:46px;height:7px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
#renderMenu .rai-context-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg, rgba(102,147,209,.96), rgba(215,183,118,.96))}
#renderMenu .rai-context-copy{white-space:nowrap}
#renderMenu .rai-context-pop{position:absolute;right:0;top:calc(100% + 10px);width:220px;padding:12px 13px;border-radius:14px;background:rgba(56,62,52,.96);border:1px solid rgba(255,255,255,.06);box-shadow:0 18px 32px rgba(0,0,0,.24);color:#f3f3ee;font-size:11px;line-height:1.55;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .16s ease,transform .16s ease;z-index:12}
#renderMenu .rai-context-pop strong{display:block;margin-bottom:6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#fff}
#renderMenu .rai-context-chip:hover .rai-context-pop,#renderMenu .rai-context-chip:focus-within .rai-context-pop{opacity:1;transform:translateY(0)}
@keyframes raiOrbit{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes raiPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:.7}}
@keyframes raiScan{0%,100%{transform:translateY(0)}50%{transform:translateY(-34px)}}
@keyframes raiBlink{0%,44%,100%{transform:scaleY(1)}46%,48%{transform:scaleY(.18)}}
@keyframes raiThinking{0%,100%{transform:translateY(0) scale(1);opacity:.58}50%{transform:translateY(-4px) scale(1.08);opacity:1}}
@media (max-width:1220px){#renderMenu .rai-hero,#renderMenu .rai-grid{grid-template-columns:1fr}}
@media (max-width:980px){#renderMenu .rai-status-grid{grid-template-columns:1fr}#renderMenu .rai-status-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:820px){#renderMenu .rai-shell{padding:12px;border-radius:18px}#renderMenu .rai-title{font-size:24px}#renderMenu .rai-quick-grid{grid-template-columns:1fr}#renderMenu .rai-status-metrics{grid-template-columns:1fr}#renderMenu .rai-copy-top,#renderMenu .rai-feed-head,#renderMenu .rai-compose-head{flex-direction:column;align-items:flex-start}}
`;
    document.head.appendChild(style);
  };
  const renderMarkup = () => {
    const consoleCount = state.consoleEntries.length;
    const networkCount = state.networkEntries.length;
    const packetCount = window.menu && window.menu.packetAnalyzer && Array.isArray(window.menu.packetAnalyzer.records)
      ? window.menu.packetAnalyzer.records.length
      : 0;
    const statusText = !hasSession() ? "Admin session missing" : state.pending ? "Thinking..." : state.lastModel ? `Connected to ${state.lastModel}` : "Bridge armed";
    const pendingDetail = state.pendingLabel || "Analyzing live context";
    return `
      <div class="rai-shell">
        <section class="rai-hero">
          <div class="rai-robot-card">
            <div class="rai-robot"><div class="rai-robot-orbit"></div><div class="rai-robot-head"><div class="rai-robot-face"><div class="rai-eyes"><span class="rai-eye"></span><span class="rai-eye"></span></div><div class="rai-mouth"></div></div></div></div>
            <div class="rai-robot-foot"><strong>Tactical Assistant</strong><span>Live runtime guidance, controlled automation, and guarded combat tuning.</span></div>
          </div>
          <div class="rai-panel rai-copy">
            <div class="rai-copy-top">
              <div class="rai-copy-side">
                <span class="rai-kicker"><span class="rai-kicker-dot"></span>Assistant Surface</span>
                <span class="rai-model-chip">${esc(state.lastModel || "GLM bridge")}</span>
              </div>
              <div class="rai-head-actions">${renderContextMeter()}</div>
            </div>
            <div class="rai-title">Combat-ready runtime control <span>with cleaner chat, sharper tools, and full live visibility.</span></div>
            <p>Inspect page state, tune PvP or visuals, trace failures, and drive controlled actions without the neon AI demo look. The panel stays practical, readable, and aligned with the rest of the menu.</p>
            <div class="rai-pill-row">
              <div class="rai-pill">session <b>${esc(hasSession() ? "active" : "missing")}</b></div>
              <div class="rai-pill">admin <b>${esc(isAdmin() ? "yes" : "no")}</b></div>
              <div class="rai-pill">console <b>${esc(consoleCount)}</b></div>
              <div class="rai-pill">network <b>${esc(networkCount)}</b></div>
              <div class="rai-pill">packets <b>${esc(packetCount)}</b></div>
            </div>
          </div>
        </section>
        <section class="rai-status-grid">
          <div class="rai-status-card">
            <div class="rai-status-head">
              <div class="rai-status-title">Assistant Status</div>
              <div class="rai-status-pill ${state.pending ? "is-busy" : ""}"><span class="rai-status-dot"></span>${esc(statusText)}</div>
            </div>
            <div class="rai-status-copy">${esc(state.pending ? pendingDetail : "Ready for debugging, runtime inspection, network tracing, and controlled automation.").replace(/\n/g, "<br>")}</div>
          </div>
          <div class="rai-status-card">
            <div class="rai-status-head">
              <div class="rai-status-title">Live Surface</div>
            </div>
            <div class="rai-status-metrics">
              <div class="rai-status-metric"><b>${esc(String(consoleCount))}</b><span>Console Events</span></div>
              <div class="rai-status-metric"><b>${esc(String(networkCount))}</b><span>Network Records</span></div>
              <div class="rai-status-metric"><b>${esc(String(packetCount))}</b><span>Packet Events</span></div>
            </div>
          </div>
        </section>
        <section class="rai-grid">
          <div class="rai-panel">
            <h3>Quick Ops</h3>
            <div class="rai-quick-grid">
              <button class="rai-quick" data-rai-quick="analyze"><strong>Analyze Current State</strong><span>Collect live context from the page and explain what is happening right now.</span></button>
              <button class="rai-quick" data-rai-quick="errors"><strong>Explain Recent Errors</strong><span>Focus on recent console faults, failed requests, and packet state problems.</span></button>
              <button class="rai-quick" data-rai-quick="optimize"><strong>Optimize mope.io Flow</strong><span>Inspect current game state and suggest latency, input, or render improvements.</span></button>
              <button class="rai-quick" data-rai-quick="network"><strong>Trace Network Issues</strong><span>Look at fetch/XHR traffic, status codes, and request previews.</span></button>
            </div>
          </div>
          <div class="rai-panel">
            <h3>Control Surface</h3>
            <div class="rai-toggle-grid">
              <button class="rai-toggle ${state.prefs.autoContext ? "active" : ""}" data-rai-toggle="autoContext" role="switch" aria-checked="${state.prefs.autoContext ? "true" : "false"}" aria-pressed="${state.prefs.autoContext ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Auto Context</strong><span>Send fresh page context on every prompt.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.autoContext ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
              <button class="rai-toggle ${state.prefs.includeStorage ? "active" : ""}" data-rai-toggle="includeStorage" role="switch" aria-checked="${state.prefs.includeStorage ? "true" : "false"}" aria-pressed="${state.prefs.includeStorage ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Application Data</strong><span>Include storage, cookies, caches, and IndexedDB names.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.includeStorage ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
              <button class="rai-toggle ${state.prefs.includePackets ? "active" : ""}" data-rai-toggle="includePackets" role="switch" aria-checked="${state.prefs.includePackets ? "true" : "false"}" aria-pressed="${state.prefs.includePackets ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Packet Analyzer</strong><span>Send recent packet analyzer state and decoded event summaries.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.includePackets ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
              <button class="rai-toggle ${state.prefs.includeSensitive ? "active" : ""}" data-rai-toggle="includeSensitive" role="switch" aria-checked="${state.prefs.includeSensitive ? "true" : "false"}" aria-pressed="${state.prefs.includeSensitive ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Sensitive Values</strong><span>Allow fuller storage and input value previews.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.includeSensitive ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
              <button class="rai-toggle ${state.prefs.allowAutomation ? "active" : ""}" data-rai-toggle="allowAutomation" role="switch" aria-checked="${state.prefs.allowAutomation ? "true" : "false"}" aria-pressed="${state.prefs.allowAutomation ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Automation Armed</strong><span>Permit clicks, typing, live mod edits, game key/pointer control, and guarded scripts.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.allowAutomation ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
            </div>
          </div>
        </section>
        <section class="rai-feed-card">
          <div class="rai-feed-head">
            <div>
              <h3>Assistant Feed</h3>
              <span>Full conversation, tool results, and current thinking state.</span>
            </div>
            <div class="rai-feed-side">
              ${renderContextMeter()}
              <span>${esc(statusText)}</span>
            </div>
          </div>
          <div class="rai-feed" id="renderAiFeed">${renderFeedMarkup()}</div>
        </section>
        <section class="rai-composer">
          <div class="rai-compose-head">
            <div>
              <h3>Prompt + Tools</h3>
              <span>${esc(state.attachment ? "image attached" : "text only")}</span>
            </div>
            <div class="rai-compose-side">
              <span>${esc(state.pending ? pendingDetail : "Shift+Enter for a new line.")}</span>
            </div>
          </div>
          ${renderAttachmentMarkup()}
          <textarea id="renderAiComposer" placeholder="Ask it to debug the page, inspect a selector, analyze recent errors, automate a click flow, or explain mope.io state." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(state.composerDraft || "")}</textarea>
          <div class="rai-toolbar">
            <button class="rai-button rai-button-secondary" data-rai-action="snapshot">Collect Snapshot</button>
            <button class="rai-button rai-button-secondary" data-rai-action="clear">Clear Feed</button>
            <button class="rai-button rai-button-secondary" data-rai-action="upload">Upload Image</button>
            <button class="rai-button" data-rai-action="send" ${state.pending ? "disabled" : ""}>${state.pending ? "AI Thinking..." : "Send Prompt"}</button>
          </div>
          <div class="rai-actions"><input id="renderAiFileInput" type="file" accept="image/*"></div>
        </section>
      </div>
    `;
  };
  const bindUi = (menu) => {
    const composer = menu.querySelector("#renderAiComposer");
    const stopUiPropagation = (event) => {
      event.stopPropagation();
    };
    const armInteractiveNode = (node, keyboardOnly = false) => {
      if (!node) {
        return;
      }
      if (!keyboardOnly) {
        ["pointerdown", "mousedown", "mouseup", "click", "dblclick"].forEach((type) => {
          node.addEventListener(type, stopUiPropagation, true);
        });
      }
      ["keydown", "keypress", "keyup", "input", "change", "focus"].forEach((type) => {
        node.addEventListener(type, stopUiPropagation, true);
      });
    };
    const bindPressAction = (node, handler) => {
      if (!node) {
        return;
      }
      const wrapped = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await handler(event);
      };
      node.addEventListener("click", wrapped, true);
      node.addEventListener("keydown", async (event) => {
        if (event.key === "Enter" || event.key === " ") {
          await wrapped(event);
        }
      }, true);
    };
    const runComposerPrompt = async () => {
      const draft = composer ? composer.value : "";
      state.composerDraft = draftText(draft, 8000);
      saveState();
      if (!state.composerDraft.trim()) {
        notify("Enter a prompt first.", "warn");
        return;
      }
      await runAssistantLoop(draft);
      state.composerDraft = "";
      saveState();
      if (composer) {
        composer.value = "";
      }
    };
    armInteractiveNode(composer);
    if (composer) {
      composer.readOnly = false;
      composer.disabled = false;
      composer.style.pointerEvents = "auto";
      composer.style.userSelect = "text";
      composer.value = state.composerDraft || "";
      composer.addEventListener("input", () => {
        state.composerDraft = draftText(composer.value, 8000);
        saveState();
      });
    }
    menu.querySelectorAll("[data-rai-toggle]").forEach((node) => {
      armInteractiveNode(node);
      bindPressAction(node, async () => {
        if (state.pending) {
          return;
        }
        togglePref(node.getAttribute("data-rai-toggle"));
      });
    });
    menu.querySelectorAll("[data-rai-quick]").forEach((node) => {
      armInteractiveNode(node);
      bindPressAction(node, async () => {
        if (state.pending) {
          return;
        }
        const mode = node.getAttribute("data-rai-quick");
        if (mode === "analyze") await quickPrompt("Analyze the current mope.io page state. Explain key issues, risks, and the best next debugging step.", defaultAreas());
        else if (mode === "errors") await quickPrompt("Focus on recent errors. Explain the likely root cause and exactly what should be inspected next.", ["console", "network", "dom", "packet", "mope"]);
        else if (mode === "optimize") await quickPrompt("Inspect the current mope.io runtime and recommend optimizations for responsiveness, rendering, and automation reliability.", ["console", "network", "performance", "packet", "mope", "dom"]);
        else if (mode === "network") await quickPrompt("Trace recent network activity and explain failed or suspicious requests, latency issues, and likely causes.", ["network", "console", "performance", "mope"]);
      });
    });
    const fileInput = menu.querySelector("#renderAiFileInput");
    armInteractiveNode(fileInput);
    menu.querySelectorAll("[data-rai-action]").forEach((node) => armInteractiveNode(node));
    bindPressAction(menu.querySelector("[data-rai-action='upload']"), async () => {
      if (state.pending) {
        return;
      }
      if (fileInput) {
        fileInput.click();
      }
    });
    fileInput?.addEventListener("change", async (event) => {
      const file = event.target && event.target.files && event.target.files[0] ? event.target.files[0] : null;
      event.target.value = "";
      await handleAttachment(file);
    });
    bindPressAction(menu.querySelector("[data-rai-action='drop-attachment']"), async () => {
      state.attachment = null;
      saveState();
      renderIfVisible();
    });
    bindPressAction(menu.querySelector("[data-rai-action='clear']"), async () => {
      if (state.pending) {
        return;
      }
      state.feed = [];
      state.messages = [];
      saveState();
      renderIfVisible();
    });
    bindPressAction(menu.querySelector("[data-rai-action='snapshot']"), async () => {
      if (state.pending) {
        return;
      }
      try {
        const snapshot = await buildContextSnapshot(defaultAreas());
        addFeed("assistant", "Fresh context snapshot collected.", "snapshot", { summary: [clip(stable(snapshot, 2400), 2400)] });
      } catch (error) {
        notify(formatError(error), "error");
      }
    });
    bindPressAction(menu.querySelector("[data-rai-action='send']"), runComposerPrompt);
    composer?.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        await runComposerPrompt();
      }
    });
    const feed = menu.querySelector("#renderAiFeed");
    if (feed) {
      feed.scrollTop = feed.scrollHeight;
    }
  };
  const ensureTab = () => {
    const menu = document.getElementById("renderMenu");
    const sidebar = menu && menu.querySelector(".menu-sidebar");
    if (!menu || !sidebar) {
      return false;
    }
    let tab = sidebar.querySelector(`.menu-tab[data-tab="${TAB_ID}"]`);
    if (!tab) {
      tab = document.createElement("div");
      tab.className = `menu-tab ${window.menu && window.menu.currentTab === TAB_ID ? "active" : ""}`;
      tab.dataset.tab = TAB_ID;
      tab.innerHTML = TAB_HTML;
      const botsTab = sidebar.querySelector('.menu-tab[data-tab="bots"]');
      if (botsTab && botsTab.nextSibling) sidebar.insertBefore(tab, botsTab.nextSibling);
      else if (botsTab) sidebar.appendChild(tab);
      else sidebar.appendChild(tab);
    }
    tab.classList.toggle("active", window.menu && window.menu.currentTab === TAB_ID);
    return true;
  };
  const renderTab = () => {
    const menu = document.getElementById("renderMenu");
    const contentArea = menu && menu.querySelector("#menuContentArea");
    if (!menu || !contentArea) {
      return;
    }
    ensureStyle();
    contentArea.innerHTML = renderMarkup();
    bindUi(contentArea);
  };
  const renderIfVisible = () => {
    const menu = document.getElementById("renderMenu");
    if (!menu || !window.menu || window.menu.currentTab !== TAB_ID) {
      return;
    }
    const activeElement = document.activeElement;
    const previousComposer = menu.querySelector("#renderAiComposer");
    const shouldRestoreComposer = !!(previousComposer && activeElement === previousComposer);
    const composerState = previousComposer ? {
      value: previousComposer.value,
      selectionStart: typeof previousComposer.selectionStart === "number" ? previousComposer.selectionStart : null,
      selectionEnd: typeof previousComposer.selectionEnd === "number" ? previousComposer.selectionEnd : null,
      scrollTop: previousComposer.scrollTop || 0
    } : null;
    if (composerState) {
      state.composerDraft = draftText(composerState.value, 8000);
    }
    renderTab();
    if (shouldRestoreComposer) {
      const nextComposer = menu.querySelector("#renderAiComposer");
      if (nextComposer) {
        nextComposer.focus({ preventScroll: true });
        nextComposer.value = state.composerDraft || "";
        if (composerState && composerState.selectionStart != null && composerState.selectionEnd != null) {
          try {
            nextComposer.setSelectionRange(composerState.selectionStart, composerState.selectionEnd);
          } catch {}
        }
        nextComposer.scrollTop = composerState ? composerState.scrollTop : 0;
      }
    }
  };
  const installMenuHook = () => {
    if (!window.menu || typeof window.menu.renderTabContent !== "function") {
      return false;
    }
    if (window.menu.__renderAiAssistantHookInstalled) {
      ensureTab();
      return true;
    }
    const original = window.menu.renderTabContent.bind(window.menu);
    window.menu.renderTabContent = function (...args) {
      const result = original(...args);
      ensureTab();
      if (window.menu.currentTab === TAB_ID) {
        renderTab();
      }
      return result;
    };
    window.menu.__renderAiAssistantHookInstalled = true;
    ensureTab();
    return true;
  };
  const boot = () => {
    if (state.booted) {
      return;
    }
    state.booted = true;
    loadState();
    installConsoleCapture();
    installNetworkCapture();
    installMenuHook();
    setInterval(() => {
      installMenuHook();
      ensureTab();
    }, 1000);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
