import type { Transport } from "./transports/types.ts"
import { getStatus, setStatus, type Mode } from "./state.ts"
import { readStateFile, writeCurrent, resolveTitle, syncAllowListTitles, removeStaleLocalSessions } from "./state-file.ts"
import {
  formatAssistantText,
  formatError,
  formatIdle,
  formatPermission,
  formatQuestion,
  formatToolPart,
  type PermProp,
  type QProp,
} from "./format.ts"

export interface OcEvent {
  id: string
  type: string
  properties: any
}

interface QInfo {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

export interface RequestResult {
  data?: any
  error?: { message?: string } | string
  response?: any
  request?: any
}
export interface TelebotClient {
  session: {
    list(opts?: { limit?: number }): Promise<RequestResult>
    prompt(opts: { sessionID: string; parts: unknown[] }): Promise<RequestResult>
    abort(opts: { sessionID: string }): Promise<RequestResult>
    messages(opts: { sessionID: string; limit?: number }): Promise<RequestResult>
  }
  permission: { reply(opts: { requestID: string; reply: string; message?: string }): Promise<RequestResult> }
  question: { reply(opts: { requestID: string; answers: unknown[] }): Promise<RequestResult> }
}

export class Core {
  private client: TelebotClient
  private transport: Transport | null = null
  private chatId: string = ""
  private log: (msg: string) => void = () => {}
  private dbg: boolean = false
  private active: boolean = false
  private pendingQuestions = new Map<string, { sessionID: string; questions: QInfo[]; answers: (string[] | null)[] }>()
  private pendingPermissions = new Map<string, string>()
  private questionMsgs = new Map<string, { requestID: string; sessionID: string; questions: QInfo[] }>()
  private inStepSessions = new Set<string>()
  private toolStatesSent = new Set<string>()           // "callID:status" dedup
  private abortedSessions = new Map<string, number>()          // suppress noise after /stop/dismiss
  private finalTexts = new Map<string, string>()       // sid → last assistant text
  private sessionTitles = new Map<string, string>()
  private dumpCb: ((line: string) => void) | null = null

  constructor(opts: { client: TelebotClient; debug?: boolean; dumpCb?: (line: string) => void }) {
    this.client = opts.client
    this.dbg = !!opts.debug
    this.dumpCb = opts.dumpCb ?? null
  }

  async activateTransport(transport: Transport, chatId: string, logger: (msg: string) => void): Promise<void> {
    this.transport = transport
    this.chatId = chatId
    this.log = logger
    this.active = true
    await transport.start((m) => this.handleInbound(m))
    this.log(`oc-telebot active (transport=${transport.name}, chat=${chatId || "(none)"})`)
  }

  async deactivateTransport(): Promise<void> {
    this.active = false
    if (this.transport) { this.transport.stop(); this.transport = null }
    this.log("oc-telebot deactivated")
  }

  stop(): void {
    if (this.transport) this.transport.stop()
    this.active = false
  }

  private get mode(): Mode {
    return getStatus().mode
  }

  private activeSession(): string | null {
    return readStateFile().current
  }

