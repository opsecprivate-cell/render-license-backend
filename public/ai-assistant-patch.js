(() => {
  if (window.__renderAiAssistantPatchLoaded) {
    return;
  }
  window.__renderAiAssistantPatchLoaded = true;

  const VERSION = "20260331.1";
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
  const stable = (value, max = 3200) => {
    try {
      return clip(JSON.stringify(value, null, 2), max);
    } catch {
      return clip(String(value), max);
    }
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
    if (!auth) {
      throw new Error("Active admin session required.");
    }
    const payload = await createDirectSecurePayload("/ai/assistant", {
      messages,
      context,
      image: attachmentPayload()
    }, auth);
    const response = await fetch(`${getBackendUrl()}/ai/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
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
      mod: window.mod
        ? {
            pvpbot: !!window.mod.pvpbot,
            farmer: !!window.mod.farmer,
            antiBot: !!window.mod.antiBot,
            antiLag: !!window.mod.antiLag,
            zoom: !!window.mod.zoom,
            menuStyleVariant: text(window.mod.menuStyleVariant || "", 32),
            botNamePrefix: text(window.mod.botNamePrefix || "", 48)
          }
        : null
    };
  };
  const defaultAreas = () => {
    const areas = ["console", "network", "dom", "performance", "mope"];
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
  const executeTool = async (tool, args) => {
    try {
      switch (tool) {
        case "collect_context":
          return await buildContextSnapshot(Array.isArray(args && args.areas) ? args.areas : defaultAreas());
        case "inspect_selector":
          return inspectSelector(args && args.selector);
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
          return { ok: true, element: summarizeElement(node, state.prefs.includeSensitive) };
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
          node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          if (typeof node.click === "function") {
            node.click();
          }
          node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return { ok: true, element: summarizeElement(node, state.prefs.includeSensitive) };
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
          return typeIntoElement(node, String(args && args.text || ""), !!(args && args.append));
        }
        case "run_script": {
          const blocked = ensureAutomation("run_script");
          if (blocked) {
            return blocked;
          }
          const script = String(args && args.script || "").trim();
          if (!script) {
            return { ok: false, error: "No script provided." };
          }
          const fn = new AsyncFunction(script);
          const result = await fn.call(window);
          return { ok: true, result: jsonSafe(result) };
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
    const api = bridge();
    let response = null;
    if (api && hasSession()) {
      try {
        response = await api.callApi("/ai/assistant", {
          messages,
          context,
          image: attachmentPayload()
        });
      } catch (error) {
        const message = formatError(error);
        if (!/blocked endpoint|secure bridge unavailable/i.test(message)) {
          throw error;
        }
      }
    }
    if (!response) {
      response = await directAssistantRequest(messages, context);
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
      return {
        capturedAt: nowIso(),
        page: {
          href: location.href,
          title: document.title,
          sessionActive: hasSession(),
          admin: isAdmin()
        }
      };
    }
    return buildContextSnapshot(defaultAreas());
  };
  const runAssistantLoop = async (prompt, presetContext = null) => {
    const trimmedPrompt = draftText(prompt, 4000).trim();
    if (!trimmedPrompt) {
      return;
    }
    if (!hasSession()) {
      notify("Join an active admin session first.", "warn");
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
      for (let step = 0; step < 4; step += 1) {
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
      addFeed("assistant", "Stopped after 4 tool iterations.", "loop guard");
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
  const renderFeedMarkup = () => {
    const pendingMarkup = state.pending ? `
      <article class="rai-msg rai-msg-pending">
        <div class="rai-msg-head">
          <span class="rai-msg-role">AI Assistant</span>
          <span class="rai-msg-meta">${esc(state.pendingLabel || "thinking")}</span>
        </div>
        <div class="rai-thinking"><span></span><span></span><span></span></div>
        <div class="rai-msg-text">Reading live page state, collecting context, and preparing a response.</div>
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
    return state.feed.map((entry) => `
      <article class="rai-msg rai-msg-${esc(entry.role)}">
        <div class="rai-msg-head">
          <span class="rai-msg-role">${esc(entry.role === "user" ? "You" : entry.role === "tool" ? "Tool Loop" : "AI Assistant")}</span>
          <span class="rai-msg-meta">${esc(entry.meta || "")}</span>
        </div>
        <div class="rai-msg-text">${esc(entry.text).replace(/\n/g, "<br>")}</div>
        ${renderSummaryList(entry.summary, "rai-summary")}
        ${renderSummaryList(entry.nextActions, "rai-next")}
      </article>
    `).join("") + pendingMarkup;
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
#renderMenu .rai-shell{position:relative;display:grid;gap:16px;min-height:640px;padding:18px;border-radius:24px;background:radial-gradient(circle at top left, rgba(100,191,255,.18), transparent 28%),radial-gradient(circle at top right, rgba(255,195,87,.18), transparent 22%),linear-gradient(180deg, rgba(10,18,30,.96), rgba(6,11,20,.98));border:1px solid rgba(121,176,236,.16);box-shadow:inset 0 1px 0 rgba(255,255,255,.06), 0 24px 54px rgba(0,0,0,.28);overflow:hidden}
#renderMenu .rai-shell::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px),linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px);background-size:42px 42px;mask-image:linear-gradient(180deg, rgba(255,255,255,.6), transparent 80%);pointer-events:none;opacity:.35}
#renderMenu .rai-hero{position:relative;display:grid;grid-template-columns:minmax(220px, 300px) 1fr;gap:18px;align-items:stretch}
#renderMenu .rai-robot-card,#renderMenu .rai-panel,#renderMenu .rai-feed-card,#renderMenu .rai-composer{position:relative;border-radius:22px;background:linear-gradient(180deg, rgba(18,28,46,.92), rgba(10,16,28,.96));border:1px solid rgba(126,186,255,.16);box-shadow:0 18px 38px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.05)}
#renderMenu .rai-robot-card{overflow:hidden;padding:18px;display:grid;place-items:center;min-height:240px}
#renderMenu .rai-robot-card::after{content:"";position:absolute;inset:auto -16% -42% -16%;height:50%;background:radial-gradient(circle, rgba(109,212,255,.26), transparent 70%);filter:blur(10px)}
#renderMenu .rai-robot{position:relative;width:168px;height:188px;display:grid;place-items:center;transform:translateZ(0)}
#renderMenu .rai-robot-orbit,#renderMenu .rai-robot-orbit::before,#renderMenu .rai-robot-orbit::after{position:absolute;inset:18px;border-radius:999px;border:1px solid rgba(120,198,255,.16);animation:raiOrbit 10s linear infinite}
#renderMenu .rai-robot-orbit::before,#renderMenu .rai-robot-orbit::after{content:"";inset:-12px}
#renderMenu .rai-robot-orbit::after{inset:18px;animation-duration:5.6s;animation-direction:reverse}
#renderMenu .rai-robot-head{position:relative;width:118px;height:124px;border-radius:30px 30px 34px 34px;background:linear-gradient(180deg, rgba(31,50,81,.98), rgba(18,30,49,.98));border:1px solid rgba(151,213,255,.34);box-shadow:0 0 0 1px rgba(255,255,255,.04) inset, 0 18px 30px rgba(0,0,0,.24)}
#renderMenu .rai-robot-head::before{content:"";position:absolute;left:50%;top:-22px;width:4px;height:24px;margin-left:-2px;border-radius:999px;background:linear-gradient(180deg, rgba(174,233,255,.9), rgba(45,134,209,.3))}
#renderMenu .rai-robot-head::after{content:"";position:absolute;left:50%;top:-32px;width:14px;height:14px;margin-left:-7px;border-radius:999px;background:#8be4ff;box-shadow:0 0 18px rgba(128,228,255,.75);animation:raiPulse 1.8s ease-in-out infinite}
#renderMenu .rai-robot-face{position:absolute;inset:16px 12px 20px;border-radius:22px;background:linear-gradient(180deg, rgba(7,13,24,.92), rgba(10,18,32,.98));border:1px solid rgba(110,180,255,.2);overflow:hidden}
#renderMenu .rai-robot-face::before{content:"";position:absolute;inset:auto -30% 16px -30%;height:2px;background:linear-gradient(90deg, transparent, rgba(147,219,255,.9), transparent);box-shadow:0 0 16px rgba(147,219,255,.7);animation:raiScan 3.4s ease-in-out infinite}
#renderMenu .rai-eyes{position:absolute;top:34px;left:18px;right:18px;display:flex;justify-content:space-between}
#renderMenu .rai-eye{width:26px;height:18px;border-radius:999px;background:linear-gradient(90deg, rgba(82,208,255,.72), rgba(188,244,255,1));box-shadow:0 0 20px rgba(89,216,255,.72);animation:raiBlink 4s infinite}
#renderMenu .rai-mouth{position:absolute;left:50%;bottom:22px;width:58px;height:8px;margin-left:-29px;border-radius:999px;background:linear-gradient(90deg, rgba(74,176,255,.18), rgba(177,236,255,.9), rgba(74,176,255,.18));box-shadow:0 0 18px rgba(87,191,255,.42)}
#renderMenu .rai-copy{display:grid;gap:12px;padding:18px 20px}
#renderMenu .rai-kicker{display:inline-flex;align-items:center;gap:8px;width:max-content;padding:7px 12px;border-radius:999px;background:rgba(17,31,52,.78);border:1px solid rgba(122,186,255,.24);color:#bfe6ff;font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}
#renderMenu .rai-title{font-size:32px;line-height:1.02;font-weight:900;letter-spacing:-.04em;color:#f5fbff;text-wrap:balance}
#renderMenu .rai-title span{display:block;color:#84d9ff;text-shadow:0 0 24px rgba(85,204,255,.26)}
#renderMenu .rai-copy p{margin:0;max-width:780px;color:rgba(226,237,248,.78);font-size:13px;line-height:1.6}
#renderMenu .rai-pill-row,#renderMenu .rai-toolbar,#renderMenu .rai-actions{display:flex;flex-wrap:wrap;gap:10px}
#renderMenu .rai-pill{display:inline-flex;align-items:center;gap:8px;padding:10px 12px;border-radius:14px;border:1px solid rgba(128,190,255,.18);background:linear-gradient(180deg, rgba(19,31,52,.88), rgba(10,18,30,.96));color:#e8f4ff;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
#renderMenu .rai-pill b{color:#81d8ff;font-weight:900}
#renderMenu .rai-status-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}
#renderMenu .rai-status-card{padding:16px;border-radius:22px;background:linear-gradient(180deg, rgba(18,28,46,.92), rgba(10,16,28,.96));border:1px solid rgba(126,186,255,.16);box-shadow:0 18px 38px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.05)}
#renderMenu .rai-status-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
#renderMenu .rai-status-title{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#dbefff;font-weight:900}
#renderMenu .rai-status-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid rgba(129,193,255,.18);background:linear-gradient(180deg, rgba(22,36,58,.96), rgba(12,20,32,.98));color:#eff8ff;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}
#renderMenu .rai-status-dot{width:8px;height:8px;border-radius:999px;background:#7ee4ff;box-shadow:0 0 16px rgba(126,228,255,.55)}
#renderMenu .rai-status-pill.is-busy .rai-status-dot{background:#ffd36f;box-shadow:0 0 18px rgba(255,211,111,.7);animation:raiPulse 1.2s ease-in-out infinite}
#renderMenu .rai-status-copy{font-size:12px;line-height:1.6;color:rgba(232,243,252,.82)}
#renderMenu .rai-status-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
#renderMenu .rai-status-metric{padding:12px;border-radius:16px;border:1px solid rgba(127,193,255,.14);background:linear-gradient(180deg, rgba(15,24,39,.94), rgba(10,16,26,.98))}
#renderMenu .rai-status-metric b{display:block;font-size:18px;line-height:1;color:#f5fbff;font-weight:900;margin-bottom:6px}
#renderMenu .rai-status-metric span{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(226,237,248,.66);font-weight:900}
#renderMenu .rai-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:16px}
#renderMenu .rai-panel{padding:16px}
#renderMenu .rai-panel h3,#renderMenu .rai-feed-head h3,#renderMenu .rai-compose-head h3{margin:0;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#dbefff}
#renderMenu .rai-quick-grid,#renderMenu .rai-toggle-grid,#renderMenu .rai-feed{display:grid;gap:10px}
#renderMenu .rai-quick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
#renderMenu button.rai-quick,#renderMenu button.rai-toggle,#renderMenu button.rai-button{appearance:none;-webkit-appearance:none;font:inherit;text-align:left;text-transform:none;letter-spacing:normal}
#renderMenu .rai-quick{display:grid;align-content:start;gap:10px;min-height:154px;width:100%;padding:14px;border-radius:16px;border:1px solid rgba(125,188,255,.14);background:linear-gradient(180deg, rgba(18,31,49,.92), rgba(11,18,29,.97));cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;box-sizing:border-box}
#renderMenu .rai-quick:hover{transform:translateY(-2px);border-color:rgba(133,208,255,.32);box-shadow:0 12px 24px rgba(0,0,0,.18)}
#renderMenu .rai-quick strong{display:block;font-size:13px;line-height:1.25;color:#f5fbff;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
#renderMenu .rai-quick span,#renderMenu .rai-toggle-copy span,#renderMenu .rai-feed-head span,#renderMenu .rai-compose-head span,#renderMenu .rai-empty,#renderMenu .rai-msg-meta,#renderMenu .rai-summary div,#renderMenu .rai-next div,#renderMenu .rai-attachment-copy span{font-size:11px;line-height:1.5;color:rgba(225,238,248,.7)}
#renderMenu .rai-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;width:100%;min-height:94px;padding:14px 16px;border-radius:18px;border:1px solid rgba(123,185,255,.14);background:linear-gradient(180deg, rgba(14,24,38,.96), rgba(10,17,29,.98));cursor:pointer;box-sizing:border-box;transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease}
#renderMenu .rai-toggle:hover{transform:translateY(-1px);border-color:rgba(144,214,255,.28);box-shadow:0 12px 26px rgba(0,0,0,.16)}
#renderMenu .rai-toggle-copy{display:grid;gap:5px;min-width:0}
#renderMenu .rai-toggle-copy strong,#renderMenu .rai-msg-role,#renderMenu .rai-attachment-copy strong{font-size:13px;line-height:1.2;color:#f5fbff;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
#renderMenu .rai-toggle-meta{display:grid;justify-items:end;gap:8px}
#renderMenu .rai-toggle-state{display:inline-flex;align-items:center;justify-content:center;min-width:50px;height:24px;padding:0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.05);color:rgba(234,245,255,.74);font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}
#renderMenu .rai-switch{position:relative;width:48px;height:28px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);transition:background .18s ease,border-color .18s ease}
#renderMenu .rai-switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:999px;background:#eef8ff;transition:transform .18s ease;box-shadow:0 6px 12px rgba(0,0,0,.2)}
#renderMenu .rai-toggle.active .rai-switch{background:linear-gradient(90deg, rgba(60,164,255,.92), rgba(109,223,255,.96));border-color:rgba(145,224,255,.5)}
#renderMenu .rai-toggle.active .rai-switch::after{transform:translateX(20px)}
#renderMenu .rai-toggle.active .rai-toggle-state{background:rgba(92,196,255,.16);border-color:rgba(121,215,255,.28);color:#9ce5ff}
#renderMenu .rai-feed-card{padding:16px;min-height:360px;display:grid;grid-template-rows:auto 1fr}
#renderMenu .rai-feed-head,#renderMenu .rai-compose-head,#renderMenu .rai-msg-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
#renderMenu .rai-feed{min-height:220px;max-height:540px;overflow:auto;padding-right:2px}
#renderMenu .rai-empty{display:grid;place-items:center;text-align:center;padding:24px;border-radius:18px;border:1px dashed rgba(137,197,255,.18);background:rgba(255,255,255,.025)}
#renderMenu .rai-msg{padding:13px 14px;border-radius:18px;border:1px solid rgba(128,190,255,.12);background:linear-gradient(180deg, rgba(16,26,42,.94), rgba(10,16,28,.98))}
#renderMenu .rai-msg-user{border-color:rgba(110,206,255,.25);background:linear-gradient(180deg, rgba(16,38,57,.94), rgba(8,20,34,.98))}
#renderMenu .rai-msg-tool{border-color:rgba(255,204,102,.24);background:linear-gradient(180deg, rgba(51,35,13,.92), rgba(26,19,10,.98))}
#renderMenu .rai-msg-pending{border-color:rgba(255,214,121,.28);background:linear-gradient(180deg, rgba(38,33,19,.94), rgba(18,15,10,.98))}
#renderMenu .rai-msg-head{margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em}
#renderMenu .rai-msg-text{font-size:12px;line-height:1.66;color:#eaf5ff}
#renderMenu .rai-thinking{display:flex;align-items:center;gap:8px;margin:4px 0 10px}
#renderMenu .rai-thinking span{width:10px;height:10px;border-radius:999px;background:linear-gradient(180deg, #ffd97f, #ffbb4d);box-shadow:0 0 14px rgba(255,197,92,.42);animation:raiThinking 1.15s ease-in-out infinite}
#renderMenu .rai-thinking span:nth-child(2){animation-delay:.12s}
#renderMenu .rai-thinking span:nth-child(3){animation-delay:.24s}
#renderMenu .rai-summary,#renderMenu .rai-next{display:grid;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}
#renderMenu .rai-summary div,#renderMenu .rai-next div{padding-left:14px;position:relative}
#renderMenu .rai-summary div::before,#renderMenu .rai-next div::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:999px;background:#86dbff;box-shadow:0 0 12px rgba(134,219,255,.45)}
#renderMenu .rai-composer{padding:16px;display:grid;gap:12px}
#renderMenu .rai-composer textarea{position:relative;z-index:2;width:100%;min-height:130px;resize:vertical;border-radius:18px;border:1px solid rgba(130,192,255,.14);background:rgba(8,14,24,.92);color:#f5fbff;padding:16px 17px;box-sizing:border-box;font:500 14px/1.55 'Segoe UI',system-ui,Arial,sans-serif;outline:none;transition:border-color .18s ease, box-shadow .18s ease;pointer-events:auto;user-select:text}
#renderMenu .rai-composer textarea:focus{border-color:rgba(124,211,255,.38);box-shadow:0 0 0 3px rgba(98,197,255,.12)}
#renderMenu .rai-composer textarea::placeholder{color:rgba(215,231,244,.42)}
#renderMenu .rai-attachment{display:flex;align-items:center;gap:12px;padding:10px;border-radius:16px;border:1px solid rgba(127,193,255,.16);background:linear-gradient(180deg, rgba(15,24,39,.94), rgba(10,16,26,.98))}
#renderMenu .rai-attachment img{width:72px;height:72px;object-fit:cover;border-radius:12px;border:1px solid rgba(127,193,255,.18)}
#renderMenu .rai-button{display:inline-flex;align-items:center;gap:8px;justify-content:center;min-height:42px;padding:0 16px;border:none;border-radius:14px;background:linear-gradient(135deg, rgba(62,169,255,.95), rgba(118,225,255,.92));color:#04121e;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;transition:transform .16s ease, box-shadow .16s ease, filter .16s ease}
#renderMenu .rai-button:hover{transform:translateY(-2px);box-shadow:0 14px 26px rgba(70,168,255,.24)}
#renderMenu .rai-button:disabled{filter:grayscale(.18) brightness(.86);cursor:wait;transform:none}
#renderMenu .rai-button-secondary{background:linear-gradient(180deg, rgba(24,39,63,.96), rgba(12,20,33,.98));color:#eff8ff;border:1px solid rgba(129,193,255,.16)}
#renderMenu .rai-actions input[type="file"]{display:none}
@keyframes raiOrbit{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes raiPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.12);opacity:.72}}
@keyframes raiScan{0%,100%{transform:translateY(0)}50%{transform:translateY(-34px)}}
@keyframes raiBlink{0%,44%,100%{transform:scaleY(1)}46%,48%{transform:scaleY(.18)}}
@keyframes raiThinking{0%,100%{transform:translateY(0) scale(1);opacity:.55}50%{transform:translateY(-4px) scale(1.12);opacity:1}}
@media (max-width:1220px){#renderMenu .rai-hero,#renderMenu .rai-grid{grid-template-columns:1fr}}
@media (max-width:980px){#renderMenu .rai-status-grid{grid-template-columns:1fr}#renderMenu .rai-status-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:820px){#renderMenu .rai-shell{padding:12px;border-radius:18px}#renderMenu .rai-title{font-size:24px}#renderMenu .rai-quick-grid{grid-template-columns:1fr}#renderMenu .rai-status-metrics{grid-template-columns:1fr}}
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
          <div class="rai-robot-card"><div class="rai-robot"><div class="rai-robot-orbit"></div><div class="rai-robot-head"><div class="rai-robot-face"><div class="rai-eyes"><span class="rai-eye"></span><span class="rai-eye"></span></div><div class="rai-mouth"></div></div></div></div></div>
          <div class="rai-panel rai-copy">
            <span class="rai-kicker">Render AI Assistant</span>
            <div class="rai-title">Full mope.io runtime access <span>with debug + automation tools.</span></div>
            <p>Live console logs, network traces, storage and application state, packet analyzer context, DOM inspection, automation actions, and optional screenshot analysis are wired into one assistant loop.</p>
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
              <button class="rai-toggle ${state.prefs.allowAutomation ? "active" : ""}" data-rai-toggle="allowAutomation" role="switch" aria-checked="${state.prefs.allowAutomation ? "true" : "false"}" aria-pressed="${state.prefs.allowAutomation ? "true" : "false"}"><div class="rai-toggle-copy"><strong>Automation Armed</strong><span>Permit click, type, focus, and run-script tool actions.</span></div><div class="rai-toggle-meta"><span class="rai-toggle-state">${state.prefs.allowAutomation ? "On" : "Off"}</span><span class="rai-switch"></span></div></button>
            </div>
          </div>
        </section>
        <section class="rai-feed-card">
          <div class="rai-feed-head"><h3>Assistant Feed</h3><span>${esc(statusText)}</span></div>
          <div class="rai-feed" id="renderAiFeed">${renderFeedMarkup()}</div>
        </section>
        <section class="rai-composer">
          <div class="rai-compose-head"><h3>Prompt + Tools</h3><span>${esc(state.attachment ? "image attached" : "text only")}</span></div>
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
