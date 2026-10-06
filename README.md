# Codex Telegram Bridge

[English](README.md) · [Русский](README.ru.md)

Control your local Codex desktop chats from a Telegram bot. Receive completed results and errors, choose a chat, and send text, images or voice messages back to that chat from your phone.

This is an independent community project, not an official OpenAI or Telegram integration. It uses the Codex desktop application's internal Windows IPC protocol and local chat database. Compatibility can change after a Codex update.

## Features

- **One chat or all chats.** Select one chat for ordinary messages, or receive results from all chats and reply to a specific notification.
- **Quiet notifications.** Completed results and errors are forwarded; routine progress and delivery acknowledgements stay silent.
- **Text, pictures and voice.** Voice messages are transcribed locally with faster-whisper before being sent to Codex.
- **Continue existing work.** Messages start a turn in an idle chat or steer its running turn through the desktop owner.
- **Persistent delivery state.** SQLite stores routes and queues. Ambiguous delivery is marked for manual review instead of blindly sending the same prompt again.
- **Explicit user access.** Private Telegram chats only, with a configured owner and optional additional users.
- **Two transports.** Direct Telegram polling, or an optional PHP/MySQL HTTPS relay with a webhook and a fast chat menu.

The bot's current interface and status messages are in Russian. Documentation is available in English and Russian.

## How it works

```text
Telegram bot <-> Windows bridge <-> Codex desktop IPC
                     |
                local SQLite
                     |
             optional local Whisper

Optional inbound transport:
Telegram webhook -> PHP/MySQL relay <- Windows bridge polls over HTTPS
```

The Windows computer and Codex must be running. The relay can retain inbound messages while the computer is offline, but it cannot run Codex itself. Results and media still travel through Telegram's Bot API. No public inbound port is needed on the computer.

## Requirements

