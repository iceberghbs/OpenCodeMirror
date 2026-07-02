export type Mode = "quiet" | "full"

export interface TelebotStatus {
  available: boolean
  transport: string
  mode: Mode
  talking: boolean    // this instance holds the bot lock
  lastEvent: { type: string; time: number } | null
  sent: number
  replied: number
  pendingPermission: number
  pendingQuestion: number
  lastError: string | null
}

const initial: TelebotStatus = {
  available: false,
  transport: "none",
  mode: "full",
  talking: false,
  lastEvent: null,
  sent: 0,
  replied: 0,
  pendingPermission: 0,
  pendingQuestion: 0,
  lastError: null,
}

let current: TelebotStatus = { ...initial }
const subs = new Set<() => void>()

export function getStatus(): TelebotStatus {
  return current
}

export function setStatus(patch: Partial<TelebotStatus>): void {
  current = { ...current, ...patch }
  for (const fn of subs) {
    try {
      fn()
    } catch {
      // listener errors are non-fatal
    }
  }
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
