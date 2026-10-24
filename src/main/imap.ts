import { nativeImage } from 'electron'
import { ImapFlow, type ListResponse, type MailboxLockObject, type SearchObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import type {
  Account,
  Address,
  Attachment,
  Folder,
  FolderRole,
  MailRule,
  MessageBody,
  MessageSummary,
  RuleCondition,
  SyncPhase
} from '@shared/types'
import { messageKey } from '@shared/types'
import { activeConditions } from '@shared/rules'
import type { Store } from './store'

/** Wie viele Umschlaege pro FETCH-Runde geholt werden. */
const ENVELOPE_BATCH = 200
/** So viele der neuesten Mails werden nach dem Sync im Hintergrund vorgeladen. */
const BODY_PREFETCH = 25
/** So viele Kandidaten holt "Regel jetzt anwenden" hoechstens vom Server. */
const RULE_CANDIDATE_LIMIT = 2000
/** Obergrenze fuer Inline-Bilder, die als data:-URL in den Body wandern. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024
/** Laengste Kante eines Vorschaubildes in Pixeln. */
const THUMB_EDGE = 220
/** Groesser dekodieren wir nicht - eine Vorschau ist das nicht wert. */
const MAX_THUMB_SOURCE_BYTES = 24 * 1024 * 1024
/** Formate ohne Decoder werden unveraendert durchgereicht, wenn sie klein sind. */
const MAX_RAW_THUMB_BYTES = 512 * 1024

export interface ConnectionEvents {
  onStatus(accountId: string, phase: SyncPhase, message?: string): void
  onFolders(accountId: string): void
  onMessages(accountId: string, folder: string): void
  /**
   * Post, die seit dem letzten Abgleich im Posteingang aufgetaucht ist - gelesen
   * oder nicht. Regeln wollen alles sehen; benachrichtigt wird nur, wenn
   * `notify` gesetzt ist (siehe announce).
   */
  onArrived(accountId: string, folder: string, messages: MessageSummary[], opts: { notify: boolean }): void
}

/**
 * Haelt genau eine IMAP-Verbindung pro Konto offen. ImapFlow geht von selbst in
 * IDLE, sobald kein Mailbox-Lock gehalten wird, deshalb laufen alle Operationen
 * ueber `withMailbox()` - das uebernimmt Sperre und Freigabe.
 */
export class AccountConnection {
  private client: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null
  private closed = false
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  /** Verhindert, dass zwei Sync-Laeufe fuer dasselbe Konto ineinander greifen. */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * Ordner, die schon einmal abgeglichen wurden. Der erste Lauf faengt das
   * ganze Postfach ein - dafuer will niemand vierhundert Hinweise sehen.
   */
  private primed = new Set<string>()
  /**
   * Flags, die lokal schon gesetzt sind, beim Server aber noch in der
   * Warteschlange stehen: `ordner|uid` -> Flag -> gesetzt. Ein Abgleich, der
   * davor gestartet ist, kennt noch den alten Stand und darf ihn nicht
   * zurueckschreiben - sonst springt eine gerade gelesene Mail wieder auf
   * ungelesen.
   */
  private pendingFlags = new Map<string, Map<string, boolean>>()

  phase: SyncPhase = 'idle'
  lastError?: string
  lastSyncAt?: number

  constructor(
    public account: Account,
    private password: string,
    private store: Store,
    private events: ConnectionEvents
  ) {}

  // ---------------------------------------------------------- Verbindung

  private setPhase(phase: SyncPhase, message?: string): void {
    this.phase = phase
    this.lastError = phase === 'error' ? message : undefined
    this.events.onStatus(this.account.id, phase, message)
  }

  private async getClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    if (this.connecting) return this.connecting

    this.setPhase('connecting')
    this.connecting = (async () => {
      const client = new ImapFlow({
        host: this.account.imap.host,
        port: this.account.imap.port,
        secure: this.account.imap.secure,
        auth: { user: this.account.username, pass: this.password },
        logger: false,
        emitLogs: false,
        // Manche Provider (WEB.DE, GMX) moegen einen sprechenden Client-Namen.
        clientInfo: { name: 'Mailclient', version: '0.1.0' }
      })

      client.on('error', (err: Error) => {
        // ImapFlow wirft hier auch nach normalen Verbindungsabbruechen.
        if (this.closed) return
        console.error(`[imap ${this.account.email}]`, err.message)
      })
      client.on('close', () => {
        if (this.closed) return
        this.client = null
        this.setPhase('offline', 'Verbindung getrennt')
        this.scheduleReconnect()
      })
      // IDLE meldet Aenderungen. Der Pfad kommt aus dem Ereignis - offen ist
      // nicht zwingend der Posteingang.
      const onMailboxEvent = (event: { path?: string }): void => {
        const path = event?.path ?? this.inboxPath()
        this.enqueue(() => this.syncFolder(path, { quick: true })).catch(() => {})
      }
      client.on('exists', onMailboxEvent)
      client.on('flags', onMailboxEvent)
      client.on('expunge', onMailboxEvent)

      await client.connect()
      this.client = client
      this.reconnectAttempt = 0
      this.setPhase('idle')
      return client
    })()

    try {
      return await this.connecting
    } catch (err) {
      this.client = null
      this.setPhase('error', describeError(err))
      this.scheduleReconnect()
      throw err
    } finally {
      this.connecting = null
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    // 5s, 10s, 20s, ... maximal 5 Minuten
    const delay = Math.min(5000 * 2 ** this.reconnectAttempt, 300_000)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.enqueue(() => this.syncAll()).catch(() => {})
    }, delay)
  }

  /** Serialisiert alle IMAP-Operationen eines Kontos. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    // Fehler duerfen die Kette nicht abreissen lassen.
    this.queue = next.catch(() => {})
    return next
  }

  private async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.getClient()
    let lock: MailboxLockObject | undefined
    try {
      lock = await client.getMailboxLock(path)
      return await fn(client)
    } finally {
      lock?.release()
    }
  }

  async start(): Promise<void> {
    await this.enqueue(() => this.syncAll())
    this.startPolling()
  }

  /** Nach einer Aenderung des Intervalls neu aufsetzen. */
  restartPolling(): void {
    if (!this.closed) this.startPolling()
  }

  private startPolling(): void {
    this.stopPolling()
    const seconds = this.store.getSettings().syncIntervalSec
    this.pollTimer = setInterval(
      () => void this.enqueue(() => this.syncAll()).catch(() => {}),
      Math.max(60, seconds) * 1000
    )
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopPolling()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      await this.client?.logout()
    } catch {
      this.client?.close()
    }
    this.client = null
  }

  /** Von aussen anstossbar (Button "Jetzt abrufen"). */
  refresh(folder?: string): Promise<void> {
    return this.enqueue(() => (folder ? this.syncFolder(folder, {}) : this.syncAll()))
  }

  // ------------------------------------------------------------- Ordner

  private inboxPath(): string {
    return this.store.getFolders(this.account.id).find((f) => f.role === 'inbox')?.path ?? 'INBOX'
  }

  folderByRole(role: FolderRole): Folder | undefined {
    return this.store.getFolders(this.account.id).find((f) => f.role === role)
  }

  private async syncFolderList(client: ImapFlow): Promise<Folder[]> {
    const raw = await client.list()
    const folders: Folder[] = raw
      .filter((box) => !box.flags.has('\\NonExistent'))
      .map((box) => {
        const delimiter = box.delimiter || '/'
        const segments = box.path.split(delimiter)
        return {
          accountId: this.account.id,
          path: box.path,
          name: segments[segments.length - 1] || box.path,
          delimiter,
          depth: segments.length - 1,
          role: detectRole(box),
          selectable: !box.flags.has('\\Noselect'),
          unread: 0,
          total: 0,
          hidden: isVirtualFolder(box) || undefined
        }
      })

    folders.sort(folderSort)
    // Was bisher als normaler Ordner abgeglichen wurde, raeumt der Cache einmal ab.
    const before = new Map(this.store.getFolders(this.account.id).map((f) => [f.path, f]))
    for (const folder of folders) {
      if (folder.hidden && !before.get(folder.path)?.hidden) {
        await this.store.clearFolder(this.account.id, folder.path)
      }
    }
    await this.store.setFolders(this.account.id, folders)
    this.events.onFolders(this.account.id)
    return folders
  }

  // --------------------------------------------------------------- Sync

  private async syncAll(): Promise<void> {
    const client = await this.getClient()
    this.setPhase('syncing')
    try {
      const folders = await this.syncFolderList(client)
      // Wichtige Ordner zuerst, damit die UI schnell etwas anzeigt.
      const ordered = [...folders]
        .filter((f) => f.selectable && !f.hidden)
        .sort((a, b) => rolePriority(a.role) - rolePriority(b.role))

      for (const folder of ordered) {
        if (this.closed) return
        // Tief verschachtelte Nebenordner synchronisieren wir nur auf Anforderung.
        if (rolePriority(folder.role) > 90 && folder.depth > 1) continue
        await this.syncFolder(folder.path, {})
      }
      this.lastSyncAt = Date.now()
      this.setPhase('idle')
    } catch (err) {
      this.setPhase('error', describeError(err))
      throw err
    }
  }

  /**
   * Meldet neue Post aus dem Posteingang. Zwei Stufen:
   *
   * Beim allerersten Abgleich eines Ordners (leerer Cache) kommt der gesamte
   * Bestand - der ist nicht "neu", nur "neu hier", und wird gar nicht gemeldet.
   * Sonst ist alles Gemeldete wirklich neu, auch das, was kam, waehrend die App
   * zu war; darauf muessen Regeln greifen. Benachrichtigt wird davon aber erst
   * ab dem zweiten Abgleich nach dem Start, damit der Morgen nicht mit einer
   * Flut von Meldungen beginnt.
   */
  private announce(folderPath: string, arrived: MessageSummary[], backlog: boolean): void {
    const primed = this.primed.has(folderPath)
    this.primed.add(folderPath)
    if (backlog || !arrived.length) return
    if (this.folderByPath(folderPath)?.role !== 'inbox') return
    this.events.onArrived(this.account.id, folderPath, arrived, { notify: primed })
  }

  private folderByPath(folderPath: string): Folder | undefined {
    return this.store.getFolders(this.account.id).find((f) => f.path === folderPath)
  }

  /**
   * Gleicht einen Ordner mit dem Server ab.
   *
   * Betrachtet wird ein Fenster der neuesten `initialFetchCount` Nachrichten:
   * fuer dieses Fenster werden UIDs und Flags geholt (ein Rundlauf), daraus
   * ergeben sich neue, geaenderte und geloeschte Nachrichten. Nur fuer wirklich
   * neue UIDs werden dann die teureren Umschlaege nachgeladen.
   */
  private async syncFolder(folderPath: string, opts: { quick?: boolean }): Promise<void> {
    if (this.closed) return
    const accountId = this.account.id
    const limit = this.store.getSettings().initialFetchCount

    await this.withMailbox(folderPath, async (client) => {
      const mailbox = client.mailbox
      if (!mailbox) return

      const uidValidity = String(mailbox.uidValidity)
      const state = this.store.getFolderState(accountId, folderPath)
      // Ohne gueltigen Stand ist alles, was jetzt kommt, Bestand und nicht neu.
      const backlog = !state || state.uidValidity !== uidValidity
      if (state && state.uidValidity !== uidValidity) {
        // Der Server hat die UIDs neu vergeben - der lokale Cache ist wertlos.
        await this.store.clearFolder(accountId, folderPath)
      }

      if (mailbox.exists === 0) {
        await this.store.clearFolder(accountId, folderPath)
        this.store.updateFolderCounts(accountId, folderPath)
        await this.store.setFolderState(accountId, folderPath, { uidValidity, lastSyncAt: Date.now() })
        this.events.onMessages(accountId, folderPath)
        return
      }

      const windowSize = opts.quick ? Math.min(limit, 100) : limit
      const start = Math.max(1, mailbox.exists - windowSize + 1)

      const serverFlags = new Map<number, string[]>()
      for await (const msg of client.fetch(`${start}:*`, { uid: true, flags: true })) {
        serverFlags.set(msg.uid, [...(msg.flags ?? [])])
      }
      if (serverFlags.size === 0) return

      const known = new Set(this.store.knownUids(accountId, folderPath))
      const windowMinUid = Math.min(...serverFlags.keys())

      // 1. Verschwundene Nachrichten innerhalb des Fensters entfernen
      const vanished = [...known].filter((uid) => uid >= windowMinUid && !serverFlags.has(uid))
      if (vanished.length) this.store.removeMessages(accountId, folderPath, vanished)

      // 2. Flags bestehender Nachrichten aktualisieren
      for (const [uid, fromServer] of serverFlags) {
        if (!known.has(uid)) continue
        const flags = this.withPendingFlags(folderPath, uid, fromServer)
        const current = this.store.getMessage(accountId, folderPath, uid)
        if (current && !sameFlags(current.flags, flags)) {
          this.store.setFlags(accountId, folderPath, uid, flags)
        }
      }

      // 3. Umschlaege fuer neue UIDs holen
      const fresh = [...serverFlags.keys()].filter((uid) => !known.has(uid)).sort((a, b) => a - b)
      const arrived: MessageSummary[] = []
      for (let i = 0; i < fresh.length; i += ENVELOPE_BATCH) {
        const batch = fresh.slice(i, i + ENVELOPE_BATCH)
        const summaries: MessageSummary[] = []
        for await (const msg of client.fetch(
          batch.join(','),
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            size: true,
            internalDate: true,
            headers: ['references']
          },
          { uid: true }
        )) {
          summaries.push(toSummary(accountId, folderPath, msg))
        }
        this.store.putMessages(accountId, folderPath, summaries)
        arrived.push(...summaries)
        this.events.onMessages(accountId, folderPath)
      }

      this.announce(folderPath, arrived, backlog)
      this.store.updateFolderCounts(accountId, folderPath)
      await this.store.setFolderState(accountId, folderPath, {
        uidValidity,
        highestModseq: mailbox.highestModseq ? String(mailbox.highestModseq) : undefined,
        lastSyncAt: Date.now()
      })
      this.events.onFolders(accountId)
      this.events.onMessages(accountId, folderPath)
    })

    if (!opts.quick) await this.prefetchBodies(folderPath)
  }

  /**
   * Laedt die neuesten Nachrichten im Hintergrund. Das fuellt die Textvorschau
   * in der Liste und macht das Oeffnen einer Mail verzoegerungsfrei.
   */
  private async prefetchBodies(folderPath: string): Promise<void> {
    const accountId = this.account.id
    const recent = this.store.getMessages(accountId, folderPath).slice(0, BODY_PREFETCH)
    let changed = false
    for (const msg of recent) {
      if (this.closed) break
      if (msg.snippet) continue
      const cached = await this.store.getBody(accountId, folderPath, msg.uid)
      if (cached) continue
      try {
        await this.fetchBody(folderPath, msg.uid)
        changed = true
      } catch {
        // Einzelne Mail nicht ladbar - kein Grund, den Rest abzubrechen.
      }
    }
    if (changed) this.events.onMessages(accountId, folderPath)
  }

  // ------------------------------------------------------------- Bodies

  async getBody(folderPath: string, uid: number): Promise<MessageBody | null> {
    const cached = await this.store.getBody(this.account.id, folderPath, uid)
    if (cached) {
      // Aeltere Cache-Eintraege kennen noch keine Vorschaubilder. Nur Mails mit
      // Anhaengen lohnen den zweiten Abruf - und scheitert er, bleibt der
      // vorhandene Text stehen, statt dass gar nichts angezeigt wird.
      if (cached.previews || cached.attachments.length === 0) return cached
      const refreshed = await this.enqueue(() => this.fetchBody(folderPath, uid)).catch(() => null)
      return refreshed ?? cached
    }
    return this.enqueue(() => this.fetchBody(folderPath, uid))
  }

  private async fetchBody(folderPath: string, uid: number): Promise<MessageBody | null> {
    const accountId = this.account.id
    const parsed = await this.withMailbox(folderPath, async (client) => {
      const dl = await client.download(String(uid), undefined, { uid: true })
      if (!dl?.content) return null
      return simpleParser(dl.content)
    })
    if (!parsed) return null

    const body = buildBody(messageKey(accountId, folderPath, uid), parsed)
    await this.store.putBody(accountId, folderPath, uid, body)

    // Die Textvorschau in der Liste entsteht erst hier, weil ein IMAP-Umschlag
    // keinen Nachrichtentext enthaelt.
    const summary = this.store.getMessage(accountId, folderPath, uid)
    if (summary && !summary.snippet) {
      summary.snippet = makeSnippet(parsed)
      this.store.putMessages(accountId, folderPath, [summary])
    }
    return body
  }

  /** Holt genau einen Anhang als Buffer - erst beim Klick auf "Speichern". */
  async getAttachment(folderPath: string, uid: number, partId: string): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
    return this.enqueue(async () =>
      this.withMailbox(folderPath, async (client) => {
        const dl = await client.download(String(uid), undefined, { uid: true })
        if (!dl?.content) return null
        const parsed = await simpleParser(dl.content)
        const index = Number(partId)
        const att = parsed.attachments[index]
        if (!att) return null
        return {
          filename: att.filename || `anhang-${index + 1}`,
          contentType: att.contentType || 'application/octet-stream',
          data: att.content as Buffer
        }
      })
    )
  }

  // ---------------------------------------------------------- Aktionen

  async setSeen(folderPath: string, uids: number[], seen: boolean): Promise<void> {
    await this.changeFlag(folderPath, uids, '\\Seen', seen)
  }

  async setFlagged(folderPath: string, uids: number[], flagged: boolean): Promise<void> {
    await this.changeFlag(folderPath, uids, '\\Flagged', flagged)
  }

  /**
   * Setzt ein Flag sofort lokal und erst danach beim Server. Der Server steht
   * hinten in der Warteschlange des Kontos - laeuft dort gerade ein langer
   * Abgleich, kaeme "gelesen" sonst erst nach Sekunden in der Liste an.
   * Scheitert der Server, korrigiert der naechste Abgleich den lokalen Stand.
   */
  private async changeFlag(folderPath: string, uids: number[], flag: string, on: boolean): Promise<void> {
    const accountId = this.account.id
    for (const uid of uids) {
      const key = `${folderPath}|${uid}`
      const pending = this.pendingFlags.get(key) ?? new Map<string, boolean>()
      pending.set(flag, on)
      this.pendingFlags.set(key, pending)
      const msg = this.store.getMessage(accountId, folderPath, uid)
      if (!msg) continue
      const flags = new Set(msg.flags)
      if (on) flags.add(flag)
      else flags.delete(flag)
      this.store.setFlags(accountId, folderPath, uid, [...flags])
    }
    this.store.updateFolderCounts(accountId, folderPath)
    this.events.onMessages(accountId, folderPath)
    this.events.onFolders(accountId)

    try {
      await this.enqueue(() =>
        this.withMailbox(folderPath, async (client) => {
          const range = uids.join(',')
          if (on) await client.messageFlagsAdd(range, [flag], { uid: true })
          else await client.messageFlagsRemove(range, [flag], { uid: true })
        })
      )
    } finally {
      for (const uid of uids) {
        const key = `${folderPath}|${uid}`
        const pending = this.pendingFlags.get(key)
        // Nur austragen, was diese Aenderung eingetragen hat - eine spaetere
        // Gegenaenderung (gelesen, dann gleich wieder ungelesen) bleibt stehen.
        if (pending?.get(flag) === on) pending.delete(flag)
        if (pending && !pending.size) this.pendingFlags.delete(key)
      }
    }
  }

  /** Server-Flags mit dem, was lokal schon geaendert, beim Server aber noch nicht angekommen ist. */
  private withPendingFlags(folderPath: string, uid: number, fromServer: string[]): string[] {
    const pending = this.pendingFlags.get(`${folderPath}|${uid}`)
    if (!pending) return fromServer
    const flags = new Set(fromServer)
    for (const [flag, on] of pending) {
      if (on) flags.add(flag)
      else flags.delete(flag)
    }
    return [...flags]
  }

  /**
   * Markiert alles Ungelesene eines Ordners auf dem Server als gelesen - nicht
   * nur die lokal bekannten Nachrichten. Der Server bekommt ein einziges STORE
   * mit dem Suchkriterium "ungelesen", statt tausend einzelne UIDs.
   */
  async markFolderRead(folderPath: string): Promise<void> {
    await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const mailbox = client.mailbox
        if (!mailbox || mailbox.exists === 0) return
        await client.messageFlagsAdd({ seen: false }, ['\\Seen'])

        for (const uid of this.store.knownUids(this.account.id, folderPath)) {
          const msg = this.store.getMessage(this.account.id, folderPath, uid)
          if (!msg || msg.flags.includes('\\Seen')) continue
          this.store.setFlags(this.account.id, folderPath, uid, [...msg.flags, '\\Seen'])
        }
        this.store.updateFolderCounts(this.account.id, folderPath)
      })
    )
    this.events.onMessages(this.account.id, folderPath)
    this.events.onFolders(this.account.id)
  }

  /** Loescht den Inhalt eines Ordners endgueltig - fuer "Papierkorb leeren". */
  async emptyFolder(folderPath: string): Promise<void> {
    await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const mailbox = client.mailbox
        if (!mailbox || mailbox.exists === 0) return
        await client.messageDelete({ all: true })
        await this.store.clearFolder(this.account.id, folderPath)
        this.store.updateFolderCounts(this.account.id, folderPath)
      })
    )
    this.events.onMessages(this.account.id, folderPath)
    this.events.onFolders(this.account.id)
  }

  async move(folderPath: string, uids: number[], targetPath: string): Promise<void> {
    await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        await client.messageMove(uids.join(','), targetPath, { uid: true })
        this.store.removeMessages(this.account.id, folderPath, uids)
        this.store.updateFolderCounts(this.account.id, folderPath)
      })
    )
    this.events.onMessages(this.account.id, folderPath)
    this.events.onFolders(this.account.id)
    // In eine reine Sicht (Gmail: archivieren nach "Alle Nachrichten") wird nicht nachgeladen.
    if (!this.folderByPath(targetPath)?.hidden) await this.refresh(targetPath)
  }

  /**
   * Loeschen heisst: ab in den Papierkorb. Liegt die Mail schon dort (oder gibt
   * es keinen Papierkorb), wird sie endgueltig entfernt.
   */
  async remove(folderPath: string, uids: number[]): Promise<void> {
    const trash = this.folderByRole('trash')
    if (trash && trash.path !== folderPath) {
      await this.move(folderPath, uids, trash.path)
      return
    }
    await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        await client.messageDelete(uids.join(','), { uid: true })
        this.store.removeMessages(this.account.id, folderPath, uids)
        this.store.updateFolderCounts(this.account.id, folderPath)
      })
    )
    this.events.onMessages(this.account.id, folderPath)
    this.events.onFolders(this.account.id)
  }

  /** Legt eine gesendete Nachricht im Sent-Ordner ab. */
  async appendToSent(raw: Buffer): Promise<void> {
    const sent = this.folderByRole('sent')
    if (!sent) return
    await this.enqueue(async () => {
      const client = await this.getClient()
      await client.append(sent.path, raw, ['\\Seen'], new Date())
    })
    await this.refresh(sent.path)
  }

  /** Serverseitige Suche - findet auch, was lokal nicht im Cache liegt. */
  async searchServer(folderPath: string, query: SearchObject): Promise<number[]> {
    return this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const uids = await client.search(query, { uid: true })
        return uids ? uids.slice(-200) : []
      })
    )
  }

  /**
   * Sucht Teile einer Unterhaltung, die lokal fehlen: Mails mit einer der
   * gesuchten Message-IDs und Mails, die sich auf eine bekannte beziehen.
   * Liefert die Zahl der neu geholten Nachrichten.
   */
  async fetchThreadParts(folderPath: string, missingIds: string[], knownIds: string[]): Promise<number> {
    const header = (name: string, id: string): SearchObject => ({ header: { [name]: `<${id}>` } })
    const criteria: SearchObject[] = [
      ...missingIds.map((id) => header('message-id', id)),
      ...knownIds.flatMap((id) => [header('references', id), header('in-reply-to', id)])
    ]
    if (!criteria.length) return 0
    const query: SearchObject = criteria.length === 1 ? criteria[0] : { or: criteria }
    const uids = await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const found = await client.search(query, { uid: true })
        return found ? found.slice(-100) : []
      })
    )
    const before = this.store.knownUids(this.account.id, folderPath).length
    await this.hydrate(folderPath, uids)
    return this.store.knownUids(this.account.id, folderPath).length - before
  }

  /**
   * Liefert den Pfad eines Ordners und legt ihn an, wenn es ihn noch nicht
   * gibt. Ebenen kommen mit "/" getrennt und werden in das Trennzeichen des
   * Servers uebersetzt; ein vorhandener Ordner wird ohne Ruecksicht auf Gross-
   * und Kleinschreibung wiedergefunden.
   */
  async ensureFolder(name: string): Promise<string> {
    const segments = name.split('/').map((s) => s.trim()).filter(Boolean)
    if (!segments.length) throw new Error('Kein Zielordner angegeben.')
    const find = (): Folder | undefined => {
      const folders = this.store.getFolders(this.account.id)
      const wanted = segments.join(folders[0]?.delimiter ?? '/').toLowerCase()
      return folders.find((f) => f.path.toLowerCase() === wanted)
    }
    const existing = find()
    if (existing) return existing.path

    return this.enqueue(async () => {
      const client = await this.getClient()
      try {
        const created = await client.mailboxCreate(segments)
        await this.syncFolderList(client)
        return created.path
      } catch (err) {
        // War die lokale Liste veraltet, gibt es den Ordner womoeglich schon.
        await this.syncFolderList(client)
        const found = find()
        if (found) return found.path
        throw err
      }
    })
  }

  /**
   * Fragt den Server nach Nachrichten, die eine Regel treffen koennten. Das ist
   * nur eine Vorauswahl - der Server sucht mit Teilstrings, Gmail sogar
   * wortweise -, die genaue Pruefung macht hinterher matchesRule. Bei "alle
   * Bedingungen" genuegt deshalb die erste als Filter: sie ist eine Obermenge.
   */
  async searchRuleCandidates(folderPath: string, rule: MailRule): Promise<number[]> {
    const conditions = activeConditions(rule)
    if (!conditions.length) return []
    const criteria = (rule.match === 'all' ? conditions.slice(0, 1) : conditions).map(toSearch)
    const query: SearchObject = criteria.length === 1 ? criteria[0] : { or: criteria }
    return this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const uids = await client.search(query, { uid: true })
        return uids ? uids.slice(-RULE_CANDIDATE_LIMIT) : []
      })
    )
  }

  async hydrate(folderPath: string, uids: number[]): Promise<void> {
    const missing = uids.filter((uid) => !this.store.getMessage(this.account.id, folderPath, uid))
    if (!missing.length) return
    await this.enqueue(() =>
      this.withMailbox(folderPath, async (client) => {
        const summaries: MessageSummary[] = []
        for await (const msg of client.fetch(
          missing.join(','),
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            size: true,
            internalDate: true,
            headers: ['references']
          },
          { uid: true }
        )) {
          summaries.push(toSummary(this.account.id, folderPath, msg))
        }
        this.store.putMessages(this.account.id, folderPath, summaries)
      })
    )
    this.events.onMessages(this.account.id, folderPath)
  }
}