  // ── SDK client helpers ────────────────────────────────────────────────────
  private async unwrap<T>(r: RequestResult): Promise<T> {
    if (r && (r as any).error) {
      const err = (r as any).error
      throw new Error(typeof err === "string" ? err : err?.message || JSON.stringify(err).slice(0, 200))
    }
    return (r as any).data as T
  }
  private async sessionList(): Promise<any[]> {
    const r = await this.client.session.list({ limit: 20 })
    return (await this.unwrap<any[]>(r)) ?? []
  }
  private async sessionMessages(sid: string, limit: number): Promise<any[]> {
    const r = await this.client.session.messages({ sessionID: sid, limit })
    return (await this.unwrap<any[]>(r)) ?? []
  }
  private async sessionMessagesRaw(sid: string, limit: number): Promise<any[]> {
    try {
      const r = await this.client.session.messages({ sessionID: sid, limit })
      const data = (r as any).data
      if (data && typeof data === "string") return JSON.parse(data)
      return data ?? []
    } catch {
      return []
    }
  }
  private async sessionMessage(sid: string, parts: unknown[], agent?: string): Promise<void> {
    const c = this.client as any
    const body: any = { parts }
    if (agent) body.agent = agent
    const r = await c._client.post({
      url: `/session/${sid}/message`,
      body,
      headers: { "content-type": "application/json" },
    })
    await this.unwrap(r)
  }
  private async sessionAbort(sid: string): Promise<void> {
    const c = this.client as any
    const r = await c._client.post({
      url: `/session/${sid}/abort`,
      body: {},
      headers: { "content-type": "application/json" },
    })
    await this.unwrap(r)
  }
  private async permissionReply(requestID: string, reply: string): Promise<void> {
    const r = await this.client.permission.reply({ requestID, reply })
    await this.unwrap(r)
  }
  private async questionReply(requestID: string, answers: unknown[]): Promise<void> {
    const r = await (this.client as any)._client.post({
      url: "/question/{requestID}/reply",
      path: { requestID },
      body: { answers },
      headers: { "Content-Type": "application/json" },
    })
    if (r.error) {
      const msg = typeof r.error === "string" ? r.error : r.error?.message ?? JSON.stringify(r.error)
      throw new Error(msg)
    }
  }

  // ── outbound: opencode events ──────────────────────────────────────────────
  private eventQueues = new Map<string, Promise<void>>()

  async handleEvent(ev: OcEvent): Promise<void> {
    const sid: string = ev.properties?.sessionID ? String(ev.properties.sessionID) : "_global"
    const prev = this.eventQueues.get(sid) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.processEvent(ev))
    this.eventQueues.set(sid, next)
    next.finally(() => {
      if (this.eventQueues.get(sid) === next) this.eventQueues.delete(sid)
    })
    return next
  }

