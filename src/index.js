const cors = require("cors");
const crypto = require("crypto");
const { Client: SshClient } = require("ssh2");
const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { query, queryOne } = require("./db");
const { ensureSchema } = require("./schema");

const app = express();

const DEFAULT_DISCORD_ALLOWED_USER_IDS = [];
const DEFAULT_DISCORD_AUTO_MESSAGE_CHANNEL_ID = "1482826609575854140";
const DEFAULT_DISCORD_AUTO_MESSAGE_MODE = "stats";
const DEFAULT_DISCORD_AUTO_MESSAGE_TEXT = "render is best in";
const DEFAULT_DISCORD_AUTO_MESSAGE_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_DISCORD_RECONNECT_DELAY_MS = 30 * 1000;
const DEFAULT_SELF_PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SERVICE_SSH_TIMEOUT_MS = 20 * 1000;

const CONFIG = {
  sessionTimeoutMs: toPositiveInt(process.env.SESSION_TIMEOUT_MS, 24 * 60 * 60 * 1000),
  chatMessageMaxLength: toPositiveInt(process.env.CHAT_MESSAGE_MAX_LENGTH, 120000),
  chatMaxMessages: toPositiveInt(process.env.CHAT_MAX_MESSAGES, 150),
  chatRetentionMs: toPositiveInt(process.env.CHAT_RETENTION_MS, 24 * 60 * 60 * 1000),
  chatCleanupEvery: toPositiveInt(process.env.CHAT_CLEANUP_EVERY, 25),
  adminKickLockMs: toPositiveInt(process.env.ADMIN_KICK_LOCK_MS, 5 * 60 * 1000),
  requestMaxSkewMs: toPositiveInt(process.env.REQUEST_MAX_SKEW_MS, 5 * 60 * 1000),
  requestNonceTtlMs: toPositiveInt(process.env.REQUEST_NONCE_TTL_MS, 2 * 60 * 1000),
  maintenanceMode: String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true",
  maintenanceMessage: process.env.MAINTENANCE_MESSAGE || "Service temporarily disabled",
  scriptSourcePath: process.env.SCRIPT_SOURCE_PATH || path.resolve(__dirname, "..", "private-script.js"),
  scriptSourceUrl: process.env.SCRIPT_SOURCE_URL || "",
  scriptSourceAuthHeader: String(process.env.SCRIPT_SOURCE_AUTH_HEADER || "Authorization").trim(),
  scriptSourceAuthScheme: String(process.env.SCRIPT_SOURCE_AUTH_SCHEME || "Bearer").trim(),
  scriptSourceAuthToken: String(process.env.SCRIPT_SOURCE_AUTH_TOKEN || "").trim(),
  scriptSourceAccept: String(process.env.SCRIPT_SOURCE_ACCEPT || "application/vnd.github.raw").trim(),
  scriptSourceUserAgent: String(process.env.SCRIPT_SOURCE_USER_AGENT || "render-license-backend").trim(),
  bootstrapAdminKey: normalizeKey(process.env.BOOTSTRAP_ADMIN_KEY || ""),
  bootstrapTestKey: normalizeKey(process.env.BOOTSTRAP_TEST_KEY || ""),
  bootstrapAdminExpires: parseExpiryMs(process.env.BOOTSTRAP_ADMIN_EXPIRES || null),
  bootstrapTestExpires: parseExpiryMs(process.env.BOOTSTRAP_TEST_EXPIRES || null),
  discordBotToken: String(process.env.DISCORD_BOT_TOKEN || "").trim(),
  discordApplicationId: String(process.env.DISCORD_APPLICATION_ID || "").trim(),
  discordAllowedUserIds: parseDiscordIdAllowlist(
    process.env.DISCORD_ALLOWED_USER_IDS,
    DEFAULT_DISCORD_ALLOWED_USER_IDS
  ),
  discordAutoMessageChannelId: String(
    process.env.DISCORD_AUTO_MESSAGE_CHANNEL_ID || DEFAULT_DISCORD_AUTO_MESSAGE_CHANNEL_ID
  ).trim(),
  discordAutoMessageMode: String(
    process.env.DISCORD_AUTO_MESSAGE_MODE || DEFAULT_DISCORD_AUTO_MESSAGE_MODE
  ).trim().toLowerCase(),
  discordAutoMessageText: String(
    process.env.DISCORD_AUTO_MESSAGE_TEXT || DEFAULT_DISCORD_AUTO_MESSAGE_TEXT
  ).trim() || DEFAULT_DISCORD_AUTO_MESSAGE_TEXT,
  discordAutoMessageIntervalMs: Math.max(
    60 * 1000,
    toPositiveInt(process.env.DISCORD_AUTO_MESSAGE_INTERVAL_MS, DEFAULT_DISCORD_AUTO_MESSAGE_INTERVAL_MS)
  ),
  discordReconnectDelayMs: Math.max(
    5 * 1000,
    toPositiveInt(process.env.DISCORD_RECONNECT_DELAY_MS, DEFAULT_DISCORD_RECONNECT_DELAY_MS)
  ),
  serviceSshEnabled: String(process.env.SERVICE_SSH_ENABLED || "false").toLowerCase() === "true",
  serviceSshHost: String(process.env.SERVICE_SSH_HOST || "").trim(),
  serviceSshPort: toPositiveInt(process.env.SERVICE_SSH_PORT, 22),
  serviceSshUsername: String(process.env.SERVICE_SSH_USERNAME || "").trim(),
  serviceSshPassword: String(process.env.SERVICE_SSH_PASSWORD || "").trim(),
  serviceSshPrivateKey: normalizeSshPrivateKey(
    process.env.SERVICE_SSH_PRIVATE_KEY || process.env.SERVICE_SSH_PRIVATE_KEY_B64 || ""
  ),
  serviceSshPassphrase: String(process.env.SERVICE_SSH_PASSPHRASE || "").trim(),
  serviceSshCommandTimeoutMs: Math.max(
    1000,
    toPositiveInt(process.env.SERVICE_SSH_COMMAND_TIMEOUT_MS, DEFAULT_SERVICE_SSH_TIMEOUT_MS)
  ),
  serviceSshCommandMap: parseServiceCommandMap(process.env.SERVICE_SSH_COMMANDS || ""),
  selfPingEnabled: String(process.env.SELF_PING_ENABLED || "true").toLowerCase() !== "false",
  selfPingUrl: String(process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || "").trim(),
  selfPingIntervalMs: Math.max(
    60 * 1000,
    toPositiveInt(process.env.SELF_PING_INTERVAL_MS, DEFAULT_SELF_PING_INTERVAL_MS)
  ),
  publicBootstrapScriptEnabled: String(process.env.PUBLIC_BOOTSTRAP_SCRIPT_ENABLED || "").toLowerCase() === "true"
};

const requestNonceCache = new Map();
let chatInsertCounter = 0;
let scriptCache = { mtimeMs: 0, content: "" };
let discordClient = null;
let discordAutoMessageTimer = null;
let discordReconnectTimer = null;
let discordStartInProgress = false;
let discordAutoMessageFailureCount = 0;
let selfPingTimer = null;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.status(200).send("Render license backend online");
});
app.get("/bootstrap-script", asyncHandler(handleBootstrapScript));

app.post("/", asyncHandler(handleLicenseCheck));
app.post("/script", asyncHandler(handleScriptFetch));
app.post("/heartbeat", asyncHandler(handleHeartbeat));
app.post("/upload-script", (_req, res) => {
  res.status(403).send("Upload disabled.");
});
app.post("/presence", asyncHandler(handlePresence));
app.post("/chat/send", asyncHandler(handleChatSend));
app.post("/chat/fetch", asyncHandler(handleChatFetch));
app.post("/admin/users", asyncHandler(handleAdminUsers));
app.post("/admin/kick", asyncHandler(handleAdminKick));
app.post("/admin/freeze", asyncHandler(handleAdminFreeze));
app.post("/admin/message", asyncHandler(handleAdminMessage));
app.post("/admin/blind", asyncHandler(handleAdminBlind));

async function main() {
  await waitForDatabaseReady();
  await bootstrapKeys();
  const port = Number(process.env.PORT || 10000);
  app.listen(port, () => {
    console.log(`render-license-backend listening on ${port}`);
  });
  startSelfPingLoop();
  await startDiscordBot();
}

