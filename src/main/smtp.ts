import nodemailer from 'nodemailer'
import type { Account, Address, OutgoingMessage } from '@shared/types'
import { APP_PASSWORD_HINT } from './imap'

function transportOptions(account: Account, password: string) {
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    // Bei Port 587 verlangen wir STARTTLS aktiv, statt es nur anzubieten.
    requireTLS: !account.smtp.secure,
    auth: { user: account.username, pass: password },
    // Provider wie WEB.DE werten einen ehrlichen Namen positiv.
    name: 'mailclient.localhost'
  }
}

function formatAddress(a: Address): string {
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address
}

/**
 * Erzeugt die fertige RFC-822-Nachricht. Sie wird zweifach gebraucht: einmal
 * zum Versand und einmal, um sie unveraendert in den Gesendet-Ordner zu legen.
 */
export async function buildRawMessage(
  account: Account,
  msg: OutgoingMessage
): Promise<{ raw: Buffer; messageId: string }> {
  const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${
    account.email.split('@')[1] ?? 'localhost'
  }>`

  const builder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows'
  })

  const info = await builder.sendMail({
    messageId,
    from: formatAddress({ name: account.displayName, address: account.email }),
    to: msg.to.map(formatAddress),
    cc: msg.cc.map(formatAddress),
    bcc: msg.bcc.map(formatAddress),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType
    }))
  })

  return { raw: info.message as Buffer, messageId }
}

export async function sendRaw(
  account: Account,
  password: string,
  raw: Buffer,
  recipients: string[]
): Promise<void> {
  const transport = nodemailer.createTransport(transportOptions(account, password))
  try {
    await transport.sendMail({
      envelope: { from: account.email, to: recipients },
      raw
    })
  } finally {
    transport.close()
  }
}

export async function verifySmtp(account: Account, password: string): Promise<void> {
  const transport = nodemailer.createTransport({
    ...transportOptions(account, password),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000
  })
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

/**
 * Nodemailer haengt die Serverantwort an `response` und den Zahlencode an
 * `responseCode`. Beides gehoert in die Meldung - "authentication failed"
 * allein sagt niemandem, was zu tun ist.
 */
export function describeSmtpError(err: unknown): string {
  const e = (err ?? {}) as {
    message?: string
    code?: string
    responseCode?: number
    response?: string
  }
  const serverText = e.response?.trim()
  const quoted = serverText ? ` Der Server sagt: "${serverText}"` : ''

  if (e.responseCode === 535 || e.code === 'EAUTH' || /authentication|5\.7\.8|invalid login/i.test(e.message ?? '')) {
    return `Der Server hat die Anmeldung abgelehnt.${quoted} ${APP_PASSWORD_HINT}`
  }
  if (e.responseCode === 550 || e.responseCode === 553) {
    return `Die Absenderadresse wurde abgelehnt.${quoted} Sie muss zu dem Konto passen, mit dem du dich anmeldest.`
  }
  if (e.responseCode === 554) {
    return `Der Server hat die Nachricht abgewiesen.${quoted}`
  }
  if (e.code === 'ENOTFOUND') return 'SMTP-Server nicht gefunden. Adresse pruefen.'
  if (e.code === 'ECONNREFUSED') {
    return 'SMTP-Server verweigert die Verbindung. Port pruefen: 465 mit TLS, 587 mit STARTTLS.'
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || /timeout/i.test(e.message ?? '')) {
    return `Keine Verbindung zum SMTP-Server.${quoted} Manche Netze sperren die Mail-Ports.`
  }
  if (serverText) return serverText
  return e.message ?? String(err)
}