// -------------------------------------------------------------- Umwandlung

type FetchedMessage = {
  uid: number
  flags?: Set<string>
  size?: number
  internalDate?: Date | string
  envelope?: {
    date?: Date | string
    subject?: string
    messageId?: string
    inReplyTo?: string
    from?: { name?: string; address?: string }[]
    to?: { name?: string; address?: string }[]
    cc?: { name?: string; address?: string }[]
    replyTo?: { name?: string; address?: string }[]
  }
  bodyStructure?: BodyNode
  headers?: Buffer
}

interface BodyNode {
  type?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  childNodes?: BodyNode[]
}

function toSummary(accountId: string, folder: string, msg: FetchedMessage): MessageSummary {
  const env = msg.envelope ?? {}
  const date = toDate(env.date) ?? toDate(msg.internalDate) ?? new Date()
  return {
    id: messageKey(accountId, folder, msg.uid),
    accountId,
    folder,
    uid: msg.uid,
    messageId: env.messageId,
    inReplyTo: env.inReplyTo,
    references: parseReferences(msg.headers),
    subject: env.subject?.trim() || '(kein Betreff)',
    from: mapAddresses(env.from),
    to: mapAddresses(env.to),
    cc: mapAddresses(env.cc),
    replyTo: mapAddresses(env.replyTo),
    date: date.getTime(),
    snippet: '',
    flags: [...(msg.flags ?? [])],
    hasAttachments: hasRealAttachment(msg.bodyStructure),
    size: msg.size ?? 0,
    attachmentNames: attachmentNames(msg.bodyStructure)
  }
}