async function waitForDatabaseReady() {
  const attempts = toPositiveInt(process.env.DB_CONNECT_RETRIES, 30);
  const delayMs = toPositiveInt(process.env.DB_CONNECT_DELAY_MS, 5000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensureSchema();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Database not ready yet (attempt ${attempt}/${attempts}): ${error.message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      if (CONFIG.maintenanceMode) {
        res.status(503).json({ error: CONFIG.maintenanceMessage });
        return;
      }
      await fn(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };
}

async function handleLicenseCheck(req, res) {
  const rawKey = String(req.body?.key || "").trim();
  const hwid = normalizeHwid(req.body?.hwid);
  const clientIp = getClientIp(req);

  if (!rawKey) {
    res.status(400).json({ valid: false, error: "Missing Key" });
    return;
  }
  if (!hwid) {
    res.status(400).json({ valid: false, error: "Invalid HWID" });
    return;
  }

  const key = normalizeKey(rawKey);
  const now = Date.now();
  await query("DELETE FROM kicked_clients WHERE expires_at <= $1", [now]);

  const keyData = await queryOne("SELECT * FROM keys WHERE key_id = $1", [key]);
  if (!keyData) {
    res.json({ valid: false, error: "Invalid Key" });
    return;
  }

  const kickLock = await queryOne(
    "SELECT expires_at FROM kicked_clients WHERE key_id = $1 AND hwid = $2 AND expires_at > $3",
    [key, hwid, now]
  );
  if (kickLock) {
    res.status(403).json({
      valid: false,
      error: "Kicked by admin",
      retryAfterMs: Math.max(0, Number(kickLock.expires_at) - now)
    });
    return;
  }

  if (keyData.paused) {
    res.json({ valid: false, error: "Key Paused" });
    return;
  }

  if (isKeyExpired(keyData.expires, now)) {
    res.json({ valid: false, error: "Key Expired" });
    return;
  }

  if (!keyData.shared && keyData.hwid && keyData.hwid !== hwid) {
    res.json({ valid: false, error: "HWID Mismatch" });
    return;
  }

  const isBlacklisted = await queryOne("SELECT 1 FROM blacklist WHERE key_id = $1", [key]);
  if (isBlacklisted) {
    res.json({ valid: false, error: "Key Blacklisted" });
    return;
  }

  if (keyData.shared) {
    const seen = await queryOne(
      "SELECT 1 FROM key_activations WHERE key_id = $1 AND hwid = $2",
      [key, hwid]
    );
    if (!seen) {
      const maxUses = Number(keyData.max_uses || 0);
      if (maxUses > 0) {
        const usage = await queryOne(
          "SELECT COUNT(*)::int AS c FROM key_activations WHERE key_id = $1",
          [key]
        );
        if (Number(usage?.c || 0) >= maxUses) {
          res.json({ valid: false, error: "Key Usage Limit Reached" });
          return;
        }
      }
      await query(
        "INSERT INTO key_activations (key_id, hwid, first_seen, last_seen) VALUES ($1, $2, $3, $4)",
        [key, hwid, now, now]
      );
    } else {
      await query(
        "UPDATE key_activations SET last_seen = $1 WHERE key_id = $2 AND hwid = $3",
        [now, key, hwid]
      );
    }
    if (!keyData.activated_at) {
      await query("UPDATE keys SET activated_at = NOW() WHERE key_id = $1", [key]);
    }
  } else if (!keyData.hwid) {
    await query("UPDATE keys SET hwid = $1, activated_at = NOW() WHERE key_id = $2", [hwid, key]);
  }

  await query(
    `
      UPDATE keys
      SET last_hwid = $1, last_ip = $2, last_seen_at = $3
      WHERE key_id = $4
    `,
    [hwid, clientIp, now, key]
  );

  const token = crypto.randomUUID();
  const requestSecret = randomHex(32);
  const sessionExpires = now + CONFIG.sessionTimeoutMs;

  if (keyData.shared) {
    await query(
      "DELETE FROM presence WHERE session_id IN (SELECT token FROM sessions WHERE key_id = $1 AND hwid = $2)",
      [key, hwid]
    );
    await query("DELETE FROM sessions WHERE key_id = $1 AND hwid = $2", [key, hwid]);
  } else {
    await query("DELETE FROM sessions WHERE key_id = $1", [key]);
    await query("DELETE FROM presence WHERE key_id = $1", [key]);
  }

  await query(
    `
      INSERT INTO sessions (token, key_id, expires, hwid, request_secret, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [token, key, sessionExpires, hwid, requestSecret, clientIp]
  );

  const keyExpiresAt = parseExpiryMs(keyData.expires);
  res.json({
    valid: true,
    sessionToken: token,
    requestSecret,
    expires: sessionExpires,
    sessionExpires,
    keyExpiresAt,
    expiresAt: keyExpiresAt,
    jumpscare: Boolean(keyData.jumpscare),
    isAdmin: Boolean(keyData.is_admin)
  });
}

async function handleScriptFetch(req, res) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  if (!sessionToken || !hwid) {
    res.status(400).send("Invalid Request");
    return;
  }

  const session = await queryOne(
    "SELECT key_id, expires, request_secret, ip_address FROM sessions WHERE token = $1 AND hwid = $2",
    [sessionToken, hwid]
  );
  if (!session) {
    res.status(401).send("Invalid Session");
    return;
  }
  if (!isSessionIpAllowed(req, session)) {
    res.status(401).send("IP changed");
    return;
  }
  if (Date.now() > Number(session.expires)) {
    res.status(401).send("Session Expired");
    return;
  }

  const secure = await verifySecureEnvelope(body, "/script", sessionToken, hwid, session.request_secret);
  if (!secure.ok) {
    res.status(401).send("Invalid secure envelope");
    return;
  }

  const keyData = await queryOne("SELECT expires FROM keys WHERE key_id = $1", [session.key_id]);
  if (isKeyExpired(keyData?.expires)) {
    res.status(401).send("Key Expired");
    return;
  }

  const script = await getScriptSource(req);
  const encrypted = xorEncryptToBase64(script, getSessionCipherKey(sessionToken, hwid));
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("X-Encoding", "base64");
  res.send(encrypted);
}

async function handleBootstrapScript(req, res) {
  if (!CONFIG.publicBootstrapScriptEnabled) {
    res.status(404).send("Not found");
    return;
  }
  const script = await getScriptSource(req);
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(script);
}

async function handleHeartbeat(req, res) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  if (!sessionToken || !hwid) {
    res.json({ valid: false, error: "Invalid session" });
    return;
  }

  const session = await queryOne(
    "SELECT key_id, expires, request_secret, ip_address FROM sessions WHERE token = $1 AND hwid = $2",
    [sessionToken, hwid]
  );
  if (!session || Date.now() > Number(session.expires)) {
    res.json({ valid: false });
    return;
  }
  if (!isSessionIpAllowed(req, session)) {
    res.status(401).json({ valid: false, error: "IP changed" });
    return;
  }

  const secure = await verifySecureEnvelope(body, "/heartbeat", sessionToken, hwid, session.request_secret);
  if (!secure.ok) {
    res.status(401).json({ valid: false, error: secure.error });
    return;
  }

  const keyData = await queryOne(
    "SELECT expires, jumpscare, is_admin FROM keys WHERE key_id = $1",
    [session.key_id]
  );
  if (isKeyExpired(keyData?.expires)) {
    res.json({ valid: false, error: "Key Expired" });
    return;
  }

  if (keyData?.jumpscare) {
    await query("UPDATE keys SET jumpscare = FALSE WHERE key_id = $1", [session.key_id]);
  }

  const newExpires = Date.now() + CONFIG.sessionTimeoutMs;
  await query("UPDATE sessions SET expires = $1 WHERE token = $2", [newExpires, sessionToken]);

  const keyExpiresAt = parseExpiryMs(keyData?.expires);
  res.json({
    valid: true,
    expires: newExpires,
    sessionExpires: newExpires,
    keyExpiresAt,
    expiresAt: keyExpiresAt,
    jumpscare: Boolean(keyData?.jumpscare),
    isAdmin: Boolean(keyData?.is_admin)
  });
}

async function handlePresence(req, res) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  const session = await getSessionForEndpoint(req, sessionToken, hwid, "/presence", body);
  if (!session.ok) {
    res.status(session.status).json(session.body);
    return;
  }

  const now = Date.now();
  const clientIp = getClientIp(req);
  const serverId = String(body.serverId || "").trim() || null;
  const existing = await queryOne(
    "SELECT frozen, blinded, admin_message FROM presence WHERE session_id = $1",
    [sessionToken]
  );

  await query(
    `
      INSERT INTO presence (session_id, key_id, username, server, server_id, last_seen, frozen, blinded, admin_message, player_x, player_y)
      VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, NULL, $7, $8)
      ON CONFLICT (session_id) DO UPDATE SET
        username = EXCLUDED.username,
        server = EXCLUDED.server,
        server_id = EXCLUDED.server_id,
        last_seen = EXCLUDED.last_seen,
        admin_message = NULL,
        player_x = EXCLUDED.player_x,
        player_y = EXCLUDED.player_y
    `,
    [
      sessionToken,
      session.session.key_id,
      String(body.username || "Unknown"),
      String(body.server || "Unknown"),
      serverId,
      now,
      Number(body.playerX || 0),
      Number(body.playerY || 0)
    ]
  );

  await query(
    `
      UPDATE keys
      SET last_hwid = $1, last_ip = $2, last_username = $3, last_server = $4, last_server_id = $5, last_seen_at = $6
      WHERE key_id = $7
    `,
    [
      hwid,
      clientIp,
      String(body.username || "Unknown"),
      String(body.server || "Unknown"),
      serverId,
      now,
      session.session.key_id
    ]
  );

  await query("DELETE FROM presence WHERE last_seen < $1", [now - 30000]);
  res.json({
    valid: true,
    frozen: Boolean(existing?.frozen),
    blinded: Boolean(existing?.blinded),
    adminMessage: existing?.admin_message || null
  });
}

async function handleChatSend(req, res) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  const message = String(body.message || "");
  if (!message || message.length > CONFIG.chatMessageMaxLength) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }

  const session = await getSessionForEndpoint(req, sessionToken, hwid, "/chat/send", body);
  if (!session.ok) {
    res.status(session.status).json(session.body);
    return;
  }

  const presence = await queryOne(
    "SELECT username, server FROM presence WHERE session_id = $1",
    [sessionToken]
  );
  const fallbackUsername = String(body.username || "Unknown").trim() || "Unknown";
  const fallbackServer = String(body.server || "Unknown").trim() || "Unknown";
  const senderName = String(presence?.username || fallbackUsername).trim() || "Unknown";
  const senderServer = String(presence?.server || fallbackServer).trim() || "Unknown";

  const now = Date.now();
  const recent = await queryOne(
    "SELECT timestamp FROM chat WHERE sender_key = $1 ORDER BY timestamp DESC LIMIT 1",
    [session.session.key_id]
  );
  if (recent && now - Number(recent.timestamp) < 2000) {
    res.status(429).json({ error: "Rate limited" });
    return;
  }

  await query(
    "INSERT INTO chat (sender_key, sender_name, server, message, timestamp) VALUES ($1, $2, $3, $4, $5)",
    [
      session.session.key_id,
      senderName,
      senderServer,
      message,
      now
    ]
  );

  chatInsertCounter += 1;
  if (chatInsertCounter % CONFIG.chatCleanupEvery === 0) {
    await query("DELETE FROM chat WHERE timestamp < $1", [now - CONFIG.chatRetentionMs]);
    await query(
      `
        DELETE FROM chat
        WHERE id IN (
          SELECT id FROM chat
          ORDER BY id DESC
          OFFSET $1
        )
      `,
      [CONFIG.chatMaxMessages]
    );
  }

  res.json({ success: true });
}

async function handleChatFetch(req, res) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  const session = await getSessionForEndpoint(req, sessionToken, hwid, "/chat/fetch", body);
  if (!session.ok) {
    res.status(session.status).json(session.body);
    return;
  }

  const myPresence = await queryOne(
    "SELECT server, server_id FROM presence WHERE session_id = $1",
    [sessionToken]
  );
  const targetServerId = normalizeServerId(body.serverId) || normalizeServerId(myPresence?.server_id);
  const targetServerName = normalizeServerLabel(body.server || myPresence?.server);
  const since = Number(body.lastTimestamp || 0);
  const serverScope = targetServerId || targetServerName ? {
    serverId: targetServerId || null,
    serverName: targetServerName || null
  } : null;

  const messagesResult = await query(
    "SELECT sender_name, server, message, timestamp FROM chat WHERE timestamp > $1 ORDER BY timestamp ASC LIMIT 50",
    [since]
  );
  const usersResult = await query(
    `
      SELECT username, server, server_id, player_x, player_y
      FROM presence
      WHERE last_seen > $1
      ORDER BY username
    `,
    [Date.now() - 15000]
  );

  const users = usersResult.rows;
  const serverUsers = serverScope
    ? users.filter((user) => {
      const sameServerId = serverScope.serverId && normalizeServerId(user.server_id) === serverScope.serverId;
      const sameServerName = serverScope.serverName && normalizeServerLabel(user.server) === serverScope.serverName;
      return sameServerId || sameServerName;
    })
    : users;
  const messages = serverScope && serverScope.serverName
    ? messagesResult.rows.filter((message) => {
      const sameServerName = serverScope.serverName && normalizeServerLabel(message.server) === serverScope.serverName;
      return sameServerName;
    })
    : messagesResult.rows;

  res.json({
    messages,
    users: serverScope ? serverUsers : users,
    serverUsers
  });
}

async function handleAdminUsers(req, res) {
  const access = await getAdminAccess(req, "/admin/users");
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }

  const usersResult = await query(
    `
      SELECT session_id, key_id, username, server, server_id, player_x, player_y, frozen, blinded, last_seen
      FROM presence
      WHERE last_seen > $1
      ORDER BY server, username
    `,
    [Date.now() - 30000]
  );
  res.json({ users: usersResult.rows });
}

async function handleAdminKick(req, res) {
  const access = await getAdminAccess(req, "/admin/kick");
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }

  const targetSession = String(req.body?.targetSession || "");
  if (!targetSession) {
    res.status(400).json({ success: false, error: "Invalid target session" });
    return;
  }

  const target = await queryOne("SELECT key_id, hwid FROM sessions WHERE token = $1", [targetSession]);
  if (!target) {
    res.status(404).json({ success: false, error: "Session not found" });
    return;
  }

  const now = Date.now();
  const lockUntil = now + CONFIG.adminKickLockMs;
  const tokenRows = await query("SELECT token FROM sessions WHERE key_id = $1 AND hwid = $2", [
    target.key_id,
    target.hwid
  ]);
  const targetTokens = tokenRows.rows.map((row) => row.token);

  await query(
    `
      INSERT INTO kicked_clients (key_id, hwid, expires_at, reason, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (key_id, hwid) DO UPDATE SET
        expires_at = EXCLUDED.expires_at,
        reason = EXCLUDED.reason,
        created_at = EXCLUDED.created_at
    `,
    [target.key_id, target.hwid, lockUntil, "admin_kick", now]
  );

  await query("DELETE FROM sessions WHERE key_id = $1 AND hwid = $2", [target.key_id, target.hwid]);
  if (targetTokens.length > 0) {
    await query("DELETE FROM presence WHERE session_id = ANY($1::text[])", [targetTokens]);
  }
  res.json({ success: true, lockExpiresAt: lockUntil, removedSessions: targetTokens.length });
}

async function handleAdminFreeze(req, res) {
  await handlePresenceFlagUpdate(req, res, "/admin/freeze", "frozen", Boolean(req.body?.freeze));
}

async function handleAdminMessage(req, res) {
  const access = await getAdminAccess(req, "/admin/message");
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }
  const targetSession = String(req.body?.targetSession || "");
  const message = String(req.body?.message || "");
  if (!targetSession) {
    res.status(400).json({ error: "Invalid target session" });
    return;
  }
  if (!message || message.length > 200) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }
  const updated = await query(
    "UPDATE presence SET admin_message = $1 WHERE session_id = $2",
    [message, targetSession]
  );
  if (updated.rowCount === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ success: true });
}

async function handleAdminBlind(req, res) {
  await handlePresenceFlagUpdate(req, res, "/admin/blind", "blinded", Boolean(req.body?.blind));
}

async function handlePresenceFlagUpdate(req, res, endpoint, column, value) {
  const access = await getAdminAccess(req, endpoint);
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }
  const targetSession = String(req.body?.targetSession || "");
  if (!targetSession) {
    res.status(400).json({ success: false, error: "Invalid target session" });
    return;
  }
  const updated = await query(`UPDATE presence SET ${column} = $1 WHERE session_id = $2`, [value, targetSession]);
  if (updated.rowCount === 0) {
    res.status(404).json({ success: false, error: "Session not found" });
    return;
  }
  res.json({ success: true });
}

async function getAdminAccess(req, endpoint) {
  const body = req.body || {};
  const sessionToken = String(body.sessionToken || "").trim();
  const hwid = normalizeHwid(body.hwid);
  const session = await getSessionForEndpoint(req, sessionToken, hwid, endpoint, body);
  if (!session.ok) {
    return session;
  }
  const key = await queryOne("SELECT is_admin FROM keys WHERE key_id = $1", [session.session.key_id]);
  if (!key?.is_admin) {
    return { ok: false, status: 403, body: { error: "Not admin" } };
  }
  return session;
}

async function getSessionForEndpoint(req, sessionToken, hwid, endpoint, body) {
  if (!sessionToken || !hwid) {
    return { ok: false, status: 401, body: { valid: false, error: "Invalid session" } };
  }
  const session = await queryOne(
    `
      SELECT token, key_id, hwid, expires, request_secret, ip_address
      FROM sessions
      WHERE token = $1 AND hwid = $2 AND expires > $3
    `,
    [sessionToken, hwid, Date.now()]
  );
  if (!session) {
    return { ok: false, status: 401, body: { valid: false, error: "Invalid session" } };
  }
  if (!isSessionIpAllowed(req, session)) {
    return { ok: false, status: 401, body: { valid: false, error: "IP changed" } };
  }
  const secure = await verifySecureEnvelope(body, endpoint, sessionToken, hwid, session.request_secret);
  if (!secure.ok) {
    return { ok: false, status: 401, body: { valid: false, error: secure.error } };
  }
  return { ok: true, session, status: 200, body: {} };
}

async function getScriptSource(req) {
  if (CONFIG.scriptSourceUrl) {
    const headers = {};
    if (CONFIG.scriptSourceUserAgent) {
      headers["User-Agent"] = CONFIG.scriptSourceUserAgent;
    }
    if (CONFIG.scriptSourceAccept) {
      headers.Accept = CONFIG.scriptSourceAccept;
    }
    if (CONFIG.scriptSourceAuthToken) {
      const authValue = CONFIG.scriptSourceAuthScheme
        ? `${CONFIG.scriptSourceAuthScheme} ${CONFIG.scriptSourceAuthToken}`
        : CONFIG.scriptSourceAuthToken;
      headers[CONFIG.scriptSourceAuthHeader || "Authorization"] = authValue;
    }

    const response = await fetch(CONFIG.scriptSourceUrl, { headers });
    if (!response.ok) {
      throw new Error(`SCRIPT_SOURCE_URL fetch failed with ${response.status}`);
    }
    return rewriteScriptServerUrl(await response.text(), req);
  }

  const stat = await fs.stat(CONFIG.scriptSourcePath);
  if (stat.mtimeMs !== scriptCache.mtimeMs) {
    scriptCache = {
      mtimeMs: stat.mtimeMs,
      content: await fs.readFile(CONFIG.scriptSourcePath, "utf8")
    };
  }
  return rewriteScriptServerUrl(scriptCache.content, req);
}

function rewriteScriptServerUrl(source, req) {
  const origin = getPublicOrigin(req);
  return String(source).replace(
    /serverUrl:\s*"[^"]+"/,
    `serverUrl: "${origin}"`
  );
}

function getPublicOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function getClientIp(req) {
  const candidates = [
    req.headers["cf-connecting-ip"],
    req.headers["x-forwarded-for"],
    req.headers["x-real-ip"],
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress
  ];
  for (const candidate of candidates) {
    const normalized = normalizeIpAddress(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeIpAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const first = raw.split(",")[0].trim();
  if (!first) {
    return null;
  }
  return first
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "")
    .toLowerCase();
}

function isSessionIpAllowed(req, session) {
  const expected = normalizeIpAddress(session?.ip_address);
  const actual = getClientIp(req);
  if (!expected) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return expected === actual;
}

function normalizeKey(value) {
  if (!value) {
    return null;
  }
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeHwid(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-F0-9]{16}$/.test(normalized) ? normalized : null;
}

function normalizeServerLabel(server) {
  return String(server || "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeServerId(serverId) {
  return String(serverId || "")
    .trim()
    .toLowerCase()
    .replace(/^wss?:\/\//, "")
    .replace(/\/ping$/i, "")
    .replace(/\/$/, "");
}

function parseExpiryMs(expires) {
  if (expires === null || expires === undefined || expires === "") {
    return null;
  }
  if (typeof expires === "number") {
    return Number.isFinite(expires) && expires > 0 ? (expires < 1e12 ? expires * 1000 : expires) : null;
  }
  const raw = String(expires).trim();
  if (!raw || raw === "null" || raw === "undefined") {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dateOnly = Date.parse(`${raw}T23:59:59.999Z`);
    return Number.isFinite(dateOnly) ? dateOnly : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isKeyExpired(expires, now = Date.now()) {
  const expiryMs = parseExpiryMs(expires);
  return Boolean(expiryMs && now > expiryMs);
}

function sanitizeSecureBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (key.startsWith("__secure") || key === "sessionToken" || key === "hwid") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function cleanupNonceCache(now = Date.now()) {
  for (const [key, expiry] of requestNonceCache.entries()) {
    if (!Number.isFinite(expiry) || expiry <= now) {
      requestNonceCache.delete(key);
    }
  }
}

function consumeNonce(sessionToken, nonce, now = Date.now()) {
  cleanupNonceCache(now);
  const cacheKey = `${sessionToken}:${nonce}`;
  const existing = requestNonceCache.get(cacheKey);
  if (existing && existing > now) {
    return false;
  }
  requestNonceCache.set(cacheKey, now + CONFIG.requestNonceTtlMs);
  return true;
}

async function verifySecureEnvelope(body, endpoint, sessionToken, hwid, requestSecret) {
  const ts = Number(body?.__secureTs);
  const nonce = String(body?.__secureNonce || "").trim();
  const sig = String(body?.__secureSig || "").trim().toLowerCase();
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "Missing secure timestamp" };
  }
  const now = Date.now();
  if (Math.abs(now - ts) > CONFIG.requestMaxSkewMs) {
    return { ok: false, error: "Stale secure timestamp" };
  }
  if (!nonce || nonce.length < 16) {
    return { ok: false, error: "Invalid secure nonce" };
  }
  if (!/^[a-f0-9]{64}$/.test(sig)) {
    return { ok: false, error: "Invalid secure signature" };
  }
  if (!consumeNonce(sessionToken, nonce, now)) {
    return { ok: false, error: "Replay detected" };
  }

  const payloadCanonical = stableStringify(sanitizeSecureBody(body));
  const base = `${endpoint}|${sessionToken}|${hwid}|${ts}|${nonce}|${payloadCanonical}`;
  const expected = crypto
    .createHmac("sha256", String(requestSecret || ""))
    .update(base)
    .digest("hex");
  return expected === sig ? { ok: true } : { ok: false, error: "Bad secure signature" };
}

function getSessionCipherKey(sessionToken, hwid) {
  return `${sessionToken}:${hwid}`;
}

function xorEncryptToBase64(text, key) {
  const textBytes = Buffer.from(text, "utf8");
  const keyBytes = Buffer.from(key, "utf8");
  const result = Buffer.alloc(textBytes.length);
  for (let index = 0; index < textBytes.length; index += 1) {
    result[index] = textBytes[index] ^ keyBytes[index % keyBytes.length];
  }
  return result.toString("base64");
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDiscordIdAllowlist(rawValue, fallbackIds = []) {
  const raw = String(rawValue || "").trim();
  const entries = raw ? raw.split(/[,\s]+/) : fallbackIds;
  const ids = entries
    .map((entry) => String(entry || "").trim())
    .filter((entry) => /^\d{10,22}$/.test(entry));
  return new Set(ids);
}

function isDiscordUserAllowed(interaction) {
  const normalized = String(interaction?.user?.id || "").trim();
  if (!normalized) {
    return false;
  }
  if (CONFIG.discordAllowedUserIds.size > 0) {
    return CONFIG.discordAllowedUserIds.has(normalized);
  }
  if (!interaction?.inGuild?.()) {
    return false;
  }
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
}

function normalizeSshPrivateKey(rawValue) {
  const input = String(rawValue || "").trim();
  if (!input) {
    return "";
  }
  const decoded = decodeBase64IfNeeded(input);
  return decoded.includes("\\n") ? decoded.replace(/\\n/g, "\n") : decoded;
}

function decodeBase64IfNeeded(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }
  if (input.includes("BEGIN ") || input.includes("\n")) {
    return input;
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(input) || input.length % 4 !== 0) {
    return input;
  }
  try {
    const decoded = Buffer.from(input, "base64").toString("utf8");
    return decoded.includes("BEGIN ") ? decoded : input;
  } catch {
    return input;
  }
}

function parseServiceCommandMap(rawValue) {
  const map = new Map();
  const entries = String(rawValue || "")
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const actionKey = normalizeServiceAction(entry.slice(0, separatorIndex));
    const command = entry.slice(separatorIndex + 1).trim();
    if (!actionKey || !command) {
      continue;
    }
    map.set(actionKey, command);
  }

  return map;
}

function normalizeServiceAction(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function getConfiguredServiceActions() {
  return Array.from(CONFIG.serviceSshCommandMap.keys()).sort();
}

function createSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("genkey")
      .setDescription("Generate one or more license keys.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("How many keys to generate.").setMinValue(1).setMaxValue(50)
      )
      .addStringOption((option) =>
        option.setName("duration").setDescription("Duration like 1d, 7d, 30d, lifetime.")
      )
      .addBooleanOption((option) =>
        option.setName("shared").setDescription("Shared event key that supports multiple HWIDs.")
      )
      .addIntegerOption((option) =>
        option.setName("maxuses").setDescription("Max unique HWIDs for shared keys.").setMinValue(0).setMaxValue(100000)
      ),
    new SlashCommandBuilder()
      .setName("genadminkey")
      .setDescription("Generate a new admin key.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("duration").setDescription("Duration like 1d, 7d, 30d, lifetime.")
      ),
    new SlashCommandBuilder()
      .setName("keys")
      .setDescription("Show the latest keys.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Show backend key statistics.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("keyinfo")
      .setDescription("Show detailed info for a key.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("deletekey")
      .setDescription("Delete one key and its related sessions.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("deleteallkeys")
      .setDescription("Delete every key, session, chat message, and activation.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("conpensate")
      .setDescription("Add days to a key expiry.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("days").setDescription("Days to add.").setRequired(true).setMinValue(1).setMaxValue(3650)
      ),
    new SlashCommandBuilder()
      .setName("compensate")
      .setDescription("Add days to a key expiry.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("days").setDescription("Days to add.").setRequired(true).setMinValue(1).setMaxValue(3650)
      ),
    new SlashCommandBuilder()
      .setName("pause")
      .setDescription("Toggle paused state on a key.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("resethwid")
      .setDescription("Reset the HWID or shared activations for a key.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("Blacklist a key.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("jumpscare")
      .setDescription("Queue a jumpscare for the next heartbeat.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option.setName("key").setDescription("The license key.").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("service")
      .setDescription("Run a configured remote service action over SSH.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Configured action key (example: status, restart).")
          .setRequired(false)
      )
  ];
}

function clearDiscordAutoMessageLoop() {
  if (discordAutoMessageTimer) {
    clearInterval(discordAutoMessageTimer);
    discordAutoMessageTimer = null;
  }
  discordAutoMessageFailureCount = 0;
}

function clearDiscordReconnectTimer() {
  if (discordReconnectTimer) {
    clearTimeout(discordReconnectTimer);
    discordReconnectTimer = null;
  }
}

function scheduleDiscordReconnect(reason, delayMs = CONFIG.discordReconnectDelayMs) {
  if (!CONFIG.discordBotToken || !CONFIG.discordApplicationId) {
    return;
  }
  if (discordReconnectTimer) {
    return;
  }
  const delay = Math.max(5000, Number(delayMs) || CONFIG.discordReconnectDelayMs);
  console.warn(`Discord reconnect scheduled in ${Math.floor(delay / 1000)}s (${reason})`);
  discordReconnectTimer = setTimeout(() => {
    discordReconnectTimer = null;
    void startDiscordBot();
  }, delay);
}

function normalizePingUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    return "";
  }
  const noTrailingSlash = value.replace(/\/+$/, "");
  return `${noTrailingSlash}/`;
}

function isValidHttpUrl(value) {
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(value || ""));
}

function startSelfPingLoop() {
  if (selfPingTimer) {
    clearInterval(selfPingTimer);
    selfPingTimer = null;
  }
  if (!CONFIG.selfPingEnabled) {
    console.log("Self ping disabled by SELF_PING_ENABLED");
    return;
  }

  const pingUrl = normalizePingUrl(CONFIG.selfPingUrl);
  if (!isValidHttpUrl(pingUrl)) {
    console.log("Self ping disabled: set SELF_PING_URL or RENDER_EXTERNAL_URL to a valid URL");
    return;
  }
  const intervalMs = Math.max(60 * 1000, Number(CONFIG.selfPingIntervalMs) || DEFAULT_SELF_PING_INTERVAL_MS);

  const ping = async () => {
    try {
      const response = await fetch(pingUrl, {
        method: "GET",
        headers: { "User-Agent": "render-license-self-ping" }
      });
      if (!response.ok) {
        console.warn(`Self ping non-200 response (${response.status}) from ${pingUrl}`);
      }
    } catch (error) {
      console.warn(`Self ping failed for ${pingUrl}: ${error.message}`);
    }
  };

  console.log(`Self ping enabled: ${pingUrl} every ${Math.floor(intervalMs / 60000)} minute(s)`);
  void ping();
  selfPingTimer = setInterval(() => {
    void ping();
  }, intervalMs);
}

function resetDiscordClient() {
  clearDiscordAutoMessageLoop();
  if (!discordClient) {
    return;
  }
  try {
    discordClient.removeAllListeners();
    discordClient.destroy();
  } catch (error) {
    console.warn(`Failed to fully reset Discord client: ${error.message}`);
  }
  discordClient = null;
}

async function startDiscordBot() {
  if (!CONFIG.discordBotToken || !CONFIG.discordApplicationId) {
    console.log("Discord bot not configured; skipping bot startup");
    return;
  }
  if (discordStartInProgress) {
    return;
  }

  discordStartInProgress = true;
  clearDiscordReconnectTimer();
  try {
    resetDiscordClient();

    const commands = createSlashCommands();
    const rest = new REST({ version: "10" }).setToken(CONFIG.discordBotToken);
    await rest.put(
      Routes.applicationCommands(CONFIG.discordApplicationId),
      { body: commands.map((command) => ({ ...command.toJSON(), dm_permission: false })) }
    );
    console.log(`Registered ${commands.length} Discord slash commands`);
    if (CONFIG.discordAllowedUserIds.size > 0) {
      console.log(`Discord slash command allowlist active: ${CONFIG.discordAllowedUserIds.size} user(s)`);
    } else {
      console.log("Discord slash command allowlist disabled; guild administrators are allowed.");
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    discordClient = client;
    client.once(Events.ClientReady, (readyClient) => {
      clearDiscordReconnectTimer();
      discordAutoMessageFailureCount = 0;
      console.log(`Discord bot connected as ${readyClient.user.tag}`);
      void startDiscordAutoMessageLoop(readyClient);
    });
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      await handleDiscordInteraction(interaction);
    });
    client.on(Events.Error, (error) => {
      console.error("Discord client error", error);
      scheduleDiscordReconnect("client-error");
    });
    client.on(Events.ShardDisconnect, (event, shardId) => {
      console.warn(`Discord shard ${shardId} disconnected (${event.code || "n/a"})`);
      scheduleDiscordReconnect("shard-disconnect");
    });
    client.on(Events.ShardResume, (shardId) => {
      clearDiscordReconnectTimer();
      console.log(`Discord shard ${shardId} resumed`);
    });
    client.on(Events.Invalidated, () => {
      console.error("Discord session invalidated");
      scheduleDiscordReconnect("session-invalidated", 5000);
    });

    await client.login(CONFIG.discordBotToken);
  } catch (error) {
    console.error("Discord bot startup failed", error);
    scheduleDiscordReconnect("startup-failed");
  } finally {
    discordStartInProgress = false;
  }
}

async function queryCount(text, params = []) {
  const row = await queryOne(text, params);
  return Number(row?.c || 0);
}

function formatUptimeShort(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

async function buildDiscordServerStatsMessage(now = Date.now()) {
  const thirtySecondsAgo = now - 30000;
  const oneHourAgo = now - (60 * 60 * 1000);
  const [
    totalKeys,
    activeKeys,
    sharedKeys,
    blacklistedKeys,
    activeSessions,
    onlineUsers,
    chatLastHour
  ] = await Promise.all([
    queryCount("SELECT COUNT(*)::int AS c FROM keys"),
    queryCount(
      `
        SELECT COUNT(*)::int AS c
        FROM keys k
        LEFT JOIN blacklist b ON b.key_id = k.key_id
        WHERE k.paused = FALSE
          AND b.key_id IS NULL
          AND (k.expires IS NULL OR k.expires = 0 OR k.expires > $1)
      `,
      [now]
    ),
    queryCount("SELECT COUNT(*)::int AS c FROM keys WHERE shared = TRUE"),
    queryCount("SELECT COUNT(*)::int AS c FROM blacklist"),
    queryCount("SELECT COUNT(*)::int AS c FROM sessions WHERE expires > $1", [now]),
    queryCount("SELECT COUNT(*)::int AS c FROM presence WHERE last_seen > $1", [thirtySecondsAgo]),
    queryCount("SELECT COUNT(*)::int AS c FROM chat WHERE timestamp > $1", [oneHourAgo])
  ]);

  const generatedAtUnix = Math.floor(now / 1000);
  const lines = [
    "Render server stats",
    `Uptime: ${formatUptimeShort(process.uptime())}`,
    `Sessions: ${activeSessions} active`,
    `Presence: ${onlineUsers} online`,
    `Keys: ${activeKeys}/${totalKeys} active`,
    `Shared keys: ${sharedKeys}`,
    `Blacklisted keys: ${blacklistedKeys}`,
    `Chat (last 1h): ${chatLastHour}`,
    `Updated: <t:${generatedAtUnix}:R>`
  ];
  return truncate(lines.join("\n"), 1800);
}

async function startDiscordAutoMessageLoop(client) {
  const channelId = String(CONFIG.discordAutoMessageChannelId || "").trim();
  if (!/^\d{10,22}$/.test(channelId)) {
    console.log("Discord auto message disabled: invalid DISCORD_AUTO_MESSAGE_CHANNEL_ID");
    return;
  }

  const mode = String(CONFIG.discordAutoMessageMode || DEFAULT_DISCORD_AUTO_MESSAGE_MODE).trim().toLowerCase();
  const message = String(CONFIG.discordAutoMessageText || "").trim() || DEFAULT_DISCORD_AUTO_MESSAGE_TEXT;
  const intervalMs = Math.max(60 * 1000, Number(CONFIG.discordAutoMessageIntervalMs) || DEFAULT_DISCORD_AUTO_MESSAGE_INTERVAL_MS);
  clearDiscordAutoMessageLoop();

  const buildAutoMessage = async () => {
    if (mode === "stats") {
      try {
        return await buildDiscordServerStatsMessage(Date.now());
      } catch (error) {
        console.error("Failed to build Discord stats message; falling back to DISCORD_AUTO_MESSAGE_TEXT", error);
      }
    }
    return message;
  };

  const sendAutoMessage = async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`Discord auto message skipped: channel ${channelId} is missing or not text-based.`);
        return;
      }
      const outboundMessage = await buildAutoMessage();
      await channel.send(outboundMessage);
      discordAutoMessageFailureCount = 0;
      console.log(`Discord auto message sent to channel ${channelId}`);
    } catch (error) {
      discordAutoMessageFailureCount += 1;
      console.error(`Discord auto message failed for channel ${channelId}`, error);
      if (discordAutoMessageFailureCount >= 3) {
        scheduleDiscordReconnect("auto-message-failures");
      }
    }
  };

  console.log(
    mode === "stats"
      ? `Discord auto message enabled in stats mode to channel ${channelId} every ${Math.floor(intervalMs / 60000)} minute(s).`
      : `Discord auto message enabled: "${message}" to channel ${channelId} every ${Math.floor(intervalMs / 60000)} minute(s).`
  );

  await sendAutoMessage();
  discordAutoMessageTimer = setInterval(() => {
    void sendAutoMessage();
  }, intervalMs);
}

async function handleDiscordInteraction(interaction) {
  try {
    if (!isDiscordUserAllowed(interaction)) {
      const reason = CONFIG.discordAllowedUserIds.size > 0
        ? "You are not on DISCORD_ALLOWED_USER_IDS."
        : "You must be a server administrator to use Render auth commands.";
      await interaction.reply({
        embeds: [errorEmbed("Access Denied", reason)],
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    let response;
    switch (interaction.commandName) {
      case "genkey":
        response = await discordCmdGenKey(interaction);
        break;
      case "genadminkey":
        response = await discordCmdGenAdminKey(interaction);
        break;
      case "keys":
        response = await discordCmdListKeys();
        break;
      case "stats":
        response = await discordCmdStats();
        break;
      case "keyinfo":
        response = await discordCmdKeyInfo(interaction);
        break;
      case "deletekey":
        response = await discordCmdDeleteKey(interaction);
        break;
      case "deleteallkeys":
        response = await discordCmdDeleteAll();
        break;
      case "conpensate":
      case "compensate":
        response = await discordCmdCompensate(interaction);
        break;
      case "pause":
        response = await discordCmdPause(interaction);
        break;
      case "resethwid":
        response = await discordCmdResetHwid(interaction);
        break;
      case "blacklist":
        response = await discordCmdBlacklist(interaction);
        break;
      case "jumpscare":
        response = await discordCmdJumpscare(interaction);
        break;
      case "service":
        response = await discordCmdService(interaction);
        break;
      default:
        response = { embeds: [errorEmbed("Unknown Command", "This slash command is not implemented.")] };
        break;
    }
    await interaction.editReply(response);
  } catch (error) {
    console.error("Discord interaction failed", error);
    const fallback = { embeds: [errorEmbed("Error", error.message || "Command failed.")] };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(fallback).catch(() => {});
      return;
    }
    await interaction.reply({ ...fallback, ephemeral: true }).catch(() => {});
  }
}

async function discordCmdGenKey(interaction) {
  const amount = Math.min(Math.max(interaction.options.getInteger("amount") || 1, 1), 50);
  const requestedDuration = interaction.options.getString("duration") || "lifetime";
  const parsed = getKeyExpiryFromDuration(requestedDuration);
  if (!parsed.ok) {
    return { embeds: [errorEmbed("Invalid Duration", parsed.error)] };
  }

  const shared = Boolean(interaction.options.getBoolean("shared"));
  const maxUsesInput = interaction.options.getInteger("maxuses") || 0;
  const maxUses = shared ? Math.max(0, Math.min(100000, maxUsesInput)) : 0;
  const generatedKeys = [];

  for (let index = 0; index < amount; index += 1) {
    generatedKeys.push(await createUniqueKey({
      prefix: "MOPE",
      formatter: formatKeyForDisplay,
      expires: parsed.expires,
      shared,
      maxUses,
      isAdmin: false
    }));
  }

  return {
    embeds: [
      successEmbed("Keys Generated", `Created ${generatedKeys.length} key(s).`, [
        { name: "Licenses", value: joinCodeBlockLines(generatedKeys), inline: false },
        { name: "Duration", value: parsed.duration, inline: true },
        { name: "Expires", value: formatExpiryForDiscord(parsed.expires), inline: true },
        { name: "Key Type", value: shared ? "Shared Event Key" : "Single Device Key", inline: true },
        { name: "Max Uses", value: shared ? (maxUses > 0 ? `${maxUses} unique HWIDs` : "Unlimited") : "1 HWID", inline: true }
      ])
    ]
  };
}

async function discordCmdGenAdminKey(interaction) {
  const requestedDuration = interaction.options.getString("duration") || "lifetime";
  const parsed = getKeyExpiryFromDuration(requestedDuration);
  if (!parsed.ok) {
    return { embeds: [errorEmbed("Invalid Duration", parsed.error)] };
  }

  const key = await createUniqueKey({
    prefix: "ADMIN",
    formatter: formatAdminKeyForDisplay,
    expires: parsed.expires,
    shared: false,
    maxUses: 0,
    isAdmin: true
  });

  return {
    embeds: [
      successEmbed("Admin Key Generated", "Created 1 admin key.", [
        { name: "Admin License", value: `\`${key}\``, inline: false },
        { name: "Duration", value: parsed.duration, inline: true },
        { name: "Expires", value: formatExpiryForDiscord(parsed.expires), inline: true },
        { name: "Warning", value: "This key has full admin panel access.", inline: false }
      ], 0xff6600)
    ]
  };
}

