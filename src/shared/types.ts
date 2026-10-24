/** Gemeinsame Typen zwischen Main-, Preload- und Renderer-Prozess. */

export type AccountId = string

export interface ServerConfig {
  host: string
  port: number
  /** true = implizites TLS (993/465), false = STARTTLS (143/587) */
  secure: boolean
}

export interface Account {
  id: AccountId
  /** Frei waehlbarer Anzeigename, z. B. "Privat" */
  label: string
  /** Absendername in ausgehenden Mails */
  displayName: string
  email: string
  /** Akzentfarbe des Kontos (hex), zieht sich durch die ganze UI */
  color: string
  imap: ServerConfig
  smtp: ServerConfig
  /** Login-Name, meist identisch mit der Adresse */
  username: string
  signature: string
  enabled: boolean
  createdAt: number
}

/** Was der Renderer beim Anlegen/Aendern eines Kontos schickt. */
export interface AccountDraft extends Omit<Account, 'id' | 'createdAt'> {
  id?: AccountId
  /** Nur beim Anlegen bzw. Passwortwechsel gesetzt; wird nie zurueckgegeben. */
  password?: string
}

export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive'
  /** Gmails "Alle Nachrichten": eine Sicht auf alles, kein eigener Ablageort */
  | 'all'
  | 'other'

export interface Folder {
  accountId: AccountId
  /** Vollstaendiger IMAP-Pfad, z. B. "INBOX/Rechnungen" */
  path: string
  /** Nur das letzte Segment, fuer die Anzeige */
  name: string
  delimiter: string
  role: FolderRole
  /** Verschachtelungstiefe fuer die Einrueckung in der Sidebar */
  depth: number
  selectable: boolean
  unread: number
  total: number
  /**
   * Nur eine Sicht auf Mails, die schon anderswo liegen - Gmails "Alle
   * Nachrichten", "Wichtig" und "Markiert". Wird weder angezeigt noch
   * abgeglichen; sonst stuende jede Mail mehrfach in den Sammelansichten.
   */
  hidden?: boolean
}

export interface Address {
  name?: string
  address: string
}

export interface MessageSummary {
  /** `${accountId}|${folder}|${uid}` */
  id: string
  accountId: AccountId
  folder: string
  uid: number
  messageId?: string
  inReplyTo?: string
  references?: string[]
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  /** Zeitstempel in ms */
  date: number
  snippet: string
  flags: string[]
  hasAttachments: boolean
  size: number
  /** Dateinamen der Anhaenge aus der Struktur der Mail; fehlt bei aelteren Cache-Eintraegen */
  attachmentNames?: string[]
  /**
   * Die folgenden Felder stehen nicht in der Ablage. Der Main-Prozess haengt sie
   * beim Ausliefern einer Liste an.
   */
  /** Kennung der Unterhaltung, zu der die Mail gehoert */
  threadId?: string
  /** Wie viele Mails die Unterhaltung ueber alle Ordner hat */
  threadSize?: number
  /** Zurueckgestellt bis zu diesem Zeitpunkt (ms); auch gesetzt, wenn sie gerade wieder aufgetaucht ist */
  snoozedUntil?: number
  /** true, sobald die Zurueckstellung abgelaufen und die Mail wieder da ist */
  snoozeOver?: boolean
}

export interface Attachment {
  /** Stabile ID innerhalb der Nachricht (IMAP part path) */
  partId: string
  filename: string
  contentType: string
  size: number
  /** Content-ID fuer Inline-Bilder, ohne spitze Klammern */
  cid?: string
  inline: boolean
}

export interface MessageBody {
  id: string
  html: string | null
  text: string | null
  attachments: Attachment[]
  /** Inline-Bilder als data:-URLs, gemappt ueber die Content-ID */
  inlineImages: Record<string, string>
  /**
   * Kleine Vorschaubilder fuer Bildanhaenge, gemappt ueber die partId.
   * Fehlt bei Nachrichten, die vor dieser Version im Cache gelandet sind.
   */
  previews?: Record<string, string>
}

export type SyncPhase = 'idle' | 'connecting' | 'syncing' | 'offline' | 'error'