function toDate(value?: Date | string): Date | undefined {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function mapAddresses(list?: { name?: string; address?: string }[]): Address[] {
  if (!list) return []
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name?.trim() || undefined, address: a.address as string }))
}

function parseReferences(headers?: Buffer): string[] | undefined {
  if (!headers) return undefined
  const text = headers.toString('utf8')
  const match = /^references:\s*([\s\S]*?)(?:\r?\n(?![ \t])|$)/im.exec(text)
  if (!match) return undefined
  const ids = match[1].match(/<[^>]+>/g)
  return ids?.map((id) => id.slice(1, -1))
}

/**
 * Ein Anhang zaehlt nur, wenn er auch einer ist: Inline-Bilder aus HTML-Mails
 * sollen die Bueroklammer in der Liste nicht ausloesen.
 */
function hasRealAttachment(node?: BodyNode): boolean {
  if (!node) return false
  const disposition = node.disposition?.toLowerCase()
  if (disposition === 'attachment') return true
  if (disposition === 'inline' && node.dispositionParameters?.filename) return true
  return (node.childNodes ?? []).some(hasRealAttachment)
}

/** Dateinamen der echten Anhaenge, in der Reihenfolge der Mail. */
function attachmentNames(node?: BodyNode, out: string[] = []): string[] {
  if (!node) return out
  const disposition = node.disposition?.toLowerCase()
  const name = node.dispositionParameters?.filename ?? node.parameters?.name
  if (name && (disposition === 'attachment' || (disposition === 'inline' && node.dispositionParameters?.filename))) {
    out.push(name)
  }
  for (const child of node.childNodes ?? []) attachmentNames(child, out)
  return out
}