  private async processEvent(ev: OcEvent): Promise<void> {
    try {
      setStatus({ lastEvent: { type: ev.type, time: Date.now() } })
      const p = ev.properties
      switch (ev.type) {
        case "session.created":
        case "session.updated": {
          const sid: string | undefined = p?.sessionID
          const title: string | undefined = p?.info?.title
          if (sid && title) this.sessionTitles.set(sid, title)
          break
        }
        case "session.idle": {
          const sid: string | undefined = p?.sessionID
          if (this.dumpCb && sid) {
            try {
              const msgs = await this.sessionMessagesRaw(sid, 30)
              this.dumpCb(JSON.stringify({ seq: 0, ts: Date.now(), type: "session.idle.RESOLVED", sessionID: sid, messages: msgs }))
            } catch { /* dump is best-effort */ }
          }
          const cur = this.activeSession()
          if (sid && sid !== cur) break
          if (sid && this.abortedSessions.has(sid)) {
            const n = (this.abortedSessions.get(sid) ?? 0) + 1
            if (n <= 2) { this.abortedSessions.set(sid, n); break }
            this.abortedSessions.delete(sid)
          }
          const finalText = sid ? this.finalTexts.get(sid) : undefined
          this.finalTexts.delete(sid ?? "")
          this.inStepSessions.delete(sid ?? "")
          this.toolStatesSent.clear()
          if (finalText) {
            await this.send(formatAssistantText(finalText))
          } else {
            const title = (sid && this.sessionTitles.get(sid)) || "(untitled)"
            await this.send(formatIdle(title))
          }
          break
        }
        case "session.error": {
          const sid: string | undefined = p?.sessionID
          if (p?.error?.name === "MessageAbortedError") break
          const cur = this.activeSession()
          const errText = typeof p?.error === "string" ? p.error : p?.error?.message || JSON.stringify(p?.error || "unknown")
          setStatus({ lastError: String(errText).slice(0, 200) })
          if (sid && sid !== cur) break
          await this.send(formatError(String(errText)))
          break
        }
        case "permission.asked": {
          const perm = p as PermProp
          const cur = this.activeSession()
          if (perm.sessionID && perm.sessionID !== cur) break
          this.pendingPermissions.set(perm.id, perm.sessionID)
          setStatus({ pendingPermission: getStatus().pendingPermission + 1 })
          await this.send(formatPermission(perm))
          break
        }
        case "question.asked": {
          const q = p as QProp
          const cur = this.activeSession()
          if (q.sessionID && q.sessionID !== cur) break
          this.pendingQuestions.set(q.id, { sessionID: q.sessionID, questions: q.questions as QInfo[], answers: (q.questions as QInfo[]).map(() => null) })
          setStatus({ pendingQuestion: getStatus().pendingQuestion + 1 })
          const { msgs } = formatQuestion(q)
          for (const msg of msgs) {
            const tgMsgId = await this.send(msg)
            if (tgMsgId) {
              this.questionMsgs.set(tgMsgId, { requestID: q.id, sessionID: q.sessionID, questions: q.questions as QInfo[] })
              if (this.questionMsgs.size > 100) {
                const firstKey = this.questionMsgs.keys().next().value
                if (firstKey) this.questionMsgs.delete(firstKey)
              }
            }
          }
          break
        }
        case "message.part.updated": {
          const sid: string = p?.sessionID
          const cur = this.activeSession()
          if (sid && sid !== cur) break
          const part = p?.part
          if (!sid || !part) break
          if (part.type === "step-start") { this.inStepSessions.add(sid); break }
          if (part.type === "step-finish") { this.inStepSessions.delete(sid); break }
          if (part.type === "tool") {
            if (this.mode === "full") {
              const status = String(part.state?.status ?? "")
              if (status === "pending" || status === "completed") break
              if (String(part.tool ?? "") === "question") break
              const callID = String(part.callID ?? "")
              const key = callID ? `${callID}:${status}` : ""
              if (key && !this.toolStatesSent.has(key)) {
                this.toolStatesSent.add(key)
                await this.send(formatToolPart(part))
              }
            }
            break
          }
          if (part.type === "text" && this.inStepSessions.has(sid)) {
            if (part.text?.trim()) {
              this.finalTexts.set(sid, String(part.text))
            }
          }
          break
        }
        case "message.part.delta": {
          break
        }
      default:
          break
      }
    } catch (e) {
      this.log(`handleEvent error (${ev.type}): ${String(e).slice(0, 200)}`)
    }
  }

  private async send(msg: import("./transports/types.ts").ChannelMessage): Promise<string | undefined> {
    const t = this.transport
    if (!t || !this.chatId) {
      if (this.dbg) this.log(`[no-transport] ${(msg.text ?? "").slice(0, 120)}`)
      return undefined
    }
    try {
      const { messageId } = await t.send(this.chatId, msg)
      setStatus({ sent: getStatus().sent + 1 })
      if (this.dbg) this.log(`SEND ${messageId}: ${(msg.text ?? "").slice(0, 70)}`)
      return messageId
    } catch (e) {
      this.log(`send failed: ${String(e).slice(0, 200)}`)
      setStatus({ lastError: String(e).slice(0, 200) })
      return undefined
    }
  }

  // ── inbound: from the phone ────────────────────────────────────────────────
  async handleInbound(m: import("./transports/types.ts").InboundMessage): Promise<void> {
    if (this.dbg) this.log(`handleInbound chat=${m.chatId} text=${(m.text ?? "").slice(0, 40)} btn=${m.buttonId ?? "-"}`)
    if (!this.transport) return
    if (this.chatId && m.chatId !== this.chatId) {
      if (m.callbackId) await this.transport.answerCallback(m.callbackId, "unauthorized")
      return
    }
    try {
      if (m.callbackId && m.buttonId) {
        await this.onButton(m.callbackId, m.buttonId)
        return
      }
      if (m.text && m.replyToMessageId && this.questionMsgs.has(m.replyToMessageId)) {
        await this.onReplyAnswer(m.replyToMessageId, m.text)
        return
      }
      if (m.text) {
        await this.onText(m.text)
      }
    } catch (e) {
      this.log(`handleInbound error: ${String(e).slice(0, 200)}`)
    }
  }