async function discordCmdListKeys() {
  const countRow = await queryOne("SELECT COUNT(*)::int AS c FROM keys");
  const result = await query("SELECT * FROM keys ORDER BY created_at DESC LIMIT 15");
  if (result.rows.length === 0) {
    return { embeds: [infoEmbed("No keys found.")] };
  }

  const lines = result.rows.map((row) => {
    const isShared = Boolean(row.shared);
    const status = row.paused ? "[PAUSED]" : (isShared ? "[SHARED]" : (row.hwid ? "[LOCKED]" : "[NEW]"));
    const mode = isShared ? (Number(row.max_uses || 0) > 0 ? ` (shared, max ${row.max_uses})` : " (shared, unlimited)") : "";
    const displayed = row.is_admin ? formatAdminKeyForDisplay(row.key_id) : formatKeyForDisplay(row.key_id);
    return `${status} \`${displayed}\`${mode}`;
  });

  return {
    embeds: [
      infoEmbed(`Recent Keys (${Number(countRow?.c || 0)} total)`, [
        { name: "Latest 15", value: truncate(lines.join("\n"), 1024), inline: false }
      ])
    ]
  };
}

async function discordCmdStats() {
  const [total, single, shared, activeSessions, activations] = await Promise.all([
    queryOne("SELECT COUNT(*)::int AS c FROM keys"),
    queryOne("SELECT COUNT(*)::int AS c FROM keys WHERE NOT COALESCE(shared, FALSE)"),
    queryOne("SELECT COUNT(*)::int AS c FROM keys WHERE COALESCE(shared, FALSE)"),
    queryOne("SELECT COUNT(*)::int AS c FROM sessions"),
    queryOne("SELECT COUNT(*)::int AS c FROM key_activations")
  ]);

  return {
    embeds: [
      infoEmbed("Backend Stats", [
        { name: "Total Keys", value: String(total?.c || 0), inline: true },
        { name: "Single Keys", value: String(single?.c || 0), inline: true },
        { name: "Shared Keys", value: String(shared?.c || 0), inline: true },
        { name: "Live Sessions", value: String(activeSessions?.c || 0), inline: true },
        { name: "Shared Activations", value: String(activations?.c || 0), inline: true }
      ])
    ]
  };
}

