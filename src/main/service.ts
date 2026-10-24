import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type {
  Account,
  AccountDraft,
  Address,
  AccountId,
  AccountStatus,
  ConnectionTestResult,
  Contact,
  Folder,
  MailRule,
  MessageBody,
  MessageSummary,
  RuleRunResult,
  OutboxEntry,
  OutboxItem,
  OutgoingMessage,
  SearchQuery,
  SendResult,
  Settings,
  SyncPhase,
  ViewRef
} from '@shared/types'
import { isRuleUsable, matchesRule } from '@shared/rules'
import { isEmptySearch, matchesSearch, parseSearch, type ParsedSearch } from '@shared/search'
import { buildThreadIndex, linkedIds, normalizeMessageId } from '@shared/threads'
import { AccountConnection, describeError } from './imap'
import { buildRawMessage, describeSmtpError, sendRaw, verifySmtp } from './smtp'
import { Store, type SnoozeEntry } from './store'
import { ImapFlow, type SearchObject } from 'imapflow'

type Emit = (channel: string, payload: unknown) => void
/** Wird gerufen, wenn ungelesene Post eingetroffen ist. */
type Notifier = (account: Account, messages: MessageSummary[]) => void
/** Wird gerufen, wenn eine zurueckgestellte Mail wieder auftaucht. */
type ReturnNotifier = (account: Account, message: MessageSummary) => void

const OUTBOX_RETRY_MS = 60_000
/** Laenger kann setTimeout nicht warten; spaetere Termine werden nachgefasst. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** So viele fehlende Verweise einer Unterhaltung werden auf dem Server gesucht. */
const THREAD_MISSING_LIMIT = 10
/** So viele Adressen liefert das Adressbuch hoechstens auf einmal. */
const CONTACT_LIMIT = 8

/**
 * Bindeglied zwischen Ablage, IMAP-Verbindungen und der Oberflaeche. Alles, was
 * der Renderer per IPC aufruft, landet hier.
 */
export class MailService {
  private store = new Store()
  private connections = new Map<AccountId, AccountConnection>()
  private statuses = new Map<AccountId, AccountStatus>()
  private outbox: OutboxEntry[] = []
  private outboxTimer: NodeJS.Timeout | null = null
  /** Weckt den Ausgang zum naechsten faelligen Versand (Frist oder Termin). */
  private outboxDueTimer: NodeJS.Timeout | null = null
  private flushing = false
  /** Eintraege, die gerade beim Server sind - die lassen sich nicht mehr zurueckholen. */
  private inFlight = new Set<string>()
  private snoozeTimer: NodeJS.Timeout | null = null
  /** Abgeleitete Unterhaltungen; null heisst "muss neu aufgebaut werden". */
  private threadCache: { ids: Map<string, string>; sizes: Map<string, number> } | null = null
  /** Unterhaltung -> Stand, zu dem der Server zuletzt befragt wurde */
  private threadLookups = new Map<string, string>()
  /** Bremst die Ereignisse Richtung Renderer aus, damit die UI nicht flackert. */
  private pendingEmits = new Set<string>()
  private emitTimer: NodeJS.Timeout | null = null
  /** Abgeleitetes Adressbuch; null heisst "muss neu aufgebaut werden". */
  private contacts: Contact[] | null = null

  constructor(
    private emit: Emit,
    private notify: Notifier,
    private notifyReturned: ReturnNotifier
  ) {}