export interface AccountStatus {
  accountId: AccountId
  phase: SyncPhase
  message?: string
  lastSyncAt?: number
}

/** Globale, nicht kontobezogene Einstellungen. */
export interface Settings {
  theme: 'system' | 'light' | 'dark'
  /** Sync-Intervall in Sekunden fuer Ordner ohne IDLE */
  syncIntervalSec: number
  /** Wie viele Nachrichten pro Ordner initial geladen werden */
  initialFetchCount: number
  /** Externe Bilder standardmaessig laden */
  loadRemoteImages: boolean
  /**
   * Absenderdomains, bei denen externe Bilder ohne Nachfrage geladen werden.
   * Untergeordnete Domains zaehlen mit: "example.com" deckt "news.example.com".
   */
  remoteImageDomains: string[]
  /** Nachrichtenliste kompakt statt luftig */
  density: 'comfortable' | 'compact'
  /** Vorschaufenster rechts statt unten */
  previewPosition: 'right' | 'bottom'
  /** Nach wie vielen ms eine geoeffnete Mail als gelesen gilt */
  markReadAfterMs: number
  /** Vergroesserung des Nachrichteninhalts; 1 = Normalgroesse */
  readerZoom: number
  /** Regeln fuer eingehende Post, in der Reihenfolge ihres Vorrangs */
  rules: MailRule[]
  /** Beim Schliessen des Fensters im Infobereich weiterlaufen statt beenden */
  runInTray: boolean
  /** Beim Anmelden am Rechner still im Hintergrund mitstarten */
  startWithSystem: boolean
  /** Hinweis anzeigen, wenn neue Post im Posteingang liegt */
  notifyOnNewMail: boolean
  /** So viele Sekunden laesst sich ein Versand noch zurueckholen; 0 = sofort senden */
  undoSendSec: number
  /** Mails derselben Unterhaltung in der Liste zu einer Zeile zusammenfassen */
  threadView: boolean
  /** Textbausteine fuer den Verfassen-Dialog */
  templates: MailTemplate[]
}

export interface MailTemplate {
  id: string
  name: string
  /** Wird nur uebernommen, wenn die Betreffzeile noch leer ist */
  subject: string
  /** Reiner Text; Zeilenumbrueche bleiben erhalten */
  body: string
}

export type RuleField = 'from' | 'to' | 'subject'
/** "domain" gilt nur fuer Adressen und schliesst Unterdomains ein. */
export type RuleOperator = 'contains' | 'equals' | 'domain'

export interface RuleCondition {
  field: RuleField
  op: RuleOperator
  value: string
}

/**
 * Sortiert Post aus dem Posteingang in einen Ordner. Die erste passende Regel
 * gewinnt; eine Mail wird nie zweimal verschoben.
 */
export interface MailRule {
  id: string
  name: string
  enabled: boolean
  /** null = Posteingang aller Konten */
  accountId: AccountId | null
  /** 'all': jede Bedingung muss zutreffen, 'any': eine genuegt */
  match: 'all' | 'any'
  conditions: RuleCondition[]
  /** Zielordner, Ebenen mit "/" getrennt; fehlt er im Konto, wird er angelegt */
  targetFolder: string
}

export interface RuleRunResult {
  moved: number
  /** Je Konto, bei dem es nicht ging, eine lesbare Zeile */
  errors: string[]
}

/**
 * Eintrag im Adressbuch. Es wird nicht gepflegt, sondern aus den vorhandenen
 * Nachrichten abgeleitet - wer einmal geschrieben hat, steht drin.
 */
export interface Contact {
  address: string
  /** Zuletzt gesehener Anzeigename, leer wenn nie einer mitkam */
  name: string
  /** Wie oft die Adresse in Kopf- oder Empfaengerzeilen vorkam */
  count: number
  /** Juengstes Vorkommen in ms */
  lastAt: number
  /** true, wenn die Adresse im Gesendet-Ordner als Empfaenger auftaucht */
  written: boolean
}

export interface OutgoingAttachment {
  filename: string
  /** base64 */
  content: string
  contentType: string
}