async function discordCmdKeyInfo(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  if (!key) {
    return { embeds: [errorEmbed("Invalid Key", "You must provide a valid key.")] };
  }

  const data = await queryOne("SELECT * FROM keys WHERE key_id = $1", [key]);
  if (!data) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }

  const isShared = Boolean(data.shared);
  const usage = isShared
    ? await queryOne("SELECT COUNT(*)::int AS c FROM key_activations WHERE key_id = $1", [key])
    : null;
  const liveSessions = await queryOne(
    "SELECT COUNT(*)::int AS c FROM sessions WHERE key_id = $1 AND expires > $2",
    [key, Date.now()]
  );
  const livePresence = await queryOne(
    `
      SELECT username, server, server_id, last_seen, frozen, blinded
      FROM presence
      WHERE key_id = $1
      ORDER BY last_seen DESC
      LIMIT 1
    `,
    [key]
  );

  const displayKey = data.is_admin ? formatAdminKeyForDisplay(data.key_id) : formatKeyForDisplay(data.key_id);
  const fields = [
    { name: "Key", value: `\`${displayKey}\``, inline: true },
    { name: "Type", value: data.is_admin ? "Admin Key" : (isShared ? "Shared Event Key" : "Single Device Key"), inline: true },
    { name: "Status", value: data.paused ? "Paused" : "Active", inline: true },
    { name: "Expires", value: formatExpiryForDiscord(data.expires), inline: false },
    { name: "Live Sessions", value: String(liveSessions?.c || 0), inline: true },
    { name: "Last HWID", value: `\`${data.last_hwid || data.hwid || "N/A"}\``, inline: true },
    { name: "Last IP", value: maskIp(data.last_ip), inline: true },
    { name: "Last Seen", value: formatTimestamp(data.last_seen_at), inline: true },
    { name: "Last User", value: data.last_username || livePresence?.username || "Unknown", inline: true },
    { name: "Last Server", value: data.last_server || livePresence?.server || "Unknown", inline: true }
  ];

  if (isShared) {
    fields.push({ name: "Max Uses", value: Number(data.max_uses || 0) > 0 ? `${data.max_uses} unique HWIDs` : "Unlimited", inline: true });
    fields.push({ name: "Used Slots", value: String(usage?.c || 0), inline: true });
  } else {
    fields.push({ name: "HWID", value: `\`${data.hwid || "N/A"}\``, inline: false });
  }

  if (livePresence) {
    fields.push({
      name: "Online Now",
      value: `${livePresence.username || "Unknown"} on ${livePresence.server || "Unknown"}`,
      inline: false
    });
  }

  return { embeds: [infoEmbed("Key Info", fields)] };
}

