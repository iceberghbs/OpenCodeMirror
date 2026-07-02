# OpenCodeMirror

Bridge opencode sessions to chat platforms.

Supported platforms:
- Telegram
- WhatsApp (todo)
- Discord (todo)
- ...

Control your opencode agent from your phone: receive session output, approve
permissions, answer questions, and send prompts, all from your chat app.

## Background

[opencode](https://opencode.ai) has 181k GitHub stars and 7.5M monthly developers,
but no native Android or iOS app exists. The official web UI binds to localhost by
default (requires LAN access). Using opencode from a phone typically requires either
VPN (Tailscale), a self-hosted web server, or a desktop wrapper.

Existing community solutions run as standalone external servers:
- [Portal](https://github.com/hosenur/portal) and [CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad)
  provide mobile web UIs, but require a VPS + VPN setup
- [Kimaki](https://github.com/remorses/kimaki) bridges opencode to Discord,
  but runs as a parallel process outside opencode, not as a native plugin
- Multiple open GitHub issues request mobile control and network access

OpenCodeMirror is a **super lightweight native opencode plugin** — it runs inside the
opencode process itself. No separate server, no extra process, no npm dependencies
at runtime. It works over the internet with no VPN, no dedicated infrastructure —
just the opencode TUI and your existing chat account.

## Features

- **Outbound mirroring**: session idle/error events, tool status (full mode),
  final assistant text, sent to your Telegram chat
- **Inbound control**: free text, /plan, /sessions, /resume, /stop
  commands, inline permission buttons, reply-to question answers
- **Two modes**: `quiet` (final text only) or `full` (tool status + final text)
- **Per-message agent mode**: `/plan` blocks file edits (default is build mode)
- **Cross-instance**: multiple opencode processes share one bot via state file
- **TUI sidebar**: flat text widget showing `Telebot offline|online|active`
  with color coding (gray/blue/green), `/telegram` command to toggle

## Project structure

```
src/
  server.ts          Plugin entry (config loading, 2s self-check, event dispatch)
  core.ts            Core class (outbound mirroring, inbound routing, commands)
  format.ts          Message formatters (markdown to HTML, tool/question/permission)
  state-file.ts      State file CRUD (allowList, current session, title sync)
  state.ts           Reactive status singleton (mode, counters, talking)
  tui.tsx            TUI sidebar widget (flat text, three-state, /telegram toggle)
  transports/
    types.ts         Transport interface (send/start/stop/answerCallback)
    telegram.ts      Telegram Bot API transport (getUpdates long-poll)
    echo.ts          Dry-run transport for tokenless testing
scripts/
  install.sh        Cross-PC installer (shim, tui.json, env setup)
  uninstall.sh      Cleanup (shim, tui.json entry, credentials, state file)
```

## Quick start

### 1. Set up your platform

#### For Telegram:
1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, copy the bot token
2. Send any message to your new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` — copy the `chat.id` from the response

### 2. Install the plugin

```bash
git clone git@github.com:iceberghbs/OpenCodeMirror.git ~/OpenCodeMirror && cd ~/OpenCodeMirror && ./scripts/install.sh
```

The installer will:
- Write the server plugin shim to `~/.config/opencode/plugins/oc-telebot.ts`
- Add the TUI plugin to `~/.config/opencode/tui.json`
- Prompt for your bot token + chat ID (from step 1), write to `~/.config/opencode/oc-telebot.env`

### 3. Start using it

```bash
opencode
```

#### For Telegram:
Run `/telegram` to activate the current session for bot mirroring.
The sidebar shows three states:
- `Telebot offline` (gray) — session not activated
- `Telebot online` (blue) — session activated, but not the talking target
- `Telebot active` (green) — session is the current talking target

From your phone, send messages to the bot:
- **Free text** sent to the active session
- **`/plan <text>`** ask in plan mode (no file edits)
- **`/sessions`** list activated sessions (tap buttons to switch)
- **`/resume`** switch to the most recent session
- **`/mode quiet|full`** see less or more output
- **`/stop`** abort current session
- **`/help`** show all commands

## Requirements

- [opencode](https://opencode.ai) 1.17.11+

#### For Telegram:
- A Telegram bot token (from @BotFather)
- Your Telegram chat ID (from @userinfobot)

## Uninstall

```bash
./scripts/uninstall.sh
```

Removes the plugin shim, TUI config entry, credentials file, and runtime state.

## License

MIT