  async init(): Promise<void> {
    await this.store.load()
    await this.loadOutbox()
    for (const account of this.store.listAccounts()) {
      if (account.enabled) void this.connect(account)
    }
    this.outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_RETRY_MS)
    // Was faellig wurde, waehrend die App zu war, taucht jetzt wieder auf.
    void this.wakeSnoozed()
  }

  async shutdown(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer)
    if (this.outboxDueTimer) clearTimeout(this.outboxDueTimer)
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer)
    await Promise.all([...this.connections.values()].map((c) => c.close()))
    await this.store.close()
  }

  // ------------------------------------------------------- Ereignisse

  private queueEmit(channel: string): void {
    this.pendingEmits.add(channel)
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const channels = [...this.pendingEmits]
      this.pendingEmits.clear()
      for (const channel of channels) this.emit(channel, null)
    }, 120)
  }

  private events = {
    onStatus: (accountId: AccountId, phase: SyncPhase, message?: string) => {
      const previous = this.statuses.get(accountId)
      this.statuses.set(accountId, {
        accountId,
        phase,
        message,
        lastSyncAt: phase === 'idle' ? Date.now() : previous?.lastSyncAt
      })
      this.emit('status:changed', this.getStatuses())
    },
    onFolders: (_accountId: AccountId) => this.queueEmit('folders:changed'),
    onMessages: (_accountId: AccountId, _folder: string) => {
      // Neue oder geaenderte Mails koennen neue Adressen und Verweise mitbringen.
      this.contacts = null
      this.threadCache = null
      this.queueEmit('messages:changed')
    },
    onArrived: (accountId: AccountId, folder: string, messages: MessageSummary[], opts: { notify: boolean }) => {
      void this.handleArrivals(accountId, folder, messages, opts.notify)
    }
  }

  // ---------------------------------------------------------- Konten

  private async connect(account: Account): Promise<void> {
    const password = this.store.getPassword(account.id)
    if (!password) {
      this.events.onStatus(account.id, 'error', 'Kein Passwort hinterlegt. Konto neu einrichten.')
      return
    }
    const existing = this.connections.get(account.id)
    if (existing) await existing.close()

    const connection = new AccountConnection(account, password, this.store, this.events)
    this.connections.set(account.id, connection)
    try {
      await connection.start()
    } catch {
      // Der Status wurde bereits gesetzt; Wiederverbinden laeuft im Hintergrund.
    }
  }

  listAccounts(): Account[] {
    return this.store.listAccounts()
  }

  getStatuses(): AccountStatus[] {
    return this.store.listAccounts().map(
      (a) => this.statuses.get(a.id) ?? { accountId: a.id, phase: 'idle' as SyncPhase }
    )
  }

  async saveAccount(draft: AccountDraft): Promise<Account> {
    const { password, ...rest } = draft
    const account = await this.store.upsertAccount(rest, password)
    this.emit('accounts:changed', null)
    if (account.enabled) void this.connect(account)
    else {
      await this.connections.get(account.id)?.close()
      this.connections.delete(account.id)
    }
    return account
  }

  async deleteAccount(id: AccountId): Promise<void> {
    await this.connections.get(id)?.close()
    this.connections.delete(id)
    this.statuses.delete(id)
    await this.store.removeAccount(id)
    this.emit('accounts:changed', null)
    this.queueEmit('folders:changed')
    this.queueEmit('messages:changed')
  }

  /** Prueft IMAP und SMTP getrennt, damit der Assistent sagen kann, was klemmt. */
  async testConnection(draft: AccountDraft): Promise<ConnectionTestResult> {
    const password = draft.password || (draft.id ? this.store.getPassword(draft.id) : undefined)
    const result: ConnectionTestResult = { imap: { ok: false }, smtp: { ok: false } }
    if (!password) {
      const missing = 'Kein Passwort angegeben.'
      return { imap: { ok: false, error: missing }, smtp: { ok: false, error: missing } }
    }

    const client = new ImapFlow({
      host: draft.imap.host,
      port: draft.imap.port,
      secure: draft.imap.secure,
      auth: { user: draft.username, pass: password },
      logger: false,
      emitLogs: false
    })
    // Ohne diesen Handler beendet ein Verbindungsfehler den ganzen Prozess.
    client.on('error', () => {})
    try {
      await client.connect()
      await client.list()
      result.imap.ok = true
      await client.logout()
    } catch (err) {
      // Rohfehler ins Log, damit im Zweifel nachvollziehbar bleibt, was der
      // Server geantwortet hat.
      console.error('[test imap]', err)
      result.imap.error = describeError(err)
      try {
        client.close()
      } catch {
        /* Verbindung war nie offen */
      }
    }

    const account = { ...draft, id: draft.id ?? 'test', createdAt: 0 } as Account
    try {
      await verifySmtp(account, password)
      result.smtp.ok = true
    } catch (err) {
      console.error('[test smtp]', err)
      result.smtp.error = describeSmtpError(err)
    }
    return result
  }

  isEncryptionAvailable(): boolean {
    return this.store.isEncryptionAvailable()
  }

  // -------------------------------------------------------- Ansichten

  listFolders(): Folder[] {
    return this.store.listAccounts().flatMap((a) => this.store.getFolders(a.id))
  }

  listMessages(view: ViewRef, limit = 500): MessageSummary[] {
    return this.decorate(this.selectMessages(view, limit))
  }

  private selectMessages(view: ViewRef, limit: number): MessageSummary[] {
    switch (view.kind) {
      case 'folder':
        return this.arrange(this.store.getMessages(view.accountId, view.folder)).slice(0, limit)
      case 'unified': {
        if (view.id === 'inbox') return this.arrange(this.dedupe(this.store.messagesInRole('inbox'))).slice(0, limit)
        const all = this.visibleMessages()
        if (view.id === 'snoozed') {
          const snoozes = this.store.getSnoozes()
          const until = (m: MessageSummary): number => snoozes.get(m.id)?.until ?? 0
          return all
            .filter((m) => this.isSnoozed(m))
            .sort((a, b) => until(a) - until(b))
            .slice(0, limit)
        }
        const filtered =
          view.id === 'flagged'
            ? all.filter((m) => m.flags.includes('\\Flagged'))
            : view.id === 'attachments'
              ? all.filter((m) => m.hasAttachments && !this.isNoise(m))
              : all.filter((m) => !m.flags.includes('\\Seen') && !this.isNoise(m))
        return this.arrange(this.dedupe(filtered)).slice(0, limit)
      }
      case 'search':
        return this.search(view.query, limit)
    }
  }

  /** Alle Mails ausser denen in reinen Sichten wie Gmails "Alle Nachrichten". */
  private visibleMessages(): MessageSummary[] {
    const hidden = new Set<string>()
    for (const account of this.store.listAccounts()) {
      for (const folder of this.store.getFolders(account.id)) {
        if (folder.hidden) hidden.add(`${account.id}|${folder.path}`)
      }
    }
    const all = this.store.allMessages()
    return hidden.size ? all.filter((m) => !hidden.has(`${m.accountId}|${m.folder}`)) : all
  }

  /**
   * Dieselbe Mail liegt oft in mehreren Ordnern - bei Gmail ist jedes Label ein
   * Ordner. In Sammelansichten und der Suche steht sie nur einmal, und zwar die
   * Kopie, die am ehesten gemeint ist: Posteingang vor Archiv vor eigenen
   * Ordnern, Papierkorb und Spam zuletzt.
   */
  private dedupe(list: MessageSummary[]): MessageSummary[] {
    const roles = new Map<string, string>()
    for (const account of this.store.listAccounts()) {
      for (const folder of this.store.getFolders(account.id)) roles.set(`${account.id}|${folder.path}`, folder.role)
    }
    const order = ['inbox', 'archive', 'all', 'other', 'sent', 'drafts', 'junk', 'trash']
    const rank = (m: MessageSummary): number => order.indexOf(roles.get(`${m.accountId}|${m.folder}`) ?? 'other')
    const key = (m: MessageSummary): string => `${m.accountId}|${normalizeMessageId(m.messageId) ?? m.id}`

    const best = new Map<string, MessageSummary>()
    for (const m of list) {
      const current = best.get(key(m))
      if (!current || rank(m) < rank(current)) best.set(key(m), m)
    }
    return best.size === list.length ? list : list.filter((m) => best.get(key(m)) === m)
  }

  /** Wartet die Mail gerade auf ihren Zeitpunkt? */
  private isSnoozed(msg: MessageSummary): boolean {
    const snooze = this.store.getSnoozes().get(msg.id)
    return Boolean(snooze && !snooze.over)
  }

  /**
   * Blendet Zurueckgestelltes aus und sortiert. Was wieder aufgetaucht ist,
   * steht an der Stelle seines Weckzeitpunkts - also oben - und nicht dort, wo
   * sein altes Datum es hinsortieren wuerde.
   */
  private arrange(list: MessageSummary[]): MessageSummary[] {
    const snoozes = this.store.getSnoozes()
    if (!snoozes.size) return [...list].sort((a, b) => b.date - a.date)
    const rank = (m: MessageSummary): number => {
      const snooze = snoozes.get(m.id)
      return snooze?.over ? Math.max(snooze.until, m.date) : m.date
    }
    return list.filter((m) => !this.isSnoozed(m)).sort((a, b) => rank(b) - rank(a))
  }

  /** Haengt an, was die Oberflaeche ueber Unterhaltung und Zurueckstellung wissen muss. */
  private decorate(list: MessageSummary[]): MessageSummary[] {
    const threads = this.threads()
    const snoozes = this.store.getSnoozes()
    return list.map((m) => {
      const threadId = threads.ids.get(m.id)
      const snooze = snoozes.get(m.id)
      return {
        ...m,
        threadId,
        threadSize: threadId ? threads.sizes.get(threadId) : undefined,
        snoozedUntil: snooze?.until,
        snoozeOver: snooze?.over
      }
    })
  }

  // ---------------------------------------------------- Unterhaltungen

  /** Papierkorb, Spam und Entwuerfe zaehlen nicht zu einer Unterhaltung. */
  private outsideThreads(): Set<string> {
    const out = new Set<string>()
    for (const account of this.store.listAccounts()) {
      for (const folder of this.store.getFolders(account.id)) {
        if (folder.role === 'trash' || folder.role === 'junk' || folder.role === 'drafts') {
          out.add(`${account.id}|${folder.path}`)
        }
      }
    }
    return out
  }

  private threads(): { ids: Map<string, string>; sizes: Map<string, number> } {
    if (this.threadCache) return this.threadCache
    const all = this.store.allMessages()
    const ids = buildThreadIndex(all)
    const outside = this.outsideThreads()
    // Dieselbe Mail liegt oft in zwei Ordnern (Gmail: Posteingang und "Alle
    // Nachrichten"). Gezaehlt wird sie einmal.
    const seen = new Map<string, Set<string>>()
    for (const m of all) {
      if (outside.has(`${m.accountId}|${m.folder}`)) continue
      const threadId = ids.get(m.id)
      if (!threadId) continue
      let set = seen.get(threadId)
      if (!set) seen.set(threadId, (set = new Set()))
      set.add(normalizeMessageId(m.messageId) ?? m.id)
    }
    const sizes = new Map<string, number>()
    for (const [threadId, set] of seen) sizes.set(threadId, set.size)
    this.threadCache = { ids, sizes }
    return this.threadCache
  }

  /**
   * Alle lokal bekannten Mails der Unterhaltung, aelteste zuerst. Nebenbei wird
   * der Server nach fehlenden Teilen gefragt; findet er welche, meldet sich die
   * Liste von selbst neu.
   */
  getThread(accountId: AccountId, folder: string, uid: number): MessageSummary[] {
    const current = this.store.getMessage(accountId, folder, uid)
    if (!current) return []
    const threads = this.threads()
    const threadId = threads.ids.get(current.id)
    if (!threadId) return this.decorate([current])

    const outside = this.outsideThreads()
    const candidates = this.store
      .allMessages()
      .filter(
        (m) =>
          threads.ids.get(m.id) === threadId &&
          (m.id === current.id || !outside.has(`${m.accountId}|${m.folder}`))
      )
    // Bei Doppelgaengern gewinnt die offene Mail, danach die Kopie im selben Ordner.
    const preference = (m: MessageSummary): number => (m.id === current.id ? 0 : m.folder === folder ? 1 : 2)
    const unique = new Map<string, MessageSummary>()
    for (const m of [...candidates].sort((a, b) => preference(a) - preference(b))) {
      const key = normalizeMessageId(m.messageId) ?? m.id
      if (!unique.has(key)) unique.set(key, m)
    }
    const members = [...unique.values()].sort((a, b) => a.date - b.date)

    void this.completeThread(threadId, current, members).catch(() => {})
    return this.decorate(members)
  }

  private async completeThread(threadId: string, current: MessageSummary, members: MessageSummary[]): Promise<void> {
    const connection = this.connections.get(current.accountId)
    if (!connection) return

    const known = members.map((m) => normalizeMessageId(m.messageId)).filter((id): id is string => Boolean(id))
    const knownSet = new Set(known)
    const missing = [...new Set(members.flatMap(linkedIds))]
      .filter((id) => !knownSet.has(id))
      .slice(-THREAD_MISSING_LIMIT)
    if (!known.length && !missing.length) return

    // Jede Unterhaltung nur einmal je Stand befragen - sonst fragte jedes
    // Neuladen der Liste den Server erneut.
    const state = `${[...knownSet].sort().join(',')}|${missing.join(',')}`
    if (this.threadLookups.get(threadId) === state) return
    this.threadLookups.set(threadId, state)

    // Antworten haengen an der juengsten Mail oder am Anfang der Unterhaltung.
    const anchors = [...new Set([known[0], ...known.slice(-3)])].filter(Boolean)
    // Gmails "Alle Nachrichten" ist versteckt, aber genau dort liegt Archiviertes.
    const roles = new Set(['inbox', 'sent', 'archive', 'all'])
    const folders = this.store
      .getFolders(current.accountId)
      .filter((f) => f.selectable && (f.path === current.folder || roles.has(f.role)))
      .map((f) => f.path)

    for (const folder of folders) {
      try {
        await connection.fetchThreadParts(folder, missing, anchors)
      } catch {
        // Nicht jeder Server kann nach Kopfzeilen suchen - dann bleibt es beim lokalen Stand.
      }
    }
  }

  /** Papierkorb und Spam gehoeren nicht in "Ungelesen". */
  private isNoise(msg: MessageSummary): boolean {
    const folder = this.store.getFolders(msg.accountId).find((f) => f.path === msg.folder)
    return folder?.role === 'trash' || folder?.role === 'junk'
  }

  private search(query: SearchQuery, limit: number): MessageSummary[] {
    const parsed = parseSearch(query.text)
    let pool = query.accountId
      ? query.folder
        ? this.store.getMessages(query.accountId, query.folder)
        : this.store.getFolders(query.accountId).flatMap((f) => this.store.getMessages(query.accountId!, f.path))
      : this.visibleMessages()

    if (query.onlyUnread) pool = pool.filter((m) => !m.flags.includes('\\Seen'))
    if (query.onlyFlagged) pool = pool.filter((m) => m.flags.includes('\\Flagged'))
    if (query.onlyAttachments) pool = pool.filter((m) => m.hasAttachments)

    if (!isEmptySearch(parsed)) pool = pool.filter((m) => matchesSearch(parsed, m))

    return this.dedupe([...pool].sort((a, b) => b.date - a.date)).slice(0, limit)
  }

  /**
   * Sucht zusaetzlich auf dem Server. Findet auch Mails, deren Text nie lokal
   * zwischengespeichert wurde.
   */
  async searchServer(query: SearchQuery): Promise<void> {
    const criteria = toServerSearch(parseSearch(query.text))
    if (!criteria) return
    const targets = query.accountId
      ? [query.accountId]
      : this.store.listAccounts().filter((a) => a.enabled).map((a) => a.id)

    await Promise.all(
      targets.map(async (accountId) => {
        const connection = this.connections.get(accountId)
        if (!connection) return
        const folders = query.folder
          ? [query.folder]
          : this.store
              .getFolders(accountId)
              .filter((f) => f.selectable && f.role !== 'junk' && f.role !== 'trash')
              .slice(0, 6)
              .map((f) => f.path)
        for (const folder of folders) {
          try {
            const uids = await connection.searchServer(folder, criteria)
            await connection.hydrate(folder, uids)
          } catch {
            // Nicht jeder Server kann jede Suche - lokal haben wir trotzdem Treffer.
          }
        }
      })
    )
    this.queueEmit('messages:changed')
  }

  // ------------------------------------------------------ Nachrichten

  async getBody(accountId: AccountId, folder: string, uid: number): Promise<MessageBody | null> {
    const connection = this.connections.get(accountId)
    if (!connection) return this.store.getBody(accountId, folder, uid)
    try {
      return await connection.getBody(folder, uid)
    } catch {
      // Offline: wenigstens den Cache anbieten.
      return this.store.getBody(accountId, folder, uid)
    }
  }

  async setSeen(items: MessageSummary[], seen: boolean): Promise<void> {
    // Eine wieder aufgetauchte Mail gilt als erledigt, sobald sie gelesen ist.
    if (seen) await this.dropSnoozes(items, true)
    await this.forEachGroup(items, (connection, folder, uids) => connection.setSeen(folder, uids, seen))
  }

  async setFlagged(items: MessageSummary[], flagged: boolean): Promise<void> {
    await this.forEachGroup(items, (connection, folder, uids) => connection.setFlagged(folder, uids, flagged))
  }

  async remove(items: MessageSummary[]): Promise<void> {
    await this.dropSnoozes(items, false)
    await this.forEachGroup(items, (connection, folder, uids) => connection.remove(folder, uids))
  }

  async archive(items: MessageSummary[]): Promise<void> {
    await this.dropSnoozes(items, false)
    await this.forEachGroup(items, async (connection, folder, uids) => {
      // Gmail kennt keinen Archiv-Ordner: archivieren heisst dort, die Mail nach
      // "Alle Nachrichten" zu verschieben - also nur das Label Posteingang zu nehmen.
      const archive = connection.folderByRole('archive') ?? connection.folderByRole('all')
      if (!archive) throw new Error('Dieses Konto hat keinen Archiv-Ordner.')
      if (archive.path === folder) return
      await connection.move(folder, uids, archive.path)
    })
  }

  async moveTo(items: MessageSummary[], targetFolder: string): Promise<void> {
    await this.dropSnoozes(items, false)
    await this.forEachGroup(items, (connection, folder, uids) => connection.move(folder, uids, targetFolder))
  }

  // ------------------------------------------------------ Zurueckstellen

  /**
   * Blendet Mails bis zu einem Zeitpunkt aus. Das ist rein lokal: auf dem
   * Server und auf anderen Geraeten bleibt die Mail, wo sie ist.
   */
  async snooze(items: MessageSummary[], until: number): Promise<void> {
    if (!(until > Date.now())) throw new Error('Der Zeitpunkt liegt in der Vergangenheit.')
    await this.store.setSnoozes(items.map((m) => [m.id, { until }]))
    this.armSnoozeTimer()
    this.queueEmit('messages:changed')
  }

  async unsnooze(items: MessageSummary[]): Promise<void> {
    await this.dropSnoozes(items, false)
    this.armSnoozeTimer()
    this.queueEmit('messages:changed')
  }

  private async dropSnoozes(items: MessageSummary[], onlyOver: boolean): Promise<void> {
    const snoozes = this.store.getSnoozes()
    if (!snoozes.size) return
    const drop = items.filter((m) => {
      const snooze = snoozes.get(m.id)
      return snooze && (!onlyOver || snooze.over)
    })
    if (!drop.length) return
    await this.store.setSnoozes(drop.map((m) => [m.id, null]))
    this.queueEmit('messages:changed')
  }

  private armSnoozeTimer(): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer)
    this.snoozeTimer = null
    let next = Infinity
    for (const snooze of this.store.getSnoozes().values()) {
      if (!snooze.over && snooze.until < next) next = snooze.until
    }
    if (next === Infinity) return
    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS)
    this.snoozeTimer = setTimeout(() => void this.wakeSnoozed(), delay)
  }

  /** Holt zurueck, was faellig ist: wieder sichtbar, ungelesen, mit Hinweis. */
  private async wakeSnoozed(): Promise<void> {
    const now = Date.now()
    const changes: [string, SnoozeEntry | null][] = []
    const woken: MessageSummary[] = []
    for (const [id, snooze] of this.store.getSnoozes()) {
      if (snooze.over || snooze.until > now) continue
      const message = this.findById(id)
      // Die Mail wurde inzwischen verschoben oder geloescht - nichts zu wecken.
      if (!message) changes.push([id, null])
      else {
        changes.push([id, { until: snooze.until, over: true }])
        woken.push(message)
      }
    }
    if (changes.length) {
      await this.store.setSnoozes(changes)
      this.queueEmit('messages:changed')
    }
    for (const message of woken) {
      const account = this.store.getAccount(message.accountId)
      if (account) this.notifyReturned(account, message)
    }
    // Ungelesen setzen ist ein Komfort - ohne Verbindung steht die Mail trotzdem wieder oben.
    if (woken.length) {
      await this.forEachGroup(woken, (connection, folder, uids) => connection.setSeen(folder, uids, false)).catch(
        () => {}
      )
    }
    this.armSnoozeTimer()
  }

  /** Zerlegt `konto|ordner|uid`; der Ordnerpfad darf selbst "|" enthalten. */
  private findById(id: string): MessageSummary | undefined {
    const first = id.indexOf('|')
    const last = id.lastIndexOf('|')
    if (first < 0 || last <= first) return undefined
    return this.store.getMessage(id.slice(0, first), id.slice(first + 1, last), Number(id.slice(last + 1)))
  }

  /**
   * Aktionen betreffen oft eine Auswahl ueber mehrere Konten und Ordner hinweg.
   * Die Gruppen laufen nebeneinander; je Konto reiht die Verbindung ohnehin
   * alles hintereinander. So setzt etwa "gelesen" alle Gruppen sofort lokal,
   * statt dass die zweite auf den Server der ersten wartet.
   */
  private async forEachGroup(
    items: MessageSummary[],
    fn: (connection: AccountConnection, folder: string, uids: number[]) => Promise<void>
  ): Promise<void> {
    const groups = new Map<string, { accountId: AccountId; folder: string; uids: number[] }>()
    for (const item of items) {
      const key = `${item.accountId}|${item.folder}`
      let group = groups.get(key)
      if (!group) {
        group = { accountId: item.accountId, folder: item.folder, uids: [] }
        groups.set(key, group)
      }
      group.uids.push(item.uid)
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const connection = this.connections.get(group.accountId)
        if (connection) await fn(connection, group.folder, group.uids)
      })
    )
  }

  /**
   * "Alle als gelesen" auf drei Ebenen: ein Ordner, ein ganzes Konto oder
   * alles. Papierkorb und Spam bleiben aussen vor - dort ungelesene Post als
   * gelesen zu markieren hilft niemandem.
   */
  async markRead(target: { accountId?: AccountId; folder?: string }): Promise<void> {
    const accountIds = target.accountId
      ? [target.accountId]
      : this.store.listAccounts().filter((a) => a.enabled).map((a) => a.id)

    for (const accountId of accountIds) {
      const connection = this.connections.get(accountId)
      if (!connection) continue

      const folders = target.folder
        ? [target.folder]
        : this.store
            .getFolders(accountId)
            .filter((f) => f.selectable && f.unread > 0 && f.role !== 'trash' && f.role !== 'junk')
            .map((f) => f.path)

      for (const folder of folders) {
        await connection.markFolderRead(folder).catch(() => {})
      }
    }
    this.queueEmit('messages:changed')
    this.queueEmit('folders:changed')
  }

  async emptyFolder(accountId: AccountId, folder: string): Promise<void> {
    const connection = this.connections.get(accountId)
    if (!connection) throw new Error('Konto ist nicht verbunden.')
    await connection.emptyFolder(folder)
  }

  async refresh(accountId?: AccountId, folder?: string): Promise<void> {
    const targets = accountId
      ? [this.connections.get(accountId)].filter(Boolean)
      : [...this.connections.values()]
    await Promise.all((targets as AccountConnection[]).map((c) => c.refresh(folder).catch(() => {})))
  }

  async getAttachment(
    accountId: AccountId,
    folder: string,
    uid: number,
    partId: string
  ): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
    const connection = this.connections.get(accountId)
    if (!connection) return null
    return connection.getAttachment(folder, uid, partId)
  }

  // -------------------------------------------------------------- Regeln

  /** Regeln, die fuer ein Konto gelten, in der Reihenfolge ihres Vorrangs. */
  private rulesFor(accountId: AccountId): MailRule[] {
    return this.store
      .getSettings()
      .rules.filter((r) => r.enabled && isRuleUsable(r) && (r.accountId === null || r.accountId === accountId))
  }

  /**
   * Neue Post im Posteingang: erst zuordnen, dann benachrichtigen, dann
   * verschieben. Die erste passende Regel gewinnt. Benachrichtigt wird nur, was
   * im Posteingang bleibt - wer GitHub in einen eigenen Ordner sortiert, will
   * davon nicht angetippt werden. Und zwar sofort: das Verschieben wartet in der
   * Warteschlange des Kontos, bis der laufende Abgleich durch ist.
   */
  private async handleArrivals(
    accountId: AccountId,
    folder: string,
    messages: MessageSummary[],
    notify: boolean
  ): Promise<void> {
    const rules = this.rulesFor(accountId)
    const assigned = new Map<MailRule, MessageSummary[]>()
    const remaining: MessageSummary[] = []
    for (const message of messages) {
      const rule = rules.find((r) => matchesRule(r, message))
      if (rule) assigned.set(rule, [...(assigned.get(rule) ?? []), message])
      else remaining.push(message)
    }

    const account = this.store.getAccount(accountId)
    const unseen = remaining.filter((m) => !m.flags.includes('\\Seen'))
    if (notify && account && unseen.length) this.notify(account, unseen)

    const connection = this.connections.get(accountId)
    if (!connection) return
    for (const [rule, hits] of assigned) {
      try {
        const target = await connection.ensureFolder(rule.targetFolder)
        if (target !== folder) await connection.move(folder, hits.map((m) => m.uid), target)
      } catch (err) {
        // Eine Regel, die scheitert, darf die naechste nicht aufhalten.
        console.error(`[regel] ${rule.name || rule.id}:`, err)
      }
    }
  }

  /**
   * Wendet eine gespeicherte Regel auf den Bestand im Posteingang an. Gefragt
   * wird auch der Server, damit Mails ausserhalb des lokal gehaltenen Fensters
   * mitkommen.
   */
  async applyRule(ruleId: string): Promise<RuleRunResult> {
    const rule = this.store.getSettings().rules.find((r) => r.id === ruleId)
    if (!rule) throw new Error('Diese Regel gibt es nicht mehr.')
    if (!isRuleUsable(rule)) {
      throw new Error('Die Regel braucht einen Zielordner und mindestens eine Bedingung.')
    }

    const result: RuleRunResult = { moved: 0, errors: [] }
    const accounts = this.store
      .listAccounts()
      .filter((a) => a.enabled && (rule.accountId === null || rule.accountId === a.id))
    for (const account of accounts) {
      const connection = this.connections.get(account.id)
      if (!connection) {
        result.errors.push(`${account.label}: nicht verbunden`)
        continue
      }
      try {
        result.moved += await this.runRuleOnInbox(connection, account.id, rule)
      } catch (err) {
        result.errors.push(`${account.label}: ${describeError(err)}`)
      }
    }
    this.queueEmit('messages:changed')
    this.queueEmit('folders:changed')
    return result
  }

  private async runRuleOnInbox(connection: AccountConnection, accountId: AccountId, rule: MailRule): Promise<number> {
    const inbox = connection.folderByRole('inbox')
    if (!inbox) return 0
    const candidates = await connection.searchRuleCandidates(inbox.path, rule)
    await connection.hydrate(inbox.path, candidates)
    const hits = this.store.getMessages(accountId, inbox.path).filter((m) => matchesRule(rule, m))
    if (!hits.length) return 0
    const target = await connection.ensureFolder(rule.targetFolder)
    if (target === inbox.path) return 0
    await connection.move(inbox.path, hits.map((m) => m.uid), target)
    return hits.length
  }

  // -------------------------------------------------------- Einstellungen

  getSettings(): Settings {
    return this.store.getSettings()
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const settings = await this.store.updateSettings(patch)
    // Ein geaendertes Intervall soll sofort gelten, nicht erst beim Neustart.
    if (patch.syncIntervalSec !== undefined) {
      for (const connection of this.connections.values()) connection.restartPolling()
    }
    this.emit('settings:changed', settings)
    return settings
  }

  // ------------------------------------------------------------ Adressbuch

  /**
   * Adressen, die in vorhandenen Mails vorkommen. Nichts davon wird eigens
   * gespeichert - die Liste entsteht aus den Kopfdaten, die ohnehin da sind,
   * und ist damit automatisch so aktuell wie das Postfach.
   */
  suggestContacts(query: string, limit = CONTACT_LIMIT): Contact[] {
    const needle = query.trim().toLowerCase()
    const all = this.contacts ?? (this.contacts = this.buildContacts())
    const hits = needle
      ? all.filter((c) => c.address.includes(needle) || c.name.toLowerCase().includes(needle))
      : all
    return hits.slice(0, limit)
  }

  private buildContacts(): Contact[] {
    // Eigene Adressen gehoeren nicht ins Adressbuch.
    const own = new Set(this.store.listAccounts().map((a) => a.email.toLowerCase()))
    const sentPaths = new Set<string>()
    for (const account of this.store.listAccounts()) {
      for (const folder of this.store.getFolders(account.id)) {
        if (folder.role === 'sent') sentPaths.add(`${account.id}|${folder.path}`)
      }
    }

    const byAddress = new Map<string, Contact>()
    const add = (raw: Address | undefined, at: number, written: boolean): void => {
      const address = raw?.address?.trim().toLowerCase()
      if (!address || !address.includes('@') || own.has(address)) return
      const existing = byAddress.get(address)
      if (!existing) {
        byAddress.set(address, { address, name: raw?.name?.trim() ?? '', count: 1, lastAt: at, written })
        return
      }
      existing.count++
      existing.written ||= written
      // Der juengste Name gewinnt - Leute benennen sich um.
      if (at > existing.lastAt) {
        existing.lastAt = at
        if (raw?.name?.trim()) existing.name = raw.name.trim()
      }
    }

    for (const message of this.store.allMessages()) {
      const written = sentPaths.has(`${message.accountId}|${message.folder}`)
      if (written) {
        for (const a of message.to) add(a, message.date, true)
        for (const a of message.cc) add(a, message.date, true)
      } else {
        for (const a of message.from) add(a, message.date, false)
      }
    }

    /*
      Reihenfolge: wem du selbst geschrieben hast, steht vorn - das ist der
      staerkste Hinweis darauf, dass du es wieder tun wirst. Danach zaehlt die
      Haeufigkeit, und bei Gleichstand entscheidet, wer zuletzt dran war.
    */
    return [...byAddress.values()].sort(
      (a, b) =>
        Number(b.written) - Number(a.written) || b.count - a.count || b.lastAt - a.lastAt
    )
  }

  // -------------------------------------------------------------- Senden

  private outboxPath(): string {
    return path.join(app.getPath('userData'), 'outbox.json')
  }

  private async loadOutbox(): Promise<void> {
    try {
      this.outbox = JSON.parse(await fsp.readFile(this.outboxPath(), 'utf8'))
    } catch {
      this.outbox = []
    }
    if (this.outbox.length) void this.flushOutbox()
  }

  private outboxView(): OutboxItem[] {
    return this.outbox.map(({ raw: _raw, draft, ...rest }) => ({ ...rest, editable: Boolean(draft) }))
  }

  private async persistOutbox(): Promise<void> {
    await fsp.writeFile(this.outboxPath(), JSON.stringify(this.outbox), 'utf8')
    this.emit('outbox:changed', this.outboxView())
  }

  getOutbox(): OutboxItem[] {
    return this.outboxView()
  }

  /**
   * Nimmt eine Nachricht zum Versand an. Drei Wege:
   *
   * Mit `sendAt` wartet sie im Ausgang auf ihren Termin. Ohne Termin wartet sie
   * dort die kurze Frist zum Zurueckholen ab (Einstellung `undoSendSec`). Steht
   * die Frist auf 0, geht sie sofort raus - dann meldet sich eine dauerhafte
   * Ablehnung (falsches Passwort, abgelehnter Empfaenger) noch im Dialog, und
   * nur ein Netzwerkfehler legt sie in die Warteschlange.
   */
  async send(msg: OutgoingMessage, opts: { sendAt?: number } = {}): Promise<SendResult> {
    const account = this.store.getAccount(msg.accountId)
    if (!account) throw new Error('Unbekanntes Konto.')
    const password = this.store.getPassword(account.id)
    if (!password) throw new Error('Kein Passwort fuer dieses Konto hinterlegt.')

    const recipients = [...msg.to, ...msg.cc, ...msg.bcc].map((a) => a.address)
    if (!recipients.length) throw new Error('Kein Empfaenger angegeben.')

    const now = Date.now()
    const entry: OutboxEntry = {
      id: randomUUID(),
      accountId: account.id,
      subject: msg.subject,
      recipients,
      draft: msg,
      queuedAt: now,
      attempts: 0
    }

    const scheduled = opts.sendAt !== undefined && opts.sendAt > now
    const undoMs = Math.max(0, this.store.getSettings().undoSendSec) * 1000
    if (scheduled || undoMs > 0) {
      entry.kind = scheduled ? 'scheduled' : 'undo'
      entry.sendAt = scheduled ? opts.sendAt : now + undoMs
      this.outbox.push(entry)
      await this.persistOutbox()
      this.armOutboxTimer()
      return { queued: false, outboxId: entry.id, sendAt: entry.sendAt, undoable: !scheduled, scheduled }
    }

    try {
      await this.deliver(account, password, entry)
      return { queued: false }
    } catch (err) {
      if (isPermanentSmtpError(err)) throw new Error(describeSmtpError(err))
      entry.kind = 'retry'
      entry.attempts = 1
      entry.lastError = describeSmtpError(err)
      this.outbox.push(entry)
      await this.persistOutbox()
      return { queued: true, outboxId: entry.id }
    }
  }

  /** Baut die Nachricht, falls noetig, und gibt sie an den Server. */
  private async deliver(account: Account, password: string, entry: OutboxEntry): Promise<void> {
    let raw: Buffer
    if (entry.raw) raw = Buffer.from(entry.raw, 'base64')
    else if (entry.draft) raw = (await buildRawMessage(account, entry.draft)).raw
    else throw new Error('Der Eintrag im Ausgang ist leer.')
    await sendRaw(account, password, raw, entry.recipients)
    await this.connections.get(account.id)?.appendToSent(raw).catch(() => {})
  }

  private armOutboxTimer(): void {
    if (this.outboxDueTimer) clearTimeout(this.outboxDueTimer)
    this.outboxDueTimer = null
    const now = Date.now()
    let next = Infinity
    for (const entry of this.outbox) {
      if (!entry.failed && entry.sendAt !== undefined && entry.sendAt > now && entry.sendAt < next) next = entry.sendAt
    }
    if (next === Infinity) return
    this.outboxDueTimer = setTimeout(() => void this.flushOutbox(), Math.min(next - now, MAX_TIMER_MS))
  }

  /** Versendet alles, was faellig ist. Wartendes und endgueltig Abgelehntes bleibt liegen. */
  private async flushOutbox(): Promise<void> {
    if (this.flushing || !this.outbox.length) return
    this.flushing = true
    try {
      const now = Date.now()
      const due = this.outbox.filter((e) => !e.failed && (e.sendAt ?? 0) <= now)
      for (const entry of due) {
        // Waehrend des Durchlaufs zurueckgeholt oder verworfen.
        if (!this.outbox.includes(entry)) continue
        const account = this.store.getAccount(entry.accountId)
        const password = account ? this.store.getPassword(account.id) : undefined
        if (!account || !password) {
          this.outbox = this.outbox.filter((e) => e !== entry)
          continue
        }

        this.inFlight.add(entry.id)
        try {
          await this.deliver(account, password, entry)
          this.outbox = this.outbox.filter((e) => e !== entry)
        } catch (err) {
          entry.lastError = describeSmtpError(err)
          if (isPermanentSmtpError(err)) {
            // Erneut versuchen aendert nichts - die Nachricht bleibt zum Bearbeiten liegen.
            entry.failed = true
            this.emit('mail:sendFailed', { subject: entry.subject, error: entry.lastError })
          } else {
            entry.attempts++
            entry.kind = 'retry'
            delete entry.sendAt
            // Nach 20 Versuchen liegt es nicht mehr am Netz.
            if (entry.attempts >= 20) this.outbox = this.outbox.filter((e) => e !== entry)
          }
        } finally {
          this.inFlight.delete(entry.id)
        }
      }
      if (due.length) await this.persistOutbox()
    } finally {
      this.flushing = false
      this.armOutboxTimer()
    }
  }

  async discardOutboxEntry(id: string): Promise<void> {
    await this.takeOutboxEntry(id)
  }

  /**
   * Holt eine wartende Nachricht aus dem Ausgang zurueck und liefert sie zum
   * Weiterbearbeiten. null heisst: zu spaet, sie ist schon unterwegs oder raus.
   */
  async takeOutboxEntry(id: string): Promise<OutgoingMessage | null> {
    if (this.inFlight.has(id)) return null
    const entry = this.outbox.find((e) => e.id === id)
    if (!entry) return null
    this.outbox = this.outbox.filter((e) => e !== entry)
    await this.persistOutbox()
    this.armOutboxTimer()
    return entry.draft ?? null
  }

  /** Sendet einen wartenden oder abgelehnten Eintrag sofort (erneut). */
  async sendOutboxEntryNow(id: string): Promise<void> {
    const entry = this.outbox.find((e) => e.id === id)
    if (!entry || this.inFlight.has(id)) return
    delete entry.sendAt
    delete entry.failed
    await this.persistOutbox()
    await this.flushOutbox()
  }
}