async function discordCmdCompensate(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  const days = interaction.options.getInteger("days");
  if (!key) {
    return { embeds: [errorEmbed("Invalid Key", "You must provide a valid key.")] };
  }

  const data = await queryOne("SELECT expires FROM keys WHERE key_id = $1", [key]);
  if (!data) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }
  if (isMissingExpiryValue(data.expires)) {
    return { embeds: [infoEmbed("Lifetime keys do not need compensation.")] };
  }

  const currentExpiry = parseExpiryMs(data.expires);
  if (!currentExpiry) {
    return { embeds: [errorEmbed("Invalid Expiry", "Stored expiry is invalid.")] };
  }

  const nextExpiry = Math.max(currentExpiry, Date.now()) + (days * 24 * 60 * 60 * 1000);
  await query("UPDATE keys SET expires = $1 WHERE key_id = $2", [nextExpiry, key]);

  return {
    embeds: [
      successEmbed("Key Compensated", null, [
        { name: "Key", value: `\`${formatKeyForDisplay(key)}\``, inline: false },
        { name: "Added", value: `${days} day(s)`, inline: true },
        { name: "Old Expiry", value: formatExpiryForDiscord(currentExpiry), inline: true },
        { name: "New Expiry", value: formatExpiryForDiscord(nextExpiry), inline: true }
      ])
    ]
  };
}