/** Uebersetzt eine Regelbedingung in eine Serversuche, die sie mindestens abdeckt. */
function toSearch(condition: RuleCondition): SearchObject {
  const value = condition.value.trim().replace(/^@/, '')
  if (condition.field === 'subject') return { subject: value }
  if (condition.field === 'from') return { from: value }
  return { or: [{ to: value }, { cc: value }] }
}

function buildBody(id: string, parsed: ParsedMail): MessageBody {
  const attachments: Attachment[] = []
  const inlineImages: Record<string, string> = {}
  const previews: Record<string, string> = {}
  let inlineBytes = 0

  parsed.attachments.forEach((att, index) => {
    const cid = att.cid?.replace(/^<|>$/g, '')
    const isInlineImage =
      Boolean(cid) && (att.contentDisposition === 'inline' || att.related) && att.contentType?.startsWith('image/')

    if (isInlineImage && cid) {
      const size = att.size ?? (att.content as Buffer)?.length ?? 0
      if (inlineBytes + size <= MAX_INLINE_BYTES) {
        inlineBytes += size
        inlineImages[cid] = `data:${att.contentType};base64,${(att.content as Buffer).toString('base64')}`
      }
      return
    }

    const partId = String(index)
    const contentType = att.contentType || 'application/octet-stream'
    attachments.push({
      partId,
      filename: att.filename || `anhang-${index + 1}`,
      contentType,
      size: att.size ?? (att.content as Buffer)?.length ?? 0,
      cid,
      inline: att.contentDisposition === 'inline'
    })

    const thumb = makeThumbnail(contentType, att.content as Buffer)
    if (thumb) previews[partId] = thumb
  })

  return {
    id,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    text: parsed.text ?? null,
    attachments,
    inlineImages,
    previews
  }
}

