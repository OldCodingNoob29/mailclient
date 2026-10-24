import type { ServerConfig } from './types'

export interface ProviderPreset {
  id: string
  label: string
  /** Domains, an denen der Provider automatisch erkannt wird */
  domains: string[]
  imap: ServerConfig
  smtp: ServerConfig
  /** Direktlink zur Stelle, an der man das App-Passwort erzeugt */
  appPasswordUrl?: string
  /** Kurze, konkrete Anleitung fuer genau diesen Provider */
  hint: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Google akzeptiert das normale Kontopasswort seit Maerz 2025 nicht mehr. Aktiviere die Bestaetigung in zwei Schritten und erzeuge dann unter myaccount.google.com/apppasswords ein 16-stelliges App-Passwort. Leerzeichen darin darfst du mit eintippen.'
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    appPasswordUrl: 'https://account.apple.com/account/manage',
    hint: 'iCloud verlangt ein anwendungsspezifisches Passwort: account.apple.com anmelden, unter "Anmeldung und Sicherheit" ein App-spezifisches Passwort erzeugen. Als Benutzername oft nur der Teil vor dem @ noetig - falls die Anmeldung scheitert, probiere beides.'
  },
  {
    id: 'webde',
    label: 'WEB.DE',
    domains: ['web.de'],
    imap: { host: 'imap.web.de', port: 993, secure: true },
    smtp: { host: 'smtp.web.de', port: 587, secure: false },
    appPasswordUrl: 'https://web.de/',
    hint: 'IMAP muss erst freigeschaltet werden: In WEB.DE unter Einstellungen > POP3/IMAP Abruf den IMAP-Zugriff aktivieren. Danach entweder das Postfach-Passwort oder ein dort erzeugtes anwendungsspezifisches Passwort verwenden.'
  },
  {
    id: 'gmx',
    label: 'GMX',
    domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    imap: { host: 'imap.gmx.net', port: 993, secure: true },
    smtp: { host: 'mail.gmx.net', port: 587, secure: false },
    hint: 'Wie bei WEB.DE muss IMAP in den GMX-Einstellungen unter POP3/IMAP Abruf zuerst aktiviert werden.'
  },
  {
    id: 'outlook',
    label: 'Outlook.com / Hotmail',
    domains: ['outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    appPasswordUrl: 'https://account.microsoft.com/security',
    hint: 'Microsoft hat die Basis-Authentifizierung fuer viele Privatkonten abgeschaltet. Mit aktivierter zweistufiger Ueberpruefung und einem App-Passwort funktioniert IMAP in der Regel weiterhin; bei Geschaeftskonten kann der Administrator es gesperrt haben.'
  },
  {
    id: 'posteo',
    label: 'Posteo',
    domains: ['posteo.de', 'posteo.net'],
    imap: { host: 'posteo.de', port: 993, secure: true },
    smtp: { host: 'posteo.de', port: 465, secure: true },
    hint: 'Posteo funktioniert direkt mit dem normalen Kontopasswort.'
  },
  {
    id: 'mailbox',
    label: 'mailbox.org',
    domains: ['mailbox.org'],
    imap: { host: 'imap.mailbox.org', port: 993, secure: true },
    smtp: { host: 'smtp.mailbox.org', port: 465, secure: true },
    hint: 'Funktioniert mit dem normalen Kontopasswort. Falls du 2FA nutzt, lege im mailbox.org-Backend ein separates Passwort fuer IMAP an.'
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.de', 'ymail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    hint: 'Yahoo verlangt zwingend ein App-Passwort aus den Kontosicherheits-Einstellungen.'
  },
  {
    id: 'custom',
    label: 'Anderer Anbieter (manuell)',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    hint: 'Trage IMAP- und SMTP-Server manuell ein. Port 993 bzw. 465 bedeutet direktes TLS, 143 bzw. 587 bedeutet STARTTLS.'
  }
]

/** Errät anhand der Adresse den Provider; faellt auf "custom" zurueck. */
export function detectProvider(email: string): ProviderPreset {
  const domain = email.split('@')[1]?.toLowerCase().trim()
  if (!domain) return PROVIDERS[PROVIDERS.length - 1]
  const hit = PROVIDERS.find((p) => p.domains.includes(domain))
  return hit ?? PROVIDERS[PROVIDERS.length - 1]
}

/** Vorgeschlagene Akzentfarben - bewusst gedeckt, damit die UI ruhig bleibt. */
export const ACCOUNT_COLORS = [
  '#4f7cff',
  '#e0723c',
  '#3fa06b',
  '#a05fd6',
  '#d64f7c',
  '#3fa3a3',
  '#c9a227',
  '#6b7280'
]
