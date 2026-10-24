import { app, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  Account,
  AccountId,
  Folder,
  MessageBody,
  MessageSummary,
  Settings
} from '@shared/types'

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  syncIntervalSec: 300,
  initialFetchCount: 400,
  loadRemoteImages: false,
  remoteImageDomains: [],
  density: 'comfortable',
  previewPosition: 'right',
  markReadAfterMs: 0,
  readerZoom: 1,
  rules: [],
  runInTray: true,
  startWithSystem: true,
  notifyOnNewMail: true,
  undoSendSec: 10,
  threadView: true,
  templates: []
}

/** Eine zurueckgestellte Mail. Der Schluessel ist die Kennung der Nachricht. */
export interface SnoozeEntry {
  until: number
  /** Die Frist ist um; die Mail steht wieder in der Liste, bis sie gelesen wird */
  over?: boolean
}

interface AccountsFile {
  accounts: Account[]
  /** accountId -> Passwort, mit Electrons safeStorage verschluesselt (base64) */
  secrets: Record<string, string>
  /** Fallback, falls das Betriebssystem keine Verschluesselung anbietet */
  plaintextSecrets?: Record<string, string>
}

/**
 * Dateibasierte Ablage im userData-Verzeichnis.
 *
 * Bewusst ohne SQLite: der Client kommt damit ohne native Module aus, was das
 * Cross-Kompilieren einer Windows-.exe unter Linux erst moeglich macht. Die
 * Kopfdaten aller Nachrichten liegen im RAM (rund 0,5 kB pro Mail), Bodies
 * werden einzeln von der Platte nachgeladen.
 */
export class Store {
  private root: string
  private accountsFile: AccountsFile = { accounts: [], secrets: {} }
  private settings: Settings = { ...DEFAULT_SETTINGS }
  /** Kennung der Nachricht -> Zurueckstellung. Bleibt lokal, der Server erfaehrt nichts. */
  private snoozes = new Map<string, SnoozeEntry>()

  /** accountId -> Ordnerliste */
  private folders = new Map<AccountId, Folder[]>()
  /** accountId -> folderPath -> uid -> Summary */
  private messages = new Map<AccountId, Map<string, Map<number, MessageSummary>>>()
  /** accountId -> folderPath -> { uidValidity, highestModseq } */
  private folderState = new Map<AccountId, Map<string, FolderSyncState>>()

  private dirtyFolders = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(rootOverride?: string) {
    this.root = rootOverride ?? app.getPath('userData')
  }

  // ---------------------------------------------------------------- Pfade

  private accountDir(accountId: AccountId): string {
    return path.join(this.root, 'accounts', accountId)
  }

  private messagesPath(accountId: AccountId, folder: string): string {
    return path.join(this.accountDir(accountId), 'messages', `${slug(folder)}.json`)
  }

  private bodyPath(accountId: AccountId, folder: string, uid: number): string {
    return path.join(this.accountDir(accountId), 'bodies', slug(folder), `${uid}.json`)
  }

  // ----------------------------------------------------------------- Laden

