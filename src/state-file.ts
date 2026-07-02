import { readFileSync, writeFileSync, renameSync } from "node:fs"

const STATE_PATH = "/tmp/oc-telebot.state.json"
const STATE_TMP = STATE_PATH + ".tmp"

export interface AllowListEntry {
  id: string
  title: string
  pid: number
  cwd: string
}

export interface StateFile {
  current: string | null
  allowList: AllowListEntry[]
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readRaw(): StateFile {
  try {
    const raw = readFileSync(STATE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return {
      current: parsed.current ?? null,
      allowList: Array.isArray(parsed.allowList) ? parsed.allowList : [],
    }
  } catch {
    return { current: null, allowList: [] }
  }
}

function write(s: StateFile): void {
  try {
    writeFileSync(STATE_TMP, JSON.stringify(s), "utf8")
    renameSync(STATE_TMP, STATE_PATH)
  } catch {
    // best-effort
  }
}

export function readStateFile(): StateFile {
  const state = readRaw()
  // Cleanup dead instances (except our own PID)
  const filtered = state.allowList.filter(
    (e) => e.pid === process.pid || pidAlive(e.pid),
  )
  let changed = filtered.length !== state.allowList.length
  if (changed) state.allowList = filtered
  // Auto-heal current: pick first alive entry if current is null or stale
  if (!state.current || !state.allowList.some((e) => e.id === state.current)) {
    const first = state.allowList[0]
    state.current = first ? first.id : null
    changed = true
  }
  if (changed) write(state)
  return state
}

export function writeCurrent(sid: string | null): void {
  const state = readRaw()
  state.current = sid
  write(state)
}

export function addToAllowList(sid: string, title: string, pid: number, cwd: string): void {
  const state = readRaw()
  state.allowList.push({ id: sid, title, pid, cwd })
  write(state)
}

export function syncAllowListTitles(titles: Map<string, string>): void {
  const state = readRaw()
  let changed = false
  for (const e of state.allowList) {
    const updated = titles.get(e.id)
    if (updated && e.title !== updated) { e.title = updated; changed = true }
  }
  if (changed) write(state)
}

export function removeAllForSession(sid: string): void {
  const state = readRaw()
  state.allowList = state.allowList.filter((e) => e.id !== sid)
  write(state)
}

export function removeAllForPid(pid: number): void {
  const state = readRaw()
  state.allowList = state.allowList.filter((e) => e.pid !== pid)
  write(state)
}

export function resolveSession(sid: string): { pid: number; cwd: string } | null {
  const state = readStateFile()
  for (const e of state.allowList) {
    if (e.id === sid && (e.pid === process.pid || pidAlive(e.pid))) {
      return { pid: e.pid, cwd: e.cwd }
    }
  }
  return null
}

export function resolveTitle(sid: string): string | null {
  const state = readStateFile()
  for (const e of state.allowList) {
    if (e.id === sid && (e.pid === process.pid || pidAlive(e.pid))) {
      return e.title
    }
  }
  return null
}

export function removeStaleLocalSessions(existingIds: Set<string>): void {
  const state = readRaw()
  let changed = false
  state.allowList = state.allowList.filter((e) => {
    if (e.pid === process.pid && !existingIds.has(e.id)) { changed = true; return false }
    return true
  })
  if (!state.current || !state.allowList.some((e) => e.id === state.current)) {
    state.current = state.allowList[0]?.id ?? null
    changed = true
  }
  if (changed) {
    try {
      writeFileSync(STATE_TMP, JSON.stringify(state), "utf8")
      renameSync(STATE_TMP, STATE_PATH)
    } catch {
      // best-effort
    }
  }
}