  private async sendHandoff(sid: string): Promise<void> {
    try {
      const data = await this.sessionMessages(sid, 10)
      const entries = (data ?? []) as { info?: { role?: string }; parts?: { type: string; text?: string }[] }[]
      const lines: string[] = []
      for (const e of entries.slice(-4)) {
        const role = e.info?.role
        if (role !== "user" && role !== "assistant") continue
        const text = (e.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim()
        if (text) lines.push(`<b>${role}:</b> ${escapeForTg(text.slice(0, 200))}`)
      }
      if (lines.length) await this.send({ text: lines.join("\n") })
    } catch {
      // handoff is best-effort
    }
  }

  // ── button handlers ─────────────────────────────────────────────────────
  private async onButton(callbackId: string, buttonId: string): Promise<void> {
    const t = this.transport
    if (!t) return
    try {
      if (buttonId.startsWith("switch:")) {
        const target = buttonId.slice("switch:".length)
        if (!target) { await t.answerCallback(callbackId, "invalid"); return }
        await this.doSwitch(target, async (msg) => {
          await t.answerCallback(callbackId, msg)
        })
      } else if (buttonId.startsWith("perm:")) {
        const [, reqId, reply] = buttonId.split(":")
        const sid = this.pendingPermissions.get(reqId)
        if (!sid) { await t.answerCallback(callbackId, "stale"); return }
        await this.permissionReply(reqId, reply)
        this.pendingPermissions.delete(reqId)
        setStatus({
          pendingPermission: Math.max(0, getStatus().pendingPermission - 1),
          replied: getStatus().replied + 1,
        })
        await t.answerCallback(callbackId, `✅ ${reply}`)
        await this.send({ text: `↩️ permission ${reply}` })
      } else if (buttonId.startsWith("ans:")) {
        const parts = buttonId.split(":")
        const reqId = parts[1]
        const entry = this.pendingQuestions.get(reqId)
        if (!entry) { await t.answerCallback(callbackId, "stale"); return }
        if (parts[2] === "custom") {
          await t.answerCallback(callbackId, "reply to the question msg to type")
          return
        }
        const qIdx = Number(parts[2])
        const optIdx = Number(parts[3])
        const label = entry.questions[qIdx]?.options?.[optIdx]?.label
        if (!label) { await t.answerCallback(callbackId, "invalid"); return }
        const wasAnswered = entry.answers[qIdx] !== null
        entry.answers[qIdx] = [label]
        const remaining = entry.answers.filter((a) => a === null).length
        if (remaining === 0) {
          await this.questionReply(reqId, entry.answers as unknown[])
          this.pendingQuestions.delete(reqId)
          setStatus({
            pendingQuestion: Math.max(0, getStatus().pendingQuestion - 1),
            replied: getStatus().replied + 1,
          })
          await t.answerCallback(callbackId, `✅ ${label}`)
          await this.send({ text: `↩️ all answered: ${entry.answers.map((a) => a?.[0] ?? "—").join(", ")}` })
        } else {
          await t.answerCallback(callbackId, `${wasAnswered ? "🔁" : "✅"} ${label}`)
          await this.send({ text: `↩️ Q${qIdx + 1}/${entry.questions.length}: ${label}. ${remaining} remaining.` })
        }
      }
    } catch (e) {
      await t.answerCallback(callbackId, "error")
      this.log(`onButton error: ${String(e).slice(0, 200)}`)
    }
  }

  private async doSwitch(target: string, ack?: (txt: string) => Promise<void>): Promise<void> {
    const state = readStateFile()
    if (!state.allowList.some((e) => e.id === target)) {
      await this.send({ text: `ℹ️ session not activated — use /telegram in opencode first` })
      await ack?.("not activated")
      return
    }
    writeCurrent(target)
    const title = this.sessionTitles.get(target) || resolveTitle(target) || target
    await this.send({ text: `✅ talking → ${escapeForTg(title)}` })
    await ack?.("✅ talking")
    await this.sendHandoff(target)
  }

  private async onReplyAnswer(replyToMessageId: string, text: string): Promise<void> {
    const msgEntry = this.questionMsgs.get(replyToMessageId)
    if (!msgEntry) { await this.send({ text: "ℹ️ that question is no longer pending." }); return }
    const { requestID, questions } = msgEntry
    if (questions.length !== 1) {
      await this.send({ text: "ℹ️ multi-question prompts: tap a button for each question." })
      return
    }
    try {
      const qEntry = this.pendingQuestions.get(requestID)
      if (!qEntry) { await this.send({ text: "ℹ️ that question is no longer pending." }); return }
      qEntry.answers[0] = [text.trim()]
      if (qEntry.answers.filter((a) => a === null).length > 0) {
        await this.send({ text: `↩️ Q1: ${escapeForTg(text.trim().slice(0, 80))}. Still waiting for remaining.` })
        return
      }
      await this.questionReply(requestID, qEntry.answers as unknown[])
      this.questionMsgs.delete(replyToMessageId)
      this.pendingQuestions.delete(requestID)
      setStatus({
        pendingQuestion: Math.max(0, getStatus().pendingQuestion - 1),
        replied: getStatus().replied + 1,
      })
      await this.send({ text: `↩️ answered: ${escapeForTg(text.trim().slice(0, 80))}` })
    } catch (e) {
      await this.send({ text: `⚠️ answer failed: <code>${escapeForTg(String(e))}</code>` })
    }
  }

  private async onText(text: string): Promise<void> {
    const t = text.trim()
    if (this.dbg) this.log(`onText sid=${this.activeSession() ?? "(null)"} text=${t.slice(0, 40)}`)
    if (t.startsWith("/")) {
      await this.onCommand(t)
      return
    }
    if (this.pendingQuestions.size > 0) {
      const count = this.pendingQuestions.size
      this.pendingQuestions.clear()
      setStatus({ pendingQuestion: 0 })
      const sid = this.activeSession()
      if (sid) { this.finalTexts.delete(sid); this.abortedSessions.set(sid, 0); try { await this.sessionAbort(sid) } catch {} }
      await this.send({ text: `⏹ dismissed ${count} pending question(s)` })
    }
    const sid = this.activeSession()
    if (!sid) {
      await this.send({ text: "ℹ️ No active session. /sessions [index] to switch." })
      return
    }
    if (!readStateFile().allowList.some((e) => e.id === sid)) {
      await this.send({ text: "ℹ️ session not activated — use /telegram in opencode first" })
      return
    }
    try {
      await this.sessionMessage(sid, [{ type: "text", text: t }])
      setStatus({ replied: getStatus().replied + 1 })
      if (this.dbg) this.log(`prompt sent to ${sid}`)
    } catch (e) {
      await this.send({ text: `⚠️ prompt failed: <code>${escapeForTg(String(e))}</code>` })
    }
  }

  private async onCommand(t: string): Promise<void> {
    const [cmd, ...rest] = t.slice(1).split(/\s+/)
    const arg = rest.join(" ")
    switch (cmd) {
      case "help":
        await this.send({
          text:
            "📖 <b>oc-telebot</b>\n" +
            "\n" +
            "/mode quiet|full — see less or more output\n" +
            "/plan &lt;text&gt; — ask in plan mode (no file edits)\n" +
            "/sessions [index] — list or switch sessions\n" +
            "/resume — continue most recent session\n" +
            "/stop — abort current session\n" +
            "/help — this message\n" +
            "\n" +
            "To activate: /telegram in opencode TUI",
        })
        break
      case "mode": {
        const m = (arg || "") as Mode
        if (m !== "quiet" && m !== "full") {
          await this.send({ text: `current mode: <b>${this.mode}</b>` })
          return
        }
        setStatus({ mode: m })
        await this.send({ text: `✅ mode → <b>${m}</b>` })
        break
      }
      case "plan": {
        if (!arg) { await this.send({ text: "ℹ️ /plan &lt;text&gt; — send message in plan mode" }); return }
        const sid = this.activeSession()
        if (!sid) { await this.send({ text: "ℹ️ no active session — /sessions to pick one" }); return }
        await this.sessionMessage(sid, [{ type: "text", text: arg }], "plan")
        setStatus({ replied: getStatus().replied + 1 })
        break
      }
      case "sessions": {
        try {
          if (arg) {
            const state = readStateFile()
            const entries = state.allowList
            let target: string | undefined
            if (/^\d+$/.test(arg)) {
              target = entries[Number(arg)]?.id
            } else {
              target = entries.find((e) => e.id === arg)?.id ?? arg
            }
            if (!target) { await this.send({ text: "ℹ️ not found; run /sessions to list" }); return }
            await this.doSwitch(target)
            return
          }
          // Clean up stale local sessions (Ctrl+D deleted)
          const localList = (await this.sessionList()) ?? []
          const localIds = new Set<string>(localList.map((s: any) => String(s.id ?? "")))
          removeStaleLocalSessions(localIds)
          syncAllowListTitles(this.sessionTitles)

          const state = readStateFile()
          const entries = state.allowList
          const cur = state.current
          if (!entries.length) {
            await this.send({ text: "ℹ️ no activated sessions — use /telegram in opencode TUI" })
            return
          }
          const body = entries.map((e, i) => {
            const prefix = e.id === cur ? "● " : ""
            return `<b>${prefix}${i}. ${escapeForTg(e.title)}</b>`
          }).join("\n\n")
          const buttons = entries.map((e, i) => [{
            id: `switch:${e.id}`,
            label: `${e.id === cur ? "● " : ""}${i}. ${e.title}`,
          }])
          await this.send({
            text: `📋 <b>Sessions</b>\n\n${body}`,
            buttons,
          })
        } catch (e) {
          await this.send({ text: `⚠️ list failed: <code>${escapeForTg(String(e))}</code>` })
        }
        break
      }
      case "resume": {
        try {
          const entries = readStateFile().allowList
          if (!entries.length) { await this.send({ text: "ℹ️ no activated sessions" }); return }
          const target = entries[0].id
          if (target === this.activeSession()) {
            const title = this.sessionTitles.get(target) || "(untitled)"
            await this.send({ text: `ℹ️ session already active: ${escapeForTg(title)}` })
            return
          }
          await this.doSwitch(target)
        } catch (e) {
          await this.send({ text: `⚠️ resume failed: <code>${escapeForTg(String(e))}</code>` })
        }
        break
      }
      case "stop": {
        const sid = this.activeSession()
        if (!sid) { await this.send({ text: "ℹ️ no active session" }); return }
        if (!readStateFile().allowList.some((e) => e.id === sid)) {
          await this.send({ text: "ℹ️ session not activated — use /telegram in opencode first" })
          return
        }
        this.abortedSessions.set(sid, 0)
        try {
          await this.sessionAbort(sid)
          await this.send({ text: `⏹ aborted <code>${escapeForTg(sid)}</code>` })
          this.abortedSessions.delete(sid)
        } catch (e) {
          this.abortedSessions.delete(sid)
          await this.send({ text: `⚠️ abort failed: <code>${escapeForTg(String(e))}</code>` })
        }
        break
      }
      default:
        await this.send({ text: `unknown command: /${escapeForTg(cmd)}` })
    }
  }
}

function escapeForTg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
