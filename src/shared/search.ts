import type { MessageSummary } from './types'

/**
 * Eine Sucheingabe, in ihre Bestandteile zerlegt. Liegt in shared, weil der
 * Main-Prozess damit filtert und die Oberflaeche dieselben Kuerzel erklaert.
 */
export interface ParsedSearch {
  /** Freie Woerter; jedes muss irgendwo vorkommen */
  terms: string[]
  from: string[]
  to: string[]
  subject: string[]
  /** Teil eines Anhangnamens */
  file: string[]
  hasAttachment?: boolean
  unread?: boolean
  flagged?: boolean
  /** Nur Mails vor diesem Zeitpunkt (ms, Tagesbeginn) */
  before?: number
  /** Nur Mails ab diesem Zeitpunkt (ms, Tagesbeginn) */
  after?: number
}

const KEYS: Record<string, 'from' | 'to' | 'subject' | 'file' | 'has' | 'is' | 'before' | 'after'> = {
  von: 'from',
  from: 'from',
  an: 'to',
  to: 'to',
  betreff: 'subject',
  subject: 'subject',
  datei: 'file',
  file: 'file',
  filename: 'file',
  hat: 'has',
  has: 'has',
  ist: 'is',
  is: 'is',
  vor: 'before',
  before: 'before',
  nach: 'after',
  seit: 'after',
  after: 'after',
  since: 'after'
}

/**
 * Zerlegt "von:anna hat:anhang rechnung" in Felder und freie Woerter. Ein
 * Schluessel, den es nicht gibt, oder ein Wert, der nicht passt (etwa ein
 * kaputtes Datum), bleibt ein gewoehnliches Suchwort - so geht nichts verloren,
 * was jemand getippt hat.
 */
export function parseSearch(input: string): ParsedSearch {
  const out: ParsedSearch = { terms: [], from: [], to: [], subject: [], file: [] }
  const pattern = /([A-Za-z]+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g
  for (const match of input.matchAll(pattern)) {
    const [whole, rawKey, rawValue, quoted, bare] = match
    if (rawKey === undefined) {
      const term = (quoted ?? bare ?? '').trim().toLowerCase()
      if (term) out.terms.push(term)
      continue
    }
    const key = KEYS[rawKey.toLowerCase()]
    const value = rawValue.replace(/^"|"$/g, '').trim().toLowerCase()
    if (!key || !value) {
      out.terms.push(whole.toLowerCase())
      continue
    }
    switch (key) {
      case 'from':
      case 'to':
      case 'subject':
      case 'file':
        out[key].push(value)
        break
      case 'has':
        if (/^(anhang|anh(a|ae|ä)nge|attachment|attachments|datei)$/.test(value)) out.hasAttachment = true
        else out.terms.push(whole.toLowerCase())
        break
      case 'is':
        if (/^(ungelesen|unread|neu)$/.test(value)) out.unread = true
        else if (/^(gelesen|read)$/.test(value)) out.unread = false
        else if (/^(markiert|flagged|starred|wichtig)$/.test(value)) out.flagged = true
        else out.terms.push(whole.toLowerCase())
        break
      case 'before':
      case 'after': {
        const day = parseDay(value)
        if (day === null) out.terms.push(whole.toLowerCase())
        else out[key] = day
        break
      }
    }
  }
  return out
}

/** Tagesbeginn (Ortszeit) fuer "2026-09-30", "30.09.2026", "30.9.", "heute" oder "gestern". */
export function parseDay(value: string, now = new Date()): number | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (value === 'heute' || value === 'today') return today.getTime()
  if (value === 'gestern' || value === 'yesterday') return today.getTime() - 86_400_000

  let year: number, month: number, day: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(value)
  if (iso) {
    ;[year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (german) {
    day = Number(german[1])
    month = Number(german[2])
    year = german[3] ? Number(german[3]) : now.getFullYear()
    if (year < 100) year += 2000
  } else {
    return null
  }
  const date = new Date(year, month - 1, day)
  // new Date rechnet den 31. Februar stillschweigend in den Maerz um.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

export function isEmptySearch(search: ParsedSearch): boolean {
  return (
    !search.terms.length &&
    !search.from.length &&
    !search.to.length &&
    !search.subject.length &&
    !search.file.length &&
    search.hasAttachment === undefined &&
    search.unread === undefined &&
    search.flagged === undefined &&
    search.before === undefined &&
    search.after === undefined
  )
}

export function matchesSearch(search: ParsedSearch, m: MessageSummary): boolean {
  if (search.hasAttachment && !m.hasAttachments) return false
  if (search.unread !== undefined && m.flags.includes('\\Seen') === search.unread) return false
  if (search.flagged && !m.flags.includes('\\Flagged')) return false
  if (search.before !== undefined && m.date >= search.before) return false
  if (search.after !== undefined && m.date < search.after) return false

  const from = m.from.map((a) => `${a.name ?? ''} ${a.address}`).join(' ').toLowerCase()
  const to = [...m.to, ...m.cc].map((a) => `${a.name ?? ''} ${a.address}`).join(' ').toLowerCase()
  const subject = m.subject.toLowerCase()
  const files = (m.attachmentNames ?? []).join(' ').toLowerCase()

  if (!search.from.every((v) => from.includes(v))) return false
  if (!search.to.every((v) => to.includes(v))) return false
  if (!search.subject.every((v) => subject.includes(v))) return false
  if (!search.file.every((v) => files.includes(v))) return false

  if (search.terms.length) {
    const haystack = `${subject} ${m.snippet.toLowerCase()} ${from} ${to} ${files}`
    if (!search.terms.every((t) => haystack.includes(t))) return false
  }
  return true
}