/**
 * Verkleinert einen Bildanhang auf Daumennagelgroesse. Nur PNG und JPEG haben
 * einen Decoder in Electron; GIF, WebP und BMP gehen unveraendert mit, solange
 * sie klein sind. Alles andere - auch SVG - bekommt keine Vorschau.
 */
function makeThumbnail(contentType: string, data?: Buffer): string | null {
  if (!data?.length || !contentType.startsWith('image/')) return null
  if (data.length > MAX_THUMB_SOURCE_BYTES) return null

  const type = contentType.toLowerCase()
  if (type.startsWith('image/png') || type.startsWith('image/jpeg') || type.startsWith('image/jpg')) {
    try {
      const image = nativeImage.createFromBuffer(data)
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const longest = Math.max(width, height)
      if (longest <= 0) return null
      if (longest <= THUMB_EDGE) return image.toDataURL()
      const scale = THUMB_EDGE / longest
      return image
        .resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
        .toDataURL()
    } catch {
      return null
    }
  }

  if (/^image\/(gif|webp|bmp)/.test(type) && data.length <= MAX_RAW_THUMB_BYTES) {
    return `data:${contentType};base64,${data.toString('base64')}`
  }
  return null
}

function makeSnippet(parsed: ParsedMail): string {
  const source = parsed.text ?? stripTags(typeof parsed.html === 'string' ? parsed.html : '')
  return source.replace(/\s+/g, ' ').trim().slice(0, 220)
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// ---------------------------------------------------------------- Ordner

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all'
}

