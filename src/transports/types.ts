export interface Button {
  id: string
  label: string
}

export interface ChannelMessage {
  text: string
  buttons?: Button[][]
  disablePreview?: boolean
  // When true, the transport sends a Telegram ForceReply (guided reply box) instead of
  // inline buttons. Used for custom-answer questions (REQ-026). Mutually exclusive with `buttons`.
  forceReply?: boolean
  placeholder?: string
}

export interface InboundMessage {
  chatId: string
  text?: string
  callbackId?: string
  buttonId?: string
  from?: string
  // telegram message_id the user replied to (for reply-to answers, REQ-027)
  replyToMessageId?: string
}

export interface Transport {
  name: string
  start(onInbound: (m: InboundMessage) => void): Promise<void> | void
  send(chatId: string, msg: ChannelMessage): Promise<{ messageId: string }>
  edit(chatId: string, messageId: string, msg: ChannelMessage): Promise<void>
  answerCallback(callbackId: string, text?: string): Promise<void>
  stop(): void
}