async function discordCmdDeleteKey(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  if (!key) {
    return { embeds: [errorEmbed("Invalid Key", "You must provide a valid key.")] };
  }

  await query("DELETE FROM sessions WHERE key_id = $1", [key]);
  await query("DELETE FROM presence WHERE key_id = $1", [key]);
  await query("DELETE FROM key_activations WHERE key_id = $1", [key]);
  await query("DELETE FROM kicked_clients WHERE key_id = $1", [key]);
  await query("DELETE FROM blacklist WHERE key_id = $1", [key]);
  const deleted = await query("DELETE FROM keys WHERE key_id = $1", [key]);
  if (deleted.rowCount === 0) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }

  return { embeds: [successEmbed("Key Deleted", `Deleted \`${formatKeyForDisplay(key)}\` and related sessions.`)] };
}

async function discordCmdDeleteAll() {
  await query("DELETE FROM sessions");
  await query("DELETE FROM presence");
  await query("DELETE FROM chat");
  await query("DELETE FROM key_activations");
  await query("DELETE FROM kicked_clients");
  await query("DELETE FROM blacklist");
  const deletedKeys = await query("DELETE FROM keys");

  return {
    embeds: [
      successEmbed("All Keys Deleted", `Deleted ${deletedKeys.rowCount} key(s) plus all sessions, activations, presence, blacklist, and chat data.`, [], 0xff0000)
    ]
  };
}