/** Gmail legt seine Sichten unter "[Gmail]" bzw. "[Google Mail]" ab, je nach Land. */
const GMAIL_VIEW = /^\[(gmail|google mail)\][/.](all mail|alle nachrichten|important|wichtig|starred|markiert|mit stern)$/i
const GMAIL_ALL = /^\[(gmail|google mail)\][/.](all mail|alle nachrichten)$/i

/**
 * Ordner, die nur zeigen, was anderswo liegt. Erkannt an den SPECIAL-USE-
 * Merkmalen; ohne sie nur an Gmails festen Pfaden - ein Ordner "Wichtig" bei
 * einem anderen Anbieter ist ein ganz gewoehnlicher Ordner.
 */
function isVirtualFolder(box: ListResponse): boolean {
  for (const flag of ['\\All', '\\Important', '\\Flagged']) {
    if (box.flags.has(flag) || box.specialUse === flag) return true
  }
  return GMAIL_VIEW.test(box.path)
}

/** Deutsche und englische Ordnernamen, falls der Server kein SPECIAL-USE liefert. */
const ROLE_BY_NAME: [RegExp, FolderRole][] = [
  [/^(inbox|posteingang)$/i, 'inbox'],
  [/^(sent|sent items|sent mail|gesendet|gesendete objekte|gesendete elemente)$/i, 'sent'],
  [/^(drafts|entw(u|ü)rfe)$/i, 'drafts'],
  [/^(trash|deleted items|papierkorb|gel(o|ö)schte objekte|gel(o|ö)schte elemente)$/i, 'trash'],
  [/^(junk|spam|junk e-mail|unerw(u|ü)nscht)$/i, 'junk'],
  [/^(archive|archiv)$/i, 'archive']
]

