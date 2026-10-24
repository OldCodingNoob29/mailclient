import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  AccountStatus,
  Folder,
  MessageBody,
  MessageSummary,
  OutboxItem,
  SearchQuery,
  Settings,
  ViewRef
} from '@shared/types'

const api = window.api

/** Konten, Ordner, Status und Einstellungen - alles, was global gilt. */
export function useWorkspace() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [statuses, setStatuses] = useState<AccountStatus[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [ready, setReady] = useState(false)

  const reloadAccounts = useCallback(async () => {
    const [list, statusList] = await Promise.all([api.accounts.list(), api.accounts.statuses()])
    setAccounts(list)
    setStatuses(statusList)
  }, [])

  const reloadFolders = useCallback(async () => setFolders(await api.folders.list()), [])
  const reloadOutbox = useCallback(async () => setOutbox(await api.outbox.list()), [])

  useEffect(() => {
    void (async () => {
      setSettings(await api.settings.get())
      await reloadAccounts()
      await reloadFolders()
      await reloadOutbox()
      setReady(true)
    })()

    const off = [
      api.on('accounts:changed', () => void reloadAccounts()),
      api.on('folders:changed', () => void reloadFolders()),
      api.on('status:changed', (payload) => setStatuses(payload as AccountStatus[])),
      api.on('settings:changed', (payload) => setSettings(payload as Settings)),
      api.on('outbox:changed', (payload) => setOutbox(payload as OutboxItem[]))
    ]
    return () => off.forEach((fn) => fn())
  }, [reloadAccounts, reloadFolders, reloadOutbox])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.settings.update(patch))
  }, [])

  const foldersByAccount = useMemo(() => {
    const map = new Map<string, Folder[]>()
    for (const folder of folders) {
      const list = map.get(folder.accountId)
      if (list) list.push(folder)
      else map.set(folder.accountId, [folder])
    }
    return map
  }, [folders])

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.accountId, s])), [statuses])

  return {
    accounts,
    folders,
    foldersByAccount,
    statuses,
    statusById,
    settings,
    outbox,
    ready,
    reloadAccounts,
    reloadFolders,
    updateSettings
  }
}

/** Farbe und Kurztext des Abruf-Knopfes. */
export type SyncTone = 'idle' | 'busy' | 'done' | 'error'

export interface SyncFeedback {
  tone: SyncTone
  /** Laeuft gerade ein Abruf? Steuert die Drehung des Symbols. */
  busy: boolean
  /** Text der Sprechblase; null heisst: nichts anzeigen. */
  label: string | null
}

/**
 * Uebersetzt die Kontostatus in eine einzelne Rueckmeldung am Abruf-Knopf.
 *
 * Waehrend des Abrufs bleibt der Text stehen, danach blitzt "Aktuell" bzw. der
 * Fehler kurz auf und verschwindet wieder - eine dauerhafte Meldung wuerde man
 * nach zwei Tagen ohnehin nicht mehr sehen.
 */
export function useSyncFeedback(statuses: AccountStatus[]): SyncFeedback {
  const busy = useMemo(
    () => statuses.some((s) => s.phase === 'syncing' || s.phase === 'connecting'),
    [statuses]
  )

  // Der Text zaehlt, nicht das Objekt: jeder Statusfunk liefert neue Objekte,
  // und ein unveraenderter Fehler soll den Ausblendzaehler nicht neu starten.
  const problem = useMemo(() => {
    const failed = statuses.find((s) => s.phase === 'error')
    if (failed) return failed.message || 'Abruf fehlgeschlagen'
    return statuses.some((s) => s.phase === 'offline') ? 'Keine Verbindung' : null
  }, [statuses])

  const [shown, setShown] = useState<{ tone: SyncTone; label: string } | null>(null)
  const wasBusy = useRef(false)

  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      setShown({ tone: 'busy', label: 'Wird abgerufen\u2026' })
      return
    }
    // Ob gerade ein Lauf zu Ende ging - nur dann ist "Aktuell" eine Nachricht.
    const justFinished = wasBusy.current
    wasBusy.current = false
    if (problem) {
      setShown({ tone: 'error', label: problem })
      const timer = setTimeout(() => setShown(null), 6000)
      return () => clearTimeout(timer)
    }
    if (!justFinished) {
      setShown(null)
      return
    }
    setShown({ tone: 'done', label: 'Aktuell' })
    const timer = setTimeout(() => setShown(null), 2400)
    return () => clearTimeout(timer)
  }, [busy, problem])

  // Der Knopf faerbt sich nach dem tatsaechlichen Zustand, der Text darf
  // unabhaengig davon schon wieder verschwunden sein.
  const tone: SyncTone = busy ? 'busy' : problem ? 'error' : (shown?.tone ?? 'idle')
  return { tone, busy, label: shown?.label ?? null }
}