async function discordCmdPause(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  const data = await queryOne("SELECT paused FROM keys WHERE key_id = $1", [key]);
  if (!data) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }
  const nextState = !Boolean(data.paused);
  await query("UPDATE keys SET paused = $1 WHERE key_id = $2", [nextState, key]);
  return { embeds: [infoEmbed(nextState ? "Key Paused" : "Key Resumed")] };
}

async function discordCmdResetHwid(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  const data = await queryOne("SELECT shared FROM keys WHERE key_id = $1", [key]);
  if (!data) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }

  if (data.shared) {
    await query("DELETE FROM sessions WHERE key_id = $1", [key]);
    await query("DELETE FROM presence WHERE key_id = $1", [key]);
    await query("DELETE FROM key_activations WHERE key_id = $1", [key]);
  } else {
    await query("UPDATE keys SET hwid = NULL WHERE key_id = $1", [key]);
    await query("DELETE FROM sessions WHERE key_id = $1", [key]);
    await query("DELETE FROM presence WHERE key_id = $1", [key]);
  }
  await query("DELETE FROM kicked_clients WHERE key_id = $1", [key]);

  return {
    embeds: [
      successEmbed(
        data.shared ? "Shared Usage Reset" : "HWID Reset",
        data.shared
          ? `Reset shared usage slots for \`${formatKeyForDisplay(key)}\`.`
          : `Reset HWID for \`${formatKeyForDisplay(key)}\`.`
      )
    ]
  };
}

async function discordCmdBlacklist(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  const exists = await queryOne("SELECT 1 FROM keys WHERE key_id = $1", [key]);
  if (!exists) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }

  await query(
    `
      INSERT INTO blacklist (key_id)
      VALUES ($1)
      ON CONFLICT (key_id) DO NOTHING
    `,
    [key]
  );
  return { embeds: [successEmbed("Key Blacklisted", `Blacklisted \`${formatKeyForDisplay(key)}\`.`)] };
}

async function discordCmdJumpscare(interaction) {
  const key = normalizeKey(interaction.options.getString("key"));
  const updated = await query("UPDATE keys SET jumpscare = TRUE WHERE key_id = $1", [key]);
  if (updated.rowCount === 0) {
    return { embeds: [errorEmbed("Key not found", "No key matched that value.")] };
  }
  return { embeds: [successEmbed("Jumpscare Queued", `Queued a jumpscare for \`${formatKeyForDisplay(key)}\`.`)] };
}

function isServiceSshConfigured() {
  if (!CONFIG.serviceSshHost || !CONFIG.serviceSshUsername) {
    return false;
  }
  return Boolean(CONFIG.serviceSshPassword || CONFIG.serviceSshPrivateKey);
}

function getServiceSshConnectConfig() {
  const base = {
    host: CONFIG.serviceSshHost,
    port: CONFIG.serviceSshPort,
    username: CONFIG.serviceSshUsername,
    readyTimeout: Math.max(1000, CONFIG.serviceSshCommandTimeoutMs),
    keepaliveInterval: 10000,
    keepaliveCountMax: 2
  };
  if (CONFIG.serviceSshPrivateKey) {
    return {
      ...base,
      privateKey: CONFIG.serviceSshPrivateKey,
      passphrase: CONFIG.serviceSshPassphrase || undefined
    };
  }
  return {
    ...base,
    password: CONFIG.serviceSshPassword
  };
}

function appendLimited(output, chunk, limit) {
  if (output.length >= limit) {
    return output;
  }
  const next = output + String(chunk || "");
  if (next.length <= limit) {
    return next;
  }
  return next.slice(0, limit);
}

