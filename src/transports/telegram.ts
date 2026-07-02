import type { Button, ChannelMessage, InboundMessage, Transport } from "./types.ts"

interface TgConfig {
  token: string
  api?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createTelegramTransport(cfg: TgConfig): Transport {
  const base = (cfg.api ?? "https://api.telegram.org").replace(/\/$/, "")
  const url = (method: string) => `${base}/bot${cfg.token}/${method}`
  let polling = false
  let offset = 0

  async function tg<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data: any = await res.json().catch(() => ({}))
      if (res.ok && data.ok) return data.result as T
      if (res.status === 429 && data.parameters?.retry_after) {
        await sleep((data.parameters.retry_after as number) * 1000)
        continue
      }
      throw new Error(`tg ${method} failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`)
    }
    throw new Error(`tg ${method} rate-limit exhausted`)
  }

  function toKeyboard(buttons?: Button[][]) {
    if (!buttons?.length) return undefined
    return {
      inline_keyboard: buttons.map((row) =>
        row.map((b) => ({ text: b.label, callback_data: b.id })),
      ),
    }
  }

  function replyMarkup(msg: ChannelMessage) {
    if (msg.forceReply) {
      return { force_reply: true, input_field_placeholder: msg.placeholder ?? "" }
    }
    return toKeyboard(msg.buttons)
  }

  async function send(chatId: string, msg: ChannelMessage): Promise<{ messageId: string }> {
    const text = msg.text ?? ""
    if (text.length > 4096) {
      const form = new FormData()
      form.append("chat_id", chatId)
      form.append("document", new Blob([text], { type: "text/markdown" }), "message.md")
      const res = await fetch(url("sendDocument"), { method: "POST", body: form })
      const data: any = await res.json().catch(() => ({}))
      if (!data.ok) throw new Error(`sendDocument failed: ${JSON.stringify(data).slice(0, 300)}`)
      return { messageId: String(data.result?.message_id ?? "") }
    }
    const result = await tg<any>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: msg.disablePreview ?? true,
      reply_markup: replyMarkup(msg),
    })
    return { messageId: String(result?.message_id ?? "") }
  }

  async function edit(chatId: string, messageId: string, msg: ChannelMessage): Promise<void> {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: msg.text ?? "",
        parse_mode: "HTML",
        disable_web_page_preview: msg.disablePreview ?? true,
        reply_markup: toKeyboard(msg.buttons),
      })
    } catch (e) {
      const msg = String(e)
      // "message is not modified" is expected during fast streaming; don't log it
      if (process.env.OC_TELEBOT_DEBUG && !msg.includes("not modified")) {
        console.error(`[tg edit err] ${msg.slice(0, 300)}`)
      }
      // edit failures (content unchanged / message gone) are non-fatal
    }
  }

  async function answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await tg("answerCallbackQuery", { callback_query_id: callbackId, text: text ?? "" })
    } catch {
      // non-fatal
    }
  }

  async function poll(onInbound: (m: InboundMessage) => void): Promise<void> {
    while (polling) {
      try {
        const updates = await tg<any[]>("getUpdates", { offset, timeout: 30 })
        for (const u of updates ?? []) {
          if (u.update_id) offset = u.update_id + 1
          const m = u.message
          const cb = u.callback_query
          if (process.env.OC_TELEBOT_DEBUG) {
            console.error(`[oc-telebot] poll got update_id=${u.update_id} text=${m?.text?.slice(0, 40) ?? ""} cb=${cb?.data ?? ""}`)
          }
          if (m && m.text) {
            onInbound({
              chatId: String(m.chat.id),
              text: m.text,
              from: m.from?.first_name,
              replyToMessageId: m.reply_to_message?.message_id != null ? String(m.reply_to_message.message_id) : undefined,
            })
          }
          if (cb) {
            onInbound({
              chatId: String(cb.message?.chat.id ?? ""),
              callbackId: cb.id,
              buttonId: cb.data,
              from: cb.from?.first_name,
            })
          }
        }
      } catch (e) {
        if (process.env.OC_TELEBOT_DEBUG) console.error(`[oc-telebot] poll error: ${String(e).slice(0, 200)}`)
        await sleep(2000)
      }
    }
  }

  return {
    name: "telegram",
    async start(onInbound) {
      polling = true
      // drain pending updates so stale messages aren't acted on (REQ-019)
      try {
        const last = await tg<any[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 })
        if (last?.[0]?.update_id) offset = last[0].update_id + 1
      } catch {
        // ignore drain failure
      }
      void poll(onInbound)
    },
    send,
    edit,
    answerCallback,
    stop() {
      polling = false
    },
  }
}