/** Die Nachrichten der aktuellen Ansicht, inklusive Live-Aktualisierung. */
export function useMessages(view: ViewRef) {
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [loading, setLoading] = useState(true)
  const viewRef = useRef(view)
  viewRef.current = view
  /** Zeitpunkt der letzten Aenderung, die nur hier in der Oberflaeche steht. */
  const patchedAt = useRef(0)

  const reload = useCallback(async () => {
    const startedAt = Date.now()
    const list = await api.messages.list(viewRef.current)
    // Eine Liste, die vor der Aenderung angefragt wurde, kennt sie noch nicht.
    // Die naechste kommt ohnehin: der Main-Prozess meldet die Aenderung selbst.
    if (startedAt < patchedAt.current) return
    setMessages(list)
    setLoading(false)
  }, [])

  /**
   * Zeigt ein gesetztes oder entferntes Flag sofort an. Der Main-Prozess traegt
   * es zwar auch sofort ein, ist waehrend eines grossen Abgleichs aber zu
   * beschaeftigt, um die neue Liste ohne Verzug zu liefern.
   */
  const patchFlags = useCallback((ids: Set<string>, flag: string, on: boolean) => {
    patchedAt.current = Date.now()
    setMessages((list) =>
      list.map((m) => {
        if (!ids.has(m.id) || m.flags.includes(flag) === on) return m
        return { ...m, flags: on ? [...m.flags, flag] : m.flags.filter((f) => f !== flag) }
      })
    )
  }, [])

  useEffect(() => {
    setLoading(true)
    void reload()
    const off = api.on('messages:changed', () => void reload())
    return () => off()
  }, [reload, view])

  return { messages, loading, reload, patchFlags }
}

/**
 * Die Unterhaltung, zu der die ausgewaehlte Nachricht gehoert, aelteste zuerst.
 * Laedt neu, sobald sich am Bestand etwas aendert - der Main-Prozess holt
 * fehlende Teile vom Server nach und meldet das ueber denselben Kanal.
 */
export function useThread(message: MessageSummary | null, enabled: boolean): MessageSummary[] {
  const [thread, setThread] = useState<MessageSummary[]>([])
  const key = enabled && message ? message.id : null
  const ref = useRef(message)
  ref.current = message

  useEffect(() => {
    setThread([])
    if (!key) return
    let cancelled = false
    const load = (): void => {
      const current = ref.current
      if (!current) return
      void api.messages
        .thread(current.accountId, current.folder, current.uid)
        .then((list) => {
          if (!cancelled) setThread(list)
        })
        .catch(() => {})
    }
    load()
    const off = api.on('messages:changed', load)
    return () => {
      cancelled = true
      off()
    }
  }, [key])

  return thread
}

/** Der Textkoerper der ausgewaehlten Nachricht. */
export function useMessageBody(message: MessageSummary | null) {
  const [body, setBody] = useState<MessageBody | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Die Identitaet haengt an der Kennung, nicht am Objekt: jeder Sync liefert
  // neue Objekte, der Inhalt der Nachricht aendert sich davon aber nicht.
  const key = message?.id ?? null
  const ref = useRef(message)
  ref.current = message

  useEffect(() => {
    const message = ref.current
    if (!message) {
      setBody(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.messages
      .body(message.accountId, message.folder, message.uid)
      .then((result) => {
        if (cancelled) return
        setBody(result)
        if (!result) setError('Diese Nachricht liess sich nicht laden.')
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [key])

  return { body, loading, error }
}

/**
 * Tippen soll die Liste nicht bei jedem Anschlag neu berechnen; ausserdem
 * startet die Serversuche erst, wenn die Eingabe zur Ruhe gekommen ist.
 */
export function useSearch(initial = '') {
  const [text, setText] = useState(initial)
  const [debounced, setDebounced] = useState(initial)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 220)
    return () => clearTimeout(timer)
  }, [text])

  return { text, setText, debounced }
}

export function runServerSearch(query: SearchQuery): void {
  void api.sync.searchServer(query).catch(() => {})
}