export interface OutgoingMessage {
  accountId: AccountId
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  text: string
  attachments: OutgoingAttachment[]
  /** Message-ID der Mail, auf die geantwortet wird */
  inReplyTo?: string
  references?: string[]
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward'

export interface ComposeSeed {
  mode: ComposeMode
  accountId: AccountId
  to: Address[]
  cc: Address[]
  subject: string
  /** Vorbelegter Body (zitierter Text) als HTML */
  quotedHtml: string
  /** Eigener Text vor der Signatur, etwa aus einem mailto:-Link */
  bodyHtml?: string
  bcc?: Address[]
  inReplyTo?: string
  references?: string[]
  /**
   * Eine aus dem Ausgang zurueckgeholte Nachricht. Ist sie gesetzt, kommt der
   * ganze Inhalt - Text, Blindkopien, Anhaenge - von hier, ohne neue Signatur.
   */
  draft?: OutgoingMessage
}

export interface SearchQuery {
  text: string
  accountId?: AccountId
  folder?: string
  onlyUnread?: boolean
  onlyFlagged?: boolean
  onlyAttachments?: boolean
}

/** Was die Nachrichtenliste gerade zeigt. */
export type ViewRef =
  | { kind: 'folder'; accountId: AccountId; folder: string }
  | { kind: 'unified'; id: 'inbox' | 'flagged' | 'unread' | 'snoozed' | 'attachments' }
  | { kind: 'search'; query: SearchQuery }

/** Eintrag in der Warteschlange fuer noch nicht versendete Mails. */
export interface OutboxEntry {
  id: string
  accountId: AccountId
  subject: string
  recipients: string[]
  /** base64 der fertigen RFC-822-Nachricht; fehlt, solange sie noch nicht gebaut wurde */
  raw?: string
  /** Die Nachricht, wie sie verfasst wurde - zum Zurueckholen und Bearbeiten */
  draft?: OutgoingMessage
  queuedAt: number
  attempts: number
  lastError?: string
  /**
   * Warum der Eintrag wartet: 'undo' ist die kurze Frist zum Zurueckholen,
   * 'scheduled' ein geplanter Versand, 'retry' ein gescheiterter Versuch.
   * Fehlt bei Eintraegen aus aelteren Versionen - die sind 'retry'.
   */
  kind?: 'undo' | 'scheduled' | 'retry'
  /** Nicht vor diesem Zeitpunkt senden (ms) */
  sendAt?: number
  /** Der Server hat endgueltig abgelehnt; wird nicht erneut versucht */
  failed?: boolean
}

/** Was die Oberflaeche vom Ausgang sieht - ohne den Inhalt der Nachricht. */
export type OutboxItem = Omit<OutboxEntry, 'raw' | 'draft'> & {
  /** Laesst sich im Verfassen-Dialog wieder oeffnen */
  editable: boolean
}

export interface SendResult {
  /** true, wenn der Versand am Netz scheiterte und spaeter erneut versucht wird */
  queued: boolean
  /** Gesetzt, wenn die Nachricht noch im Ausgang wartet */
  outboxId?: string
  sendAt?: number
  /** Wartet nur die Frist zum Zurueckholen ab */
  undoable?: boolean
  /** Wartet auf einen geplanten Zeitpunkt */
  scheduled?: boolean
}

/** Ergebnis eines Verbindungstests im Konto-Assistenten. */
export interface ConnectionTestResult {
  imap: { ok: boolean; error?: string }
  smtp: { ok: boolean; error?: string }
}

export const FLAG_SEEN = '\\Seen'
export const FLAG_FLAGGED = '\\Flagged'
export const FLAG_ANSWERED = '\\Answered'
export const FLAG_DRAFT = '\\Draft'
export const FLAG_DELETED = '\\Deleted'

/** Virtueller Ordner, der alle Posteingaenge zusammenfasst. */
export const UNIFIED_INBOX = '__unified_inbox__'
export const UNIFIED_FLAGGED = '__unified_flagged__'
export const UNIFIED_UNREAD = '__unified_unread__'

export function messageKey(accountId: AccountId, folder: string, uid: number): string {
  return `${accountId}|${folder}|${uid}`
}
