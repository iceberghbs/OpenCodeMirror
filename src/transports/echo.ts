import type { Transport } from "./types.ts"

export function createEchoTransport(log: (msg: string) => void): Transport {
  return {
    name: "echo",
    start() {
      log("[echo] transport started (dry-run; no inbound)")
    },
    async send(_chatId, msg) {
      log(`[echo] SEND ${JSON.stringify(msg)}`)
      return { messageId: `echo-${Date.now()}` }
    },
    async edit(_chatId, messageId, msg) {
      log(`[echo] EDIT ${messageId}: ${msg.text.slice(0, 80)}`)
    },
    async answerCallback(callbackId, text) {
      log(`[echo] ANSWER_CB ${callbackId}: ${text ?? ""}`)
    },
    stop() {
      log("[echo] transport stopped")
    },
  }
}