function detectRole(box: ListResponse): FolderRole {
  if (box.path.toUpperCase() === 'INBOX') return 'inbox'
  if (box.specialUse && ROLE_BY_SPECIAL_USE[box.specialUse]) return ROLE_BY_SPECIAL_USE[box.specialUse]
  if (box.flags.has('\\All') || GMAIL_ALL.test(box.path)) return 'all'
  const leaf = box.path.split(box.delimiter || '/').pop() ?? ''
  for (const [pattern, role] of ROLE_BY_NAME) {
    if (pattern.test(leaf)) return role
  }
  return 'other'
}

function rolePriority(role: FolderRole): number {
  switch (role) {
    case 'inbox':
      return 0
    case 'archive':
      return 10
    case 'sent':
      return 20
    case 'drafts':
      return 30
    case 'junk':
      return 40
    case 'trash':
      return 50
    default:
      return 100
  }
}

/** Systemordner zuerst, danach alles Weitere alphabetisch im Baum. */
function folderSort(a: Folder, b: Folder): number {
  const pa = rolePriority(a.role)
  const pb = rolePriority(b.role)
  if (pa !== pb) return pa - pb
  return a.path.localeCompare(b.path, 'de')
}

// ---------------------------------------------------------------- Fehler

/**
 * ImapFlow setzt `message` bei jeder abgelehnten Antwort auf "Command failed" -
 * der eigentliche Grund steht in `responseText`, `serverResponseCode` und
 * `authenticationFailed`. Ohne diese Felder auszuwerten, bekommt man nie zu
 * sehen, was der Server tatsaechlich gesagt hat.
 */
