import type { Plugin } from "@opencode-ai/plugin"
import { Core, type OcEvent } from "./core.ts"
import { createTelegramTransport } from "./transports/telegram.ts"
import { createEchoTransport } from "./transports/echo.ts"
import { setStatus, type Mode } from "./state.ts"
import { readStateFile, writeCurrent, removeAllForPid } from "./state-file.ts"
import { readFileSync, appendFileSync } from "node:fs"

const SELF_CHECK_MS = 2000

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function loadConfig(): void {
  try {
    const path = `${process.env.HOME || ""}/.config/opencode/oc-telebot.env`
    const content = readFileSync(path, "utf8")
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (!process.env[k]) {
        process.env[k] = v.trim().replace(/^["']|["']$/g, "")
      }
    }
  } catch {
    // file missing — env vars only
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────
let core: Core | null = null
let transportActive = false
let pluginOutput: any = null

const ocTelebot: Plugin = async ({ client }) => {
  loadConfig()
  const token = process.env.OC_TELEBOT_TOKEN
  const chatId = process.env.OC_TELEBOT_CHAT_ID
  const dryrun = !!process.env.OC_TELEBOT_DRYRUN

  const stderr = dryrun || !!process.env.OC_TELEBOT_DEBUG
    ? (msg: string) => console.error(`[oc-telebot] ${msg}`)
    : () => {}

  stderr(`plugin init (dryrun=${dryrun}, hasToken=${!!token}, hasChat=${!!chatId})`)

  if (!token && !dryrun) return pluginOutput ?? {}

  if (pluginOutput) {
    stderr(`plugin re-init — returning cached output`)
    return pluginOutput
  }

  if (!core) {
    const logger = (msg: string) => {
      stderr(msg)
      void client.app.log({
        body: { service: "oc-telebot", level: "info", message: msg },
      })
    }

    const dumpStream = !!process.env.OC_TELEBOT_DUMP_STREAM
    const dumpPath = process.env.OC_TELEBOT_DUMP_PATH || "/tmp/oc-telebot-stream-dump.jsonl"
    let dumpSeq = 0
    const dumpWrite = (line: string) => {
      try { appendFileSync(dumpPath, line + "\n") } catch {}
    }

    core = new Core({
      client: client as unknown as import("./core.ts").TelebotClient,
      debug: dryrun || !!process.env.OC_TELEBOT_DEBUG,
      dumpCb: dumpStream ? dumpWrite : undefined,
    })

    const initialMode = process.env.OC_TELEBOT_MODE as Mode | undefined
    if (initialMode === "quiet" || initialMode === "full") {
      setStatus({ mode: initialMode })
      logger(`initial mode = ${initialMode}`)
    }

    // ── 2s self-check: activate/deactivate transport based on current session ──
    const selfCheck = setInterval(() => {
      try {
        const state = readStateFile()
        const entry = state.allowList.find((e) => e.id === state.current)
        const targetPid = entry?.pid ?? null

        if (targetPid === process.pid && !transportActive) {
          // Acquire bot
          logger(`self-check: activating (current=${state.current})`)
          if (token && !dryrun) {
            const t = createTelegramTransport({ token: token!, api: process.env.OC_TELEBOT_API })
            core!.activateTransport(t, chatId ?? "", logger)
          } else if (dryrun) {
            core!.activateTransport(createEchoTransport(logger), chatId ?? "", logger)
          }
          setStatus({ talking: true, available: true, transport: dryrun ? "echo" : "telegram" })
          transportActive = true
        }

        if (targetPid !== process.pid || targetPid === null) {
          if (transportActive) {
            // Release bot
            logger(`self-check: deactivating (targetPid=${targetPid}, current=${state.current})`)
            core!.deactivateTransport()
            setStatus({ talking: false, available: false })
            transportActive = false
          }
        }
      } catch (e) {
        logger(`self-check error: ${String(e).slice(0, 200)}`)
      }
    }, SELF_CHECK_MS)

    // ── Lifecycle ────────────────────────────────────────────────────────────
    const dispose = async () => {
      clearInterval(selfCheck)
      if (transportActive) {
        if (core) core.deactivateTransport()
        transportActive = false
      }
      if (core) core.stop()
      removeAllForPid(process.pid)
    }

    // ── Event handler ────────────────────────────────────────────────────────
    const processedEventIds = new Set<string>()
    const PROCESSED_CAP = 2000
    const evHandler = async ({ event }: any) => {
      const ev = event as unknown as OcEvent
      if (ev?.id && processedEventIds.has(ev.id)) return
      if (ev?.id) {
        if (processedEventIds.size > PROCESSED_CAP) processedEventIds.clear()
        processedEventIds.add(ev.id)
      }
      if (dumpStream) {
        dumpWrite(JSON.stringify({ seq: ++dumpSeq, ts: Date.now(), type: ev.type, id: ev.id, properties: ev.properties }))
      }
      void core?.handleEvent(ev)
    }

    pluginOutput = {
      event: evHandler as any,
      dispose,
      ready: () => transportActive,
    }
    return pluginOutput
  }

  return pluginOutput ?? {}
}

export default ocTelebot
