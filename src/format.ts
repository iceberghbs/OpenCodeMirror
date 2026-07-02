import type { Button, ChannelMessage } from "./transports/types.ts"

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

// Render markdown to Telegram-flavored HTML:
// - fenced ``` blocks -> <pre><code>
// - table blocks (lines with |) -> <pre> (monospace, aligned)
// - inline `code` -> <code>
// - everything else HTML-escaped
export function markdownToHtml(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++ // skip closing fence
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
      continue
    }
    if (line.includes("|") && line.trim()) {
      const table: string[] = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        table.push(lines[i])
        i++
      }
      out.push(`<pre>${escapeHtml(table.join("\n"))}</pre>`)
      continue
    }
    out.push(escapeInline(line))
    i++
  }
  return out.join("\n").trimEnd()
}

function escapeInline(line: string): string {
  return escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>")
}

export interface PermProp {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export function formatPermission(p: PermProp): ChannelMessage {
  const cmd = p.patterns?.join(" ") || (typeof p.metadata?.command === "string" ? String(p.metadata.command) : "")
  const text =
    `🔐 <b>Permission requested</b>\n` +
    `Tool: <code>${escapeHtml(p.permission)}</code>\n` +
    (cmd ? `Command: <code>${escapeHtml(truncate(cmd, 500))}</code>\n` : "") +
    `\nApprove from here?`
  const id = p.id
  const buttons: Button[][] = [[
    { id: `perm:${id}:once`, label: "✅ once" },
    { id: `perm:${id}:always`, label: "♾ always" },
    { id: `perm:${id}:reject`, label: "❌ reject" },
  ]]
  return { text, buttons }
}

export interface QProp {
  id: string
  sessionID: string
  questions: {
    question: string
    header: string
    options: { label: string; description: string }[]
    multiple?: boolean
    custom?: boolean
  }[]
}

export function formatQuestion(q: QProp): { msgs: ChannelMessage[]; singleChoice: boolean } {
  const single = q.questions.length === 1 && !q.questions[0].multiple
  if (single) {
    const qi0 = q.questions[0]
    const parts: string[] = [`❓ <b>Question</b>`]
    parts.push(`\n${escapeHtml(qi0.question)}`)
    qi0.options.forEach((opt, oi) => {
      parts.push(`\n  ${oi + 1}. ${escapeHtml(opt.label)}${opt.description ? " — " + escapeHtml(truncate(opt.description, 120)) : ""}`)
    })
    let buttons: Button[][] | undefined
    let forceReply = false
    const customOnly = qi0.options.length === 0 && qi0.custom
    if (customOnly) {
      forceReply = true
      parts.push("\n\n(Type your answer in the reply box below.)")
    } else {
      buttons = qi0.options.map((opt, oi) => [
        { id: `ans:${q.id}:0:${oi}`, label: truncate(opt.label, 30) },
      ])
      if (qi0.custom) {
        buttons.push([{ id: `ans:${q.id}:custom`, label: "✍️ type answer" }])
      }
      parts.push("\n\n(Tap an option, or reply to this message to type.)")
    }
    return { msgs: [{ text: parts.join(""), buttons, forceReply, placeholder: "Type your answer…" }], singleChoice: true }
  }
  // Multi-question: one message per question, each with its own inline buttons
  const msgs: ChannelMessage[] = q.questions.map((qi, qiIdx) => {
    const parts: string[] = []
    const header = qi.header || `Q${qiIdx + 1}`
    parts.push(`❓ <b>${q.questions.length > 1 ? `${header} (${qiIdx + 1}/${q.questions.length})` : header}</b>`)
    parts.push(`\n${escapeHtml(qi.question)}`)
    qi.options.forEach((opt, oi) => {
      parts.push(`\n  ${oi + 1}. ${escapeHtml(opt.label)}${opt.description ? " — " + escapeHtml(truncate(opt.description, 120)) : ""}`)
    })
    const buts: Button[][] = qi.options.map((opt, oi) => [
      { id: `ans:${q.id}:${qiIdx}:${oi}`, label: truncate(opt.label, 30) },
    ])
    if (qi.custom) {
      buts.push([{ id: `ans:${q.id}:custom`, label: "✍️ type answer" }])
    }
    parts.push("\n\n(Tap an option, or reply to this message to type.)")
    return { text: parts.join(""), buttons: buts.length ? buts : undefined }
  })
  return { msgs, singleChoice: false }
}

export function formatIdle(sessionTitle: string): ChannelMessage {
  return { text: `✅ <b>Session idle</b>\n${escapeHtml(truncate(sessionTitle || "(untitled)", 120))}` }
}

export function formatError(errText: string): ChannelMessage {
  return { text: `⚠️ <b>Session error</b>\n<code>${escapeHtml(truncate(errText, 1500))}</code>` }
}

export function formatAssistantText(text: string): ChannelMessage {
  const html = markdownToHtml(truncate(text, 4000))
  return { text: html || "(empty)" }
}

export function formatToolPart(part: any): ChannelMessage {
  const tool = String(part?.tool ?? "tool")
  const toolLabel = tool === "task" ? "subagent" : tool
  const state = (part?.state ?? {}) as any
  const status = state.status ?? "running"

  if (status === "pending") {
    return { text: `🔧 <code>${escapeHtml(toolLabel)}</code> — pending` }
  }

  if (status === "running") {
    const cmd = String(state.input?.command ?? state.input?.url ?? state.input?.filePath ?? state.input?.pattern ?? state.input?.description ?? "")
    const detail = cmd ? `: <code>${escapeHtml(cmd)}</code>` : ""
    return { text: `🔧 <code>${escapeHtml(toolLabel)}</code>${detail}` }
  }

  if (status === "completed") {
    const t = state.time ?? {}
    const elapsed = (t.end && t.start) ? t.end - t.start : 0
    const exit = state.metadata?.exit !== undefined ? ` exit=${state.metadata.exit}` : ""
    return { text: `✅ <code>${escapeHtml(toolLabel)}</code> — completed (${elapsed}ms)${exit}` }
  }

  if (status === "error") {
    const err = String(state.error ?? "").slice(0, 200)
    const detail = err ? `: ${escapeHtml(err)}` : ""
    return { text: `❌ <code>${escapeHtml(toolLabel)}</code> — error${detail}` }
  }

  return { text: `🔧 <code>${escapeHtml(toolLabel)}</code> — ${escapeHtml(status)}` }
}
