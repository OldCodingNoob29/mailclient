import { contextBridge, ipcRenderer } from 'electron'
import type { MailtoDraft } from '@shared/mailto'
import type {
  Account,
  AccountDraft,
  AccountId,
  AccountStatus,
  ConnectionTestResult,
  Contact,
  Folder,
  MessageBody,
  MessageSummary,
  OutboxItem,
  OutgoingMessage,
  RuleRunResult,
  SearchQuery,
  SendResult,
  Settings,
  ViewRef
} from '@shared/types'

export interface PickedAttachment {
  filename: string
  content: string
  contentType: string
  size: number
}

/**
 * Die einzige Bruecke zwischen Oberflaeche und Main-Prozess. Der Renderer hat
 * kein Node, keine offenen IPC-Kanaele und keinen Zugriff auf das Dateisystem -
 * nur auf genau diese Funktionen.
 */
const api = {
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    save: (draft: AccountDraft): Promise<Account> => ipcRenderer.invoke('accounts:save', draft),
    remove: (id: AccountId): Promise<void> => ipcRenderer.invoke('accounts:delete', id),
    test: (draft: AccountDraft): Promise<ConnectionTestResult> => ipcRenderer.invoke('accounts:test', draft),
    statuses: (): Promise<AccountStatus[]> => ipcRenderer.invoke('accounts:statuses'),
    encryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke('accounts:encryptionAvailable')
  },
  folders: {
    list: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list')
  },
  messages: {
    list: (view: ViewRef, limit?: number): Promise<MessageSummary[]> =>
      ipcRenderer.invoke('messages:list', view, limit),
    body: (accountId: AccountId, folder: string, uid: number): Promise<MessageBody | null> =>
      ipcRenderer.invoke('messages:body', accountId, folder, uid),
    setSeen: (items: MessageSummary[], seen: boolean): Promise<void> =>
      ipcRenderer.invoke('messages:setSeen', items, seen),
    setFlagged: (items: MessageSummary[], flagged: boolean): Promise<void> =>
      ipcRenderer.invoke('messages:setFlagged', items, flagged),
    remove: (items: MessageSummary[]): Promise<void> => ipcRenderer.invoke('messages:delete', items),
    archive: (items: MessageSummary[]): Promise<void> => ipcRenderer.invoke('messages:archive', items),
    move: (items: MessageSummary[], target: string): Promise<void> =>
      ipcRenderer.invoke('messages:move', items, target),
    /** Die Unterhaltung, zu der eine Mail gehoert, aelteste zuerst. */
    thread: (accountId: AccountId, folder: string, uid: number): Promise<MessageSummary[]> =>
      ipcRenderer.invoke('messages:thread', accountId, folder, uid),
    /** Blendet Mails bis zum Zeitpunkt `until` (ms) aus - nur lokal. */
    snooze: (items: MessageSummary[], until: number): Promise<void> =>
      ipcRenderer.invoke('messages:snooze', items, until),
    unsnooze: (items: MessageSummary[]): Promise<void> => ipcRenderer.invoke('messages:unsnooze', items),
    markRead: (target: { accountId?: AccountId; folder?: string }): Promise<void> =>
      ipcRenderer.invoke('messages:markRead', target),
    emptyFolder: (accountId: AccountId, folder: string): Promise<void> =>
      ipcRenderer.invoke('messages:emptyFolder', accountId, folder)
  },
  sync: {
    refresh: (accountId?: AccountId, folder?: string): Promise<void> =>
      ipcRenderer.invoke('sync:refresh', accountId, folder),
    searchServer: (query: SearchQuery): Promise<void> => ipcRenderer.invoke('search:server', query)
  },
  contacts: {
    /** Adressvorschlaege aus vorhandenen Mails; leere Suche = die haeufigsten. */
    suggest: (query: string, limit?: number): Promise<Contact[]> =>
      ipcRenderer.invoke('contacts:suggest', query, limit)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch)
  },
  mail: {
    /** Mit `sendAt` (ms) wartet die Nachricht im Ausgang auf ihren Termin. */
    send: (msg: OutgoingMessage, opts?: { sendAt?: number }): Promise<SendResult> =>
      ipcRenderer.invoke('mail:send', msg, opts)
  },
  outbox: {
    list: (): Promise<OutboxItem[]> => ipcRenderer.invoke('outbox:list'),
    discard: (id: string): Promise<void> => ipcRenderer.invoke('outbox:discard', id),
    /** Holt eine wartende Nachricht zurueck; null, wenn sie schon unterwegs ist. */
    take: (id: string): Promise<OutgoingMessage | null> => ipcRenderer.invoke('outbox:take', id),
    sendNow: (id: string): Promise<void> => ipcRenderer.invoke('outbox:sendNow', id)
  },
  attachments: {
    save: (
      accountId: AccountId,
      folder: string,
      uid: number,
      partId: string,
      filename: string
    ): Promise<{ saved: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('attachment:save', accountId, folder, uid, partId, filename),
    open: (
      accountId: AccountId,
      folder: string,
      uid: number,
      partId: string,
      filename: string
    ): Promise<{ opened: boolean; error?: string }> =>
      ipcRenderer.invoke('attachment:open', accountId, folder, uid, partId, filename),
    pick: (): Promise<PickedAttachment[]> => ipcRenderer.invoke('compose:pickAttachments')
  },
  rules: {
    /** Wendet eine gespeicherte Regel auf den Posteingang an. */
    apply: (ruleId: string): Promise<RuleRunResult> => ipcRenderer.invoke('rules:apply', ruleId)
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /** Der mailto:-Link, mit dem die App gestartet wurde (einmalig, danach null). */
  takeMailto: (): Promise<MailtoDraft | null> => ipcRenderer.invoke('mailto:take'),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  setBadge: (count: number, dataUrl: string | null): Promise<void> =>
    ipcRenderer.invoke('badge:set', count, dataUrl),

  /** Meldet sich fuer Push-Ereignisse an; gibt die Abmeldefunktion zurueck. */
  on: (channel: AppChannel, listener: (payload: unknown) => void): (() => void) => {
    if (!ALLOWED_CHANNELS.includes(channel)) throw new Error(`Unbekannter Kanal: ${channel}`)
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

const ALLOWED_CHANNELS = [
  'accounts:changed',
  'folders:changed',
  'messages:changed',
  'settings:changed',
  'status:changed',
  'outbox:changed',
  'menu:compose',
  'menu:refresh',
  'menu:settings',
  'menu:search',
  'menu:readerZoom',
  'mail:open',
  'mail:sendFailed',
  'compose:mailto'
] as const

export type AppChannel = (typeof ALLOWED_CHANNELS)[number]
export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