/**
 * Uebersetzt eine Sucheingabe in eine IMAP-Suche. Der Server grenzt nur vor -
 * er sucht mit Teilstrings und kennt keine Anhaenge -, genau gefiltert wird
 * hinterher lokal. null heisst: nichts, wonach der Server suchen koennte.
 */
function toServerSearch(parsed: ParsedSearch): SearchObject | null {
  const query: SearchObject = {}
  if (parsed.from[0]) query.from = parsed.from[0]
  if (parsed.to[0]) query.to = parsed.to[0]
  if (parsed.subject[0]) query.subject = parsed.subject[0]
  if (parsed.before !== undefined) query.before = new Date(parsed.before)
  if (parsed.after !== undefined) query.since = new Date(parsed.after)
  if (parsed.unread !== undefined) query.seen = !parsed.unread
  if (parsed.flagged) query.flagged = true
  const text = parsed.terms.join(' ')
  if (text.length >= 3) query.or = [{ subject: text }, { from: text }, { body: text }]
  return Object.keys(query).length ? query : null
}

/**
 * Netzwerkprobleme sind voruebergehend, 5xx-Ablehnungen des Servers nicht.
 * Nur Erstere landen in der Warteschlange.
 */
function isPermanentSmtpError(err: unknown): boolean {
  const responseCode = (err as { responseCode?: number }).responseCode
  if (typeof responseCode === 'number') return responseCode >= 500
  const code = (err as { code?: string }).code
  return code === 'EAUTH' || code === 'EENVELOPE'
}