  async load(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })

    const accounts = await readJson<AccountsFile>(path.join(this.root, 'accounts.json'))
    if (accounts) {
      this.accountsFile = {
        accounts: accounts.accounts ?? [],
        secrets: accounts.secrets ?? {},
        plaintextSecrets: accounts.plaintextSecrets
      }
    }

    const settings = await readJson<Partial<Settings>>(path.join(this.root, 'settings.json'))
    if (settings) this.settings = { ...DEFAULT_SETTINGS, ...settings }

    const snoozes = await readJson<Record<string, SnoozeEntry>>(path.join(this.root, 'snoozes.json'))
    if (snoozes) this.snoozes = new Map(Object.entries(snoozes))

    for (const account of this.accountsFile.accounts) {
      await this.loadAccountData(account.id)
    }
  }

  private async loadAccountData(accountId: AccountId): Promise<void> {
    const folders =
      (await readJson<Folder[]>(path.join(this.accountDir(accountId), 'folders.json'))) ?? []
    this.folders.set(accountId, folders)

    const state =
      (await readJson<Record<string, FolderSyncState>>(
        path.join(this.accountDir(accountId), 'state.json')
      )) ?? {}
    this.folderState.set(accountId, new Map(Object.entries(state)))

    const byFolder = new Map<string, Map<number, MessageSummary>>()
    this.messages.set(accountId, byFolder)

    for (const folder of folders) {
      const list = await readJson<MessageSummary[]>(this.messagesPath(accountId, folder.path))
      if (!list) continue
      const map = new Map<number, MessageSummary>()
      for (const m of list) map.set(m.uid, m)
      byFolder.set(folder.path, map)
    }
  }

  // --------------------------------------------------------------- Konten

  listAccounts(): Account[] {
    return this.accountsFile.accounts.map((a) => ({ ...a }))
  }

  getAccount(id: AccountId): Account | undefined {
    return this.accountsFile.accounts.find((a) => a.id === id)
  }

  async upsertAccount(account: Omit<Account, 'id' | 'createdAt'> & { id?: AccountId }, password?: string): Promise<Account> {
    const existing = account.id ? this.getAccount(account.id) : undefined
    const full: Account = existing
      ? { ...existing, ...account, id: existing.id, createdAt: existing.createdAt }
      : { ...account, id: account.id ?? randomUUID(), createdAt: Date.now() }

    if (existing) {
      const idx = this.accountsFile.accounts.findIndex((a) => a.id === full.id)
      this.accountsFile.accounts[idx] = full
    } else {
      this.accountsFile.accounts.push(full)
      await fsp.mkdir(path.join(this.accountDir(full.id), 'messages'), { recursive: true })
      await fsp.mkdir(path.join(this.accountDir(full.id), 'bodies'), { recursive: true })
      this.folders.set(full.id, [])
      this.messages.set(full.id, new Map())
      this.folderState.set(full.id, new Map())
    }

    if (password) this.setPassword(full.id, password)
    await this.persistAccounts()
    return full
  }

  async removeAccount(id: AccountId): Promise<void> {
    this.accountsFile.accounts = this.accountsFile.accounts.filter((a) => a.id !== id)
    delete this.accountsFile.secrets[id]
    if (this.accountsFile.plaintextSecrets) delete this.accountsFile.plaintextSecrets[id]
    this.folders.delete(id)
    this.messages.delete(id)
    this.folderState.delete(id)
    await this.persistAccounts()
    await fsp.rm(this.accountDir(id), { recursive: true, force: true })
  }

  private setPassword(id: AccountId, password: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      this.accountsFile.secrets[id] = safeStorage.encryptString(password).toString('base64')
      if (this.accountsFile.plaintextSecrets) delete this.accountsFile.plaintextSecrets[id]
    } else {
      // Ohne OS-Keychain (z. B. Linux ohne libsecret) bleibt nur Klartext.
      // Die UI weist darauf hin, statt es stillschweigend zu tun.
      this.accountsFile.plaintextSecrets ??= {}
      this.accountsFile.plaintextSecrets[id] = password
      delete this.accountsFile.secrets[id]
    }
  }

  getPassword(id: AccountId): string | undefined {
    const enc = this.accountsFile.secrets[id]
    if (enc) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return undefined
      }
    }
    return this.accountsFile.plaintextSecrets?.[id]
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private async persistAccounts(): Promise<void> {
    await writeJson(path.join(this.root, 'accounts.json'), this.accountsFile)
  }

  // -------------------------------------------------------- Einstellungen

  getSettings(): Settings {
    return { ...this.settings }
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch }
    await writeJson(path.join(this.root, 'settings.json'), this.settings)
    return this.getSettings()
  }

  // ------------------------------------------------------ Zurueckstellen

  getSnoozes(): Map<string, SnoozeEntry> {
    return this.snoozes
  }

  async setSnooze(id: string, entry: SnoozeEntry | null): Promise<void> {
    if (entry) this.snoozes.set(id, entry)
    else if (!this.snoozes.delete(id)) return
    await this.persistSnoozes()
  }

  async setSnoozes(changes: [string, SnoozeEntry | null][]): Promise<void> {
    let changed = false
    for (const [id, entry] of changes) {
      if (entry) {
        this.snoozes.set(id, entry)
        changed = true
      } else if (this.snoozes.delete(id)) changed = true
    }
    if (changed) await this.persistSnoozes()
  }

  private async persistSnoozes(): Promise<void> {
    await writeJson(path.join(this.root, 'snoozes.json'), Object.fromEntries(this.snoozes))
  }

  // -------------------------------------------------------------- Ordner

  getFolders(accountId: AccountId): Folder[] {
    return this.folders.get(accountId) ?? []
  }

  async setFolders(accountId: AccountId, folders: Folder[]): Promise<void> {
    // Zaehler aus dem lokalen Cache uebernehmen, damit die Sidebar beim
    // Neuverbinden nicht kurz auf null springt.
    const byFolder = this.messages.get(accountId)
    for (const folder of folders) {
      const cached = byFolder?.get(folder.path)
      if (cached && folder.total === 0) {
        folder.total = cached.size
        folder.unread = countUnread(cached)
      }
    }
    this.folders.set(accountId, folders)
    await writeJson(path.join(this.accountDir(accountId), 'folders.json'), folders)
  }

  updateFolderCounts(accountId: AccountId, folderPath: string): void {
    const folder = this.getFolders(accountId).find((f) => f.path === folderPath)
    if (!folder) return
    const map = this.messages.get(accountId)?.get(folderPath)
    if (!map) return
    folder.total = map.size
    folder.unread = countUnread(map)
  }

  getFolderState(accountId: AccountId, folderPath: string): FolderSyncState | undefined {
    return this.folderState.get(accountId)?.get(folderPath)
  }

  async setFolderState(accountId: AccountId, folderPath: string, state: FolderSyncState): Promise<void> {
    let map = this.folderState.get(accountId)
    if (!map) {
      map = new Map()
      this.folderState.set(accountId, map)
    }
    map.set(folderPath, state)
    await writeJson(
      path.join(this.accountDir(accountId), 'state.json'),
      Object.fromEntries(map)
    )
  }

  // --------------------------------------------------------- Nachrichten

  getMessages(accountId: AccountId, folderPath: string): MessageSummary[] {
    const map = this.messages.get(accountId)?.get(folderPath)
    if (!map) return []
    return [...map.values()].sort((a, b) => b.date - a.date)
  }

  getMessage(accountId: AccountId, folderPath: string, uid: number): MessageSummary | undefined {
    return this.messages.get(accountId)?.get(folderPath)?.get(uid)
  }

  /** Alle Nachrichten aller Konten - Grundlage fuer Suche und Sammelposteingang. */
  allMessages(): MessageSummary[] {
    const out: MessageSummary[] = []
    for (const byFolder of this.messages.values()) {
      for (const map of byFolder.values()) out.push(...map.values())
    }
    return out
  }

  messagesInRole(role: string): MessageSummary[] {
    const out: MessageSummary[] = []
    for (const [accountId, folders] of this.folders) {
      for (const folder of folders) {
        if (folder.role !== role) continue
        const map = this.messages.get(accountId)?.get(folder.path)
        if (map) out.push(...map.values())
      }
    }
    return out.sort((a, b) => b.date - a.date)
  }

  putMessages(accountId: AccountId, folderPath: string, list: MessageSummary[]): void {
    const map = this.folderMap(accountId, folderPath)
    for (const m of list) map.set(m.uid, m)
    this.markDirty(accountId, folderPath)
  }

  setFlags(accountId: AccountId, folderPath: string, uid: number, flags: string[]): void {
    const msg = this.messages.get(accountId)?.get(folderPath)?.get(uid)
    if (!msg) return
    msg.flags = flags
    this.markDirty(accountId, folderPath)
  }

  removeMessages(accountId: AccountId, folderPath: string, uids: number[]): void {
    const map = this.messages.get(accountId)?.get(folderPath)
    if (!map) return
    for (const uid of uids) {
      map.delete(uid)
      void fsp.rm(this.bodyPath(accountId, folderPath, uid), { force: true })
    }
    this.markDirty(accountId, folderPath)
  }

  /** UIDs, die lokal bekannt sind - fuer den Abgleich mit der Serverliste. */
  knownUids(accountId: AccountId, folderPath: string): number[] {
    const map = this.messages.get(accountId)?.get(folderPath)
    return map ? [...map.keys()] : []
  }

  async clearFolder(accountId: AccountId, folderPath: string): Promise<void> {
    this.folderMap(accountId, folderPath).clear()
    await fsp.rm(path.join(this.accountDir(accountId), 'bodies', slug(folderPath)), {
      recursive: true,
      force: true
    })
    this.markDirty(accountId, folderPath)
  }

  private folderMap(accountId: AccountId, folderPath: string): Map<number, MessageSummary> {
    let byFolder = this.messages.get(accountId)
    if (!byFolder) {
      byFolder = new Map()
      this.messages.set(accountId, byFolder)
    }
    let map = byFolder.get(folderPath)
    if (!map) {
      map = new Map()
      byFolder.set(folderPath, map)
    }
    return map
  }

  // -------------------------------------------------------------- Bodies

  async getBody(accountId: AccountId, folderPath: string, uid: number): Promise<MessageBody | null> {
    return readJson<MessageBody>(this.bodyPath(accountId, folderPath, uid))
  }

  async putBody(accountId: AccountId, folderPath: string, uid: number, body: MessageBody): Promise<void> {
    await writeJson(this.bodyPath(accountId, folderPath, uid), body)
  }

  // ------------------------------------------------------- Schreibpuffer

  /**
   * Schreibvorgaenge werden gebuendelt: waehrend eines Sync-Laufs aendern sich
   * hunderte Nachrichten, die Datei soll aber nur einmal auf die Platte.
   */
  private markDirty(accountId: AccountId, folderPath: string): void {
    this.dirtyFolders.add(`${accountId}|${folderPath}`)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 1500)
  }

  async flush(): Promise<void> {
    const pending = [...this.dirtyFolders]
    this.dirtyFolders.clear()
    for (const key of pending) {
      const sep = key.indexOf('|')
      const accountId = key.slice(0, sep)
      const folderPath = key.slice(sep + 1)
      const map = this.messages.get(accountId)?.get(folderPath)
      if (!map) continue
      await writeJson(this.messagesPath(accountId, folderPath), [...map.values()])
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }
}