export function describeError(err: unknown): string {
  const e = (err ?? {}) as {
    message?: string
    code?: string
    responseText?: string
    responseStatus?: string
    serverResponseCode?: string
    authenticationFailed?: boolean
    response?: unknown
  }

  const serverText =
    (typeof e.response === 'string' ? e.response.trim() : undefined) || e.responseText?.trim()
  const quoted = serverText ? ` Der Server sagt: "${serverText}"` : ''

  if (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return `Der Server hat die Anmeldung abgelehnt.${quoted} ${APP_PASSWORD_HINT}`
  }
  if (e.serverResponseCode === 'AUTHORIZATIONFAILED') {
    return `Anmeldung akzeptiert, Zugriff auf das Postfach aber verweigert.${quoted}`
  }
  if (e.serverResponseCode === 'UNAVAILABLE' || e.serverResponseCode === 'OVERQUOTA') {
    return `Der Server weist die Verbindung gerade ab.${quoted} Spaeter erneut versuchen.`
  }

  const code = e.code
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(e.message ?? '')) {
    return 'Server nicht gefunden. Stimmt die Adresse des IMAP-Servers?'
  }
  if (code === 'ECONNREFUSED') {
    return 'Server verweigert die Verbindung. Port pruefen: 993 mit TLS, 143 mit STARTTLS.'
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(e.message ?? '')) {
    return 'Zeitueberschreitung. Keine Verbindung zum Server.'
  }
  if (/self.signed|certificate|CERT_/i.test(e.message ?? '')) {
    return `Zertifikatsproblem: ${e.message}`
  }
  if (code === 'ClosedAfterConnectTLS' || code === 'ClosedAfterConnect') {
    return 'Der Server hat die Verbindung sofort geschlossen. Meist stimmt die Kombination aus Port und Verschluesselung nicht.'
  }

  // Alles Uebrige: lieber den Wortlaut des Servers zeigen als "Command failed".
  if (serverText) {
    return e.responseStatus ? `${serverText} (${e.responseStatus})` : serverText
  }
  return e.message ?? String(err)
}

export const APP_PASSWORD_HINT =
  'Wichtig: Ein App-Passwort ist nicht dein normales Kontopasswort, sondern eine ' +
  'Zeichenfolge, die du beim Anbieter einmalig erzeugst und dann hier einfuegst. ' +
  'Bei Gmail, iCloud und Yahoo muss dafuer die Zwei-Faktor-Anmeldung aktiv sein. ' +
  'Bei WEB.DE und GMX genuegt das Postfach-Passwort, aber IMAP muss im Webinterface ' +
  'unter POP3/IMAP Abruf erst freigeschaltet werden.'

function sameFlags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((f) => set.has(f))
}
