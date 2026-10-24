import type { MessageSummary } from './types'

/** Message-IDs kommen mal mit, mal ohne spitze Klammern. */
export function normalizeMessageId(id?: string): string | undefined {
  const clean = id?.trim().replace(/^<|>$/g, '')
  return clean || undefined
}

/** Alle Message-IDs, auf die eine Mail zeigt - sich selbst eingeschlossen. */
export function linkedIds(m: MessageSummary): string[] {
  const ids = [m.messageId, m.inReplyTo, ...(m.references ?? [])]
  return ids.map(normalizeMessageId).filter((id): id is string => Boolean(id))
}

/**
 * Ordnet jeder Mail ihre Unterhaltung zu. Zusammen gehoert, was sich ueber
 * Message-ID, In-Reply-To oder References beruehrt - nie ueber den Betreff:
 * zwei Rechnungen mit gleicher Betreffzeile sind keine Unterhaltung.
 *
 * Unterhaltungen bleiben innerhalb eines Kontos. Ergebnis: Kennung der Mail ->
 * Kennung der Unterhaltung.
 */
export function buildThreadIndex(messages: MessageSummary[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)!
    // Pfad verkuerzen, sonst werden lange Ketten bei jedem Aufruf neu abgelaufen.
    let walk = key
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!
      parent.set(walk, root)
      walk = next
    }
    return root
  }
  const add = (key: string): void => {
    if (!parent.has(key)) parent.set(key, key)
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  const nodeOf = new Map<string, string>()
  for (const m of messages) {
    const own = normalizeMessageId(m.messageId)
    // Ohne Message-ID steht die Mail fuer sich, haengt aber ueber ihre Verweise.
    const node = `${m.accountId}:${own ?? `#${m.id}`}`
    add(node)
    nodeOf.set(m.id, node)
    for (const id of linkedIds(m)) {
      const other = `${m.accountId}:${id}`
      add(other)
      union(node, other)
    }
  }

  const out = new Map<string, string>()
  for (const [id, node] of nodeOf) out.set(id, find(node))
  return out
}

/** Eine Zeile der Liste: die juengste Mail einer Unterhaltung und alles darunter. */
export interface ThreadRow {
  head: MessageSummary
  /** Alle Mails der Unterhaltung in dieser Liste, juengste zuerst; enthaelt head */
  members: MessageSummary[]
}

/**
 * Fasst eine nach Datum sortierte Liste zu Unterhaltungen zusammen. Die Zeile
 * steht dort, wo ihre juengste Mail stand. Ohne threadId bleibt jede Mail fuer
 * sich.
 */
export function collapseThreads(messages: MessageSummary[]): ThreadRow[] {
  const rows: ThreadRow[] = []
  const byThread = new Map<string, ThreadRow>()
  for (const m of messages) {
    const existing = m.threadId ? byThread.get(m.threadId) : undefined
    if (existing) {
      existing.members.push(m)
      continue
    }
    const row: ThreadRow = { head: m, members: [m] }
    rows.push(row)
    if (m.threadId) byThread.set(m.threadId, row)
  }
  return rows
}
