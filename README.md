# Render License Backend

Express + Postgres backend for:

- license key login
- session heartbeats
- encrypted script delivery
- presence and chat
- admin controls

The service seeds optional bootstrap keys from environment variables:

- `BOOTSTRAP_ADMIN_KEY`
- `BOOTSTRAP_TEST_KEY`

Discord auto message (defaults to posting `render is best in` every 10 minutes):

- `DISCORD_AUTO_MESSAGE_CHANNEL_ID`
- `DISCORD_AUTO_MESSAGE_MODE` (`stats` or `text`, defaults to `stats`)
- `DISCORD_AUTO_MESSAGE_TEXT`
- `DISCORD_AUTO_MESSAGE_INTERVAL_MS`
- `DISCORD_RECONNECT_DELAY_MS` (auto-reconnect delay after Discord disconnect/error)

Uptime helpers for long-running deployments:

- `SELF_PING_ENABLED` (`true` by default)
- `SELF_PING_INTERVAL_MS` (defaults to 5 minutes)
- `SELF_PING_URL` (optional; falls back to `RENDER_EXTERNAL_URL` when present)

Discord SSH service bridge:

- `SERVICE_SSH_ENABLED` (`true` to enable `/service`)
- `SERVICE_SSH_HOST` (example: `satanc2.top`)
- `SERVICE_SSH_PORT` (example: `2115`)
- `SERVICE_SSH_USERNAME`
- `SERVICE_SSH_PASSWORD` (optional if private key is used)
- `SERVICE_SSH_PRIVATE_KEY` (raw key text with `\n` escapes) or `SERVICE_SSH_PRIVATE_KEY_B64` (base64)
- `SERVICE_SSH_PASSPHRASE` (optional, for encrypted private keys)
- `SERVICE_SSH_COMMAND_TIMEOUT_MS` (defaults to 20000)
- `SERVICE_SSH_COMMANDS` allowlisted actions in `name=command` format separated by `;` or newline
  - Example:
    - `status=systemctl status your-service --no-pager;restart=systemctl restart your-service;logs=journalctl -u your-service -n 120 --no-pager`

Usage:

- `/service` to list configured action names
- `/service action:<name>` to run one configured action over SSH

`private-script.js` is the script payload served from `/script`.
`/bootstrap-script` serves the same payload as plain JavaScript for `loader.js`.
Run `powershell -ExecutionPolicy Bypass -File .\tools\sync-mope-source.ps1` from the repo root to sync `mope source.js` into `backend/private-script.js`.