export interface FolderSyncState {
  uidValidity: string
  /** Fuer CONDSTORE-faehige Server: nur Aenderungen seit diesem Wert holen */
  highestModseq?: string
  lastSyncAt?: number
}

// ------------------------------------------------------------- Hilfsmittel

function countUnread(map: Map<number, MessageSummary>): number {
  let n = 0
  for (const m of map.values()) if (!m.flags.includes('\\Seen')) n++
  return n
}

/**
 * Dateisystemtauglicher Name fuer einen IMAP-Pfad. Der Hash haengt dran, weil
 * unterschiedliche Pfade sonst auf denselben Namen fallen koennten
 * (etwa "A/B" und "A_B").
 */
function slug(folderPath: string): string {
  const safe = folderPath.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 48)
  const hash = createHash('sha1').update(folderPath).digest('hex').slice(0, 8)
  return `${safe}-${hash}`
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    // Kaputte Datei darf den Start nicht verhindern - lieber neu aufbauen.
    console.error(`[store] ${file} nicht lesbar:`, err)
    return null
  }
}

/** Atomar schreiben, damit ein Absturz keine halbe Datei hinterlaesst. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8')
  await fsp.rename(tmp, file)
}

/** Nur fuer Tests / Migrationen: gibt es das Verzeichnis schon? */
export function dataDirExists(root: string): boolean {
  return fs.existsSync(root)
}
