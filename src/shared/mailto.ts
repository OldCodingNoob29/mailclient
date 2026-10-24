/**
 * mailto:-Links (RFC 6068), wie sie Windows uebergibt, wenn der Mailclient als
 * Standard-App fuer E-Mail eingetragen ist: "mailto:a@b.de,c@d.de?subject=Hallo&cc=e@f.de&body=..."
 */
export interface MailtoDraft {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

const addresses = (value: string): string[] =>
  value
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter((a) => /^[^\s@]+@[^\s@]+$/.test(a))

export function parseMailto(url: string): MailtoDraft | null {
  if (!/^mailto:/i.test(url)) return null
  const rest = url.slice('mailto:'.length)
  const [target, query = ''] = rest.split('?', 2)
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, '%20'))
    } catch {
      return s
    }
  }
  const draft: MailtoDraft = { to: addresses(decode(target)), cc: [], bcc: [], subject: '', body: '' }
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=', 2)
    const key = rawKey.toLowerCase()
    const value = decode(rawValue)
    if (key === 'to') draft.to.push(...addresses(value))
    else if (key === 'cc') draft.cc.push(...addresses(value))
    else if (key === 'bcc') draft.bcc.push(...addresses(value))
    else if (key === 'subject') draft.subject = value
    else if (key === 'body') draft.body = value
  }
  return draft
}

/** Der erste mailto:-Link in einer Befehlszeile, wie sie Windows beim Start uebergibt. */
export function mailtoFromArgv(argv: string[]): string | null {
  return argv.find((a) => /^mailto:/i.test(a)) ?? null
}