- Windows with a running, signed-in Codex desktop app under the same Windows account.
- Node.js **22.13 or newer** with `node:sqlite`; checks were run locally with Node.js 22.19.
- Windows PowerShell 5.1 for DPAPI secret storage (included in Windows).
- A Telegram bot token from [BotFather](https://t.me/BotFather) and your numeric Telegram user ID.
- Optional voice support: Python 3.10+, the dependencies in `speech/requirements.txt`, and a local faster-whisper model.
- Optional relay: PHP 8.1+, PDO MySQL, cURL, mbstring, MySQL/MariaDB and HTTPS hosting.

No npm dependencies are required. This version expects the local `state_5.sqlite` chat schema and IPC stream version 11. Other operating systems, cloud chats and future IPC versions are not supported by this release.

## Quick start: direct polling

1. Clone the repository and open PowerShell in its directory:

   ```powershell
   git clone https://github.com/belvision/codex-telegram-bridge.git
   cd codex-telegram-bridge
   ```

2. Use a dedicated bot with no webhook and no other polling process. Run setup with **your own** numeric Telegram ID:

   ```powershell
   powershell.exe -NoProfile -File .\scripts\setup.ps1 -OwnerUserId 123456789
   ```

   The script prompts for the token without echoing it, encrypts it with Windows DPAPI, and writes settings to `%LOCALAPPDATA%\CodexTelegramBridge`. The ID shown above is a placeholder. Setup refuses to overwrite existing configuration.

3. Open the chats you want to control in Codex, then start the bridge:

   ```powershell
   npm start
   ```

4. Send `/start` to your bot. Choose **Один чат** (one chat) and select a chat, or **Все чаты** (all chats).

For a hidden background process, run `wscript.exe desktop\start-hidden.vbs`. It looks for Node.js in the standard Program Files location or `C:\nvm4w\nodejs`; adjust that launcher if Node is elsewhere. It restarts the bridge after 30 seconds if the process exits. To stop it permanently, stop both the launcher and its Node child. Do not run multiple copies for the same bot.

## Commands and routing

| Command | Purpose |
| --- | --- |
| `/start`, `/mode` | Choose one-chat or all-chats mode |
| `/chat` | Select a chat from the list |
| `/status` | Inspect connection and queue status |

In one-chat mode, ordinary messages, pictures and voice notes go to the selected chat. In all-chats mode, use Telegram Reply on a notification or its **Ответить** button. **Только этот чат** switches to that notification's chat. A reply to an older notification in one-chat mode is routed to the currently selected chat.

Approvals are not automatically granted. This release forwards only final/error notifications, so watch the desktop for permission requests or other blocking prompts. Text replies in a selected chat can answer its pending structured input form. Existing historical results are baselined silently on the first scan.

## Private configuration

`desktop/config.example.json` documents the configuration shape. Real `config.json`, DPAPI files, `bridge.sqlite`, downloaded media, logs and `status.json` belong in the private directory, outside the checkout.

- `ownerUserId` and `ownerChatId`: your numeric Telegram user ID; both must match.
- `additionalUsers`: optional array of numeric user IDs. Each allowed user can access the same local chat catalog and control those chats; this is not a tenant-isolation system.
- `relayUrl`: empty for direct polling, or the HTTPS URL of `telegram-relay.php`.
- `voiceLanguage`: recognition language, default `ru`.
- `whisperRoot`: optional absolute path containing the Python environment, worker and model; defaults to the repository's `speech` directory.
- `initialUpdateOffset`: normally `0`, used only before a local polling offset exists.

Set `CODEX_TELEGRAM_HOME` to use another private directory, and use setup's `-PrivateDirectory` with the same path. `CODEX_HOME` is respected when locating Codex's chat database. DPAPI files can only be decrypted by the Windows account that created them.

## Optional local voice recognition

From the repository directory:

```powershell
python -m venv speech\.venv
speech\.venv\Scripts\python.exe -m pip install -r speech\requirements.txt
speech\.venv\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('mobiuslabsgmbh/faster-whisper-large-v3-turbo', local_dir='speech/models/turbo')"
```

Model installation requires internet access and disk space. Recognition then runs locally on the CPU with networking disabled for model loading. Audio is limited by this implementation to 20 MiB and 10 minutes. The transcript is passed to Codex; Telegram still transports the original voice message. Without the environment and model, text and pictures work, while voice recognition reports an error. Model files and environments are not included in the repository and retain their upstream licenses.

## Optional HTTPS relay

The server code is extracted from the original deployment and packaged independently. It retains some internal `BookRelay` / `BookTelegram` names and the `X-Book-Relay-Key` header for compatibility; no book application is required.

1. Upload `server/` and configure your web server's document root to **`server/public` only**. Keep `core/`, `bin/`, the SQL schema and configuration outside the public root. Disable PHP error display in production.
2. Create a dedicated MySQL database/user and import `server/schema.sql`.
3. Create a private directory outside the public root. Set `CODEX_TELEGRAM_PRIVATE_DIR` to its absolute path for both PHP web requests and CLI commands.
4. Copy `server/config.example.php` there as `config.php`. Set the database credentials, bot token, bot ID (the numeric part before the token's colon), owner IDs, public webhook URL and a random relay key. Generate the relay key and webhook secret independently using a cryptographic generator, for example `php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'`.
5. Save the separate 64-character hexadecimal webhook secret in the private file `webhook-secret`. Give the PHP service account write access to the private directory for the catalog and lock file; restrict other users. Add `allowed-users.json` containing an array of additional numeric IDs if needed, and use the same allowlist in the desktop configuration.
6. Run desktop setup with `-RelayUrl https://example.com/telegram-relay.php`, entering the same bot token and relay key. For an existing installation, edit its private `config.json` and save the relay key with `Read-Host -AsSecureString | ConvertFrom-SecureString | Set-Content -Encoding ASCII` to its private `book-relay-key.dpapi`.
7. On the server, register and inspect the webhook:

   ```sh
   php server/bin/codex-webhook-control.php enable
   php server/bin/codex-webhook-control.php status
   ```

8. Start the desktop bridge. It publishes the chat catalog and polls the relay about every five seconds when idle. `/start` and chat-menu navigation can respond directly from the server.

The control script also supports `disable` (removes the webhook without dropping queued Telegram updates) and `commands` (inspects the bot menu). Before switching an existing relay installation to direct polling, stop the bridge, drain/check its queues and disable the webhook. Never run two transports for the same bot simultaneously.

## Privacy, limits and verification

Only source code and placeholder configuration are included. Credentials, personal IDs, chat histories, databases and media are excluded. Keep them outside the checkout even when they are ignored by Git. See [SECURITY.md](SECURITY.md).

Runtime notifications may contain private information from your chats. The built-in redactor covers common bot tokens and bearer headers; it is not a general secret scrubber. Only authorize people and Telegram chats you trust. An allowed user can send instructions that execute with your Codex chat's permissions.

This code depends on internal Codex behavior. A stream-version mismatch stops prompt delivery until compatibility is checked. When a queued message targets an unloaded chat, the bridge first requests its state, then opens that existing chat through a Codex deep link if no owner is found. This can switch the desktop to that chat. Delivery waits for the state snapshot; the link contains no prompt, and no second app-server is started. Wakeups are throttled to once per minute per chat. Codex must be running and its Windows URL handler must be registered. Delivery marked `unknown` requires manual inspection; exactly-once delivery across network failures is not guaranteed.

Run the offline checks:

```powershell
npm test
Get-ChildItem desktop\*.mjs | ForEach-Object { node --check $_.FullName }
Get-ChildItem server -Recurse -Filter *.php | ForEach-Object { php -l $_.FullName }
```

Tests cover user allowlisting, a fresh voice queue, recovery after restart, per-chat ordering, unsafe media paths, HTTPS relay configuration and final-response patches. They do not replace an end-to-end test with your own bot, Codex build and hosting environment.

## License

[MIT](LICENSE). OpenAI, Codex and Telegram names belong to their respective owners.