function clipForCodeBlock(value, maxLength = 1900) {
  const text = String(value || "").trim();
  if (!text) {
    return "(no output)";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

async function runServiceSshCommand(command) {
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    let settled = false;
    let stdout = "";
    let stderr = "";
    const outputLimit = 12000;
    const timeoutMs = CONFIG.serviceSshCommandTimeoutMs;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        ssh.end();
      } catch {
      }
      resolve(result);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        ssh.end();
      } catch {
      }
      reject(error instanceof Error ? error : new Error(String(error || "SSH command failed")));
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`SSH command timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);

    ssh.on("ready", () => {
      ssh.exec(command, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        stream.on("data", (chunk) => {
          stdout = appendLimited(stdout, chunk, outputLimit);
        });
        stream.stderr.on("data", (chunk) => {
          stderr = appendLimited(stderr, chunk, outputLimit);
        });
        stream.on("close", (code, signal) => {
          finish({
            code: Number.isFinite(Number(code)) ? Number(code) : null,
            signal: signal || null,
            stdout,
            stderr
          });
        });
        stream.on("error", fail);
      });
    });

    ssh.on("error", fail);
    ssh.on("timeout", () => fail(new Error("SSH connection timed out")));
    ssh.connect(getServiceSshConnectConfig());
  });
}

async function discordCmdService(interaction) {
  if (!CONFIG.serviceSshEnabled) {
    return { embeds: [errorEmbed("Service SSH Disabled", "Set SERVICE_SSH_ENABLED=true to enable this command.")] };
  }
  if (!isServiceSshConfigured()) {
    return {
      embeds: [
        errorEmbed(
          "Service SSH Not Configured",
          "Set SERVICE_SSH_HOST, SERVICE_SSH_PORT, SERVICE_SSH_USERNAME and password/private key env vars."
        )
      ]
    };
  }

  const actions = getConfiguredServiceActions();
  if (actions.length === 0) {
    return {
      embeds: [
        errorEmbed(
          "No Service Actions Configured",
          "Set SERVICE_SSH_COMMANDS like status=systemctl status myservice --no-pager;restart=systemctl restart myservice"
        )
      ]
    };
  }

  const actionInput = interaction.options.getString("action");
  const actionKey = normalizeServiceAction(actionInput);
  if (!actionKey) {
    return {
      embeds: [
        infoEmbed("Available Service Actions", [
          { name: "Target", value: `${CONFIG.serviceSshHost}:${CONFIG.serviceSshPort}`, inline: true },
          { name: "Actions", value: actions.map((entry) => `\`${entry}\``).join(", "), inline: false }
        ])
      ]
    };
  }

  const command = CONFIG.serviceSshCommandMap.get(actionKey);
  if (!command) {
    return {
      embeds: [
        errorEmbed(
          "Unknown Service Action",
          `Action \`${actionKey}\` is not configured. Available: ${actions.map((entry) => `\`${entry}\``).join(", ")}`
        )
      ]
    };
  }

  const startedAt = Date.now();
  try {
    const result = await runServiceSshCommand(command);
    const elapsedMs = Date.now() - startedAt;
    const status = result.code === 0 ? "Success" : "Non-zero Exit";
    const outputText = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      embeds: [
        successEmbed(`Service Action: ${actionKey}`, null, [
          { name: "Target", value: `${CONFIG.serviceSshHost}:${CONFIG.serviceSshPort}`, inline: true },
          { name: "Exit Code", value: result.code === null ? "N/A" : String(result.code), inline: true },
          { name: "Duration", value: `${elapsedMs}ms`, inline: true },
          { name: "Status", value: status, inline: true },
          { name: "Output", value: `\`\`\`\n${clipForCodeBlock(outputText)}\n\`\`\``, inline: false }
        ], result.code === 0 ? 0x00ff00 : 0xffaa00)
      ]
    };
  } catch (error) {
    return {
      embeds: [
        errorEmbed(
          `Service Action Failed: ${actionKey}`,
          `Target ${CONFIG.serviceSshHost}:${CONFIG.serviceSshPort}\n${truncate(error.message || "SSH execution failed", 3500)}`
        )
      ]
    };
  }
}

async function createUniqueKey({ prefix, formatter, expires, shared, maxUses, isAdmin }) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const normalized = prefix === "ADMIN"
      ? `ADMIN${randStr(12)}`
      : `MOPE${randStr(4)}${randStr(4)}${randStr(6)}`;
    try {
      await query(
        `
          INSERT INTO keys (key_id, expires, shared, max_uses, is_admin)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [normalized, expires, shared, maxUses, isAdmin]
      );
      return formatter(normalized);
    } catch (error) {
      if (String(error.code) === "23505") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not generate a unique key after several attempts.");
}

function joinCodeBlockLines(lines) {
  return truncate(lines.map((line) => `\`${line}\``).join("\n"), 1024);
}

function successEmbed(title, description = null, fields = [], color = 0x00ff00) {
  return baseEmbed(title, description, fields, color);
}

function errorEmbed(title, description) {
  return baseEmbed(title, description, [], 0xff0000);
}

function infoEmbed(description, fields = [], color = 0x5865f2) {
  return baseEmbed(null, description, fields, color);
}

function baseEmbed(title, description, fields, color) {
  const embed = new EmbedBuilder().setColor(color);
  if (title) {
    embed.setTitle(truncate(title, 256));
  }
  if (description) {
    embed.setDescription(truncate(description, 4096));
  }
  if (fields.length > 0) {
    embed.addFields(fields.map((field) => ({
      name: truncate(field.name, 256),
      value: truncate(String(field.value || "\u200b"), 1024),
      inline: Boolean(field.inline)
    })));
  }
  return embed;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function randStr(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

function formatKeyForDisplay(key) {
  const normalized = normalizeKey(key) || "";
  if (normalized.startsWith("ADMIN")) {
    return formatAdminKeyForDisplay(normalized);
  }
  if (normalized.startsWith("MOPE") && normalized.length >= 18) {
    return `MOPE-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12)}`;
  }
  return normalized;
}

function formatAdminKeyForDisplay(key) {
  const normalized = normalizeKey(key) || "";
  if (normalized.startsWith("ADMIN") && normalized.length >= 17) {
    return `ADMIN-${normalized.slice(5, 9)}-${normalized.slice(9, 13)}-${normalized.slice(13)}`;
  }
  return normalized;
}

function getKeyExpiryFromDuration(input) {
  const raw = String(input || "lifetime").trim().toLowerCase();
  if (!raw || raw === "lifetime" || raw === "forever" || raw === "permanent") {
    return { ok: true, duration: "Lifetime", expires: null };
  }
  const match = raw.match(/^(\d+)\s*([mhdw])$/);
  if (!match) {
    return { ok: false, error: "Use lifetime or values like 12h, 7d, 30d, 4w." };
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Duration must be a positive value." };
  }

  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  const labels = {
    m: "minute",
    h: "hour",
    d: "day",
    w: "week"
  };
  const expires = Date.now() + (amount * multipliers[unit]);
  const label = `${amount} ${labels[unit]}${amount === 1 ? "" : "s"}`;
  return { ok: true, duration: label, expires };
}

function formatExpiryForDiscord(expires) {
  const expiryMs = parseExpiryMs(expires);
  return expiryMs ? new Date(expiryMs).toISOString().replace(".000Z", " UTC") : "Lifetime";
}

function formatTimestamp(value) {
  const parsed = parseExpiryMs(value);
  return parsed ? new Date(parsed).toISOString().replace(".000Z", " UTC") : "Never";
}

function maskIp(ip) {
  const value = String(ip || "").trim();
  if (!value) {
    return "N/A";
  }
  const ipv4 = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    return `${ipv4[1]}.${ipv4[2]}.x.x`;
  }
  return value.length > 8 ? `${value.slice(0, 8)}...` : value;
}

function isMissingExpiryValue(value) {
  return value === null || value === undefined || value === "" || String(value).trim().toLowerCase() === "null";
}

async function bootstrapKeys() {
  if (CONFIG.bootstrapAdminKey) {
    await query(
      `
        INSERT INTO keys (key_id, expires, is_admin, shared, max_uses)
        VALUES ($1, $2, TRUE, FALSE, 0)
        ON CONFLICT (key_id) DO UPDATE SET
          expires = EXCLUDED.expires,
          is_admin = TRUE
      `,
      [CONFIG.bootstrapAdminKey, CONFIG.bootstrapAdminExpires]
    );
  }

  if (CONFIG.bootstrapTestKey) {
    await query(
      `
        INSERT INTO keys (key_id, expires, is_admin, shared, max_uses)
        VALUES ($1, $2, FALSE, FALSE, 0)
        ON CONFLICT (key_id) DO UPDATE SET
          expires = EXCLUDED.expires
      `,
      [CONFIG.bootstrapTestKey, CONFIG.bootstrapTestExpires]
    );
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});

main().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
