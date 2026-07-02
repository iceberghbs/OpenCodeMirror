/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, createEffect, type JSX } from "solid-js"
import { readFileSync } from "node:fs"

const STATE_PATH = "/tmp/oc-telebot.state.json"

// Read the same config file as the server plugin (separate module realms).
try {
  const content = readFileSync(`${process.env.HOME || ""}/.config/opencode/oc-telebot.env`, "utf8")
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
  }
} catch {
  // file missing — env vars only
}

interface AllowListEntry { id: string; title: string; pid: number; cwd: string }
interface StateData { current: string | null; allowList: AllowListEntry[] }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readStateData(): StateData {
  try {
    const raw = readFileSync(STATE_PATH, "utf8")
    const s = JSON.parse(raw)
    return { current: s.current ?? null, allowList: Array.isArray(s.allowList) ? s.allowList : [] }
  } catch {
    return { current: null, allowList: [] }
  }
}

function writeStateData(s: StateData): void {
  try {
    const { writeFileSync, renameSync } = require("node:fs")
    writeFileSync(STATE_PATH + ".tmp", JSON.stringify(s), "utf8")
    renameSync(STATE_PATH + ".tmp", STATE_PATH)
  } catch {
    // best-effort
  }
}

function StatusPanel(props: { api: any; sessionId: string }): JSX.Element {
  const api = props.api
  const [stateLabel, setStateLabel] = createSignal<string>("—")
  const [stateFg, setStateFg] = createSignal<string>("gray")

  const refresh = () => {
    const sid = props.sessionId
    if (!sid) { setStateLabel("—"); setStateFg("gray"); return }
    const t = api.theme.current
    const state = readStateData()
    const inList = state.allowList.some((e) => e.id === sid && pidAlive(e.pid))
    if (!inList) {
      setStateLabel("offline")
      setStateFg(t.textMuted ?? "gray")
    } else if (state.current === sid) {
      setStateLabel("active")
      setStateFg("green")
    } else {
      setStateLabel("online")
      setStateFg("blue")
    }
  }

  const types = ["session.idle", "session.error", "permission.asked", "question.asked"]
  const unsubs = types.map((t) => (api.event.on as any)(t, refresh))
  onCleanup(() => unsubs.forEach((u: any) => u && u()))

  const refreshInterval = setInterval(refresh, 2000)
  onCleanup(() => clearInterval(refreshInterval))

  createEffect(refresh)

  const t = api.theme.current

  return (
    <box flexDirection="row" gap={1}>
      <text fg={t.text}><b>Telebot</b></text>
      <text fg={stateFg()}>{stateLabel()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  if (api.command) {
    api.command.register(() => [{
      title: "Telebot: Toggle streaming for this session",
      value: "oc-telebot.toggle",
      category: "Telebot",
      slash: { name: "telegram", aliases: ["stream"] },
      onSelect: () => {
        const route = api.route.current
        if (route.name !== "session" || !route.params) {
          api.ui.toast({ title: "Telebot", message: "No session open" })
          return
        }
        const sid = route.params.sessionID as string
        if (!sid) { api.ui.toast({ title: "Telebot", message: "No session ID" }); return }
        const state = readStateData()
        const inList = state.allowList.some((e) => e.id === sid)
        if (inList) {
          // Remove all entries for this session (don't touch current)
          state.allowList = state.allowList.filter((e) => e.id !== sid)
          writeStateData(state)
          api.ui.toast({ title: "Telebot", message: "○ offline" })
        } else {
          // Add structured entry
          const title = ((api.state.session.get?.(sid) as any)?.info?.title)
            || (api.state.session.get?.(sid) as any)?.title
            || "(untitled)"
          state.allowList.push({ id: sid, title: String(title), pid: process.pid, cwd: process.cwd() })
          writeStateData(state)
          api.ui.toast({ title: "Telebot", message: "● online" })
        }
      },
    }])
  }

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: () => {
        const sessionId = (api.route.current as any)?.params?.sessionID ?? ""
        return <StatusPanel api={api} sessionId={sessionId} />
      },
    },
  })
}

const plugin: TuiPluginModule = { id: "local:oc-telebot-sidebar", tui }
export default plugin
