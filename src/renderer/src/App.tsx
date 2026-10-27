import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  ComposeMode,
  ComposeSeed,
  Folder,
  MessageSummary,
  OutgoingMessage,
  SendResult,
  ViewRef
} from '@shared/types'
import { collapseThreads, type ThreadRow } from '@shared/threads'
import { timePresets } from '@shared/times'
import { AccountRail } from './components/AccountRail'
import { AccountWizard } from './components/AccountWizard'
import { Composer } from './components/Composer'
import { ContextMenu, type MenuItem, type MenuRequest } from './components/ContextMenu'
import { FolderList } from './components/FolderList'
import { MessageList } from './components/MessageList'
import { Reader } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { TimeDialog } from './components/TimeDialog'
import { attachZoomKeys, clampZoom, nextZoom, type ZoomStep } from './lib/zoom'
import {
  IconArchive,
  IconClock,
  IconCompose,
  IconEnvelopeOpen,
  IconFolder,
  IconForward,
  IconInbox,
  IconRefresh,
  IconReply,
  IconReplyAll,
  IconSettings,
  IconStar,
  IconTrash
} from './components/icons'
import { drawBadge } from './lib/badge'
import { addressList, folderLabel, formatAddressFull, fullDate, shortDateTime } from './lib/format'
import { addTrustedDomain } from './lib/remote-images'
import type { MailtoDraft } from '@shared/mailto'
import { textToEditorHtml } from './lib/sanitize'
import {
  runServerSearch,
  useMessageBody,
  useMessages,
  useSearch,
  useSyncFeedback,
  useThread,
  useWorkspace
} from './state'

const UNIFIED_INBOX: ViewRef = { kind: 'unified', id: 'inbox' }

/** Kurze Meldung am unteren Rand, auf Wunsch mit einem Knopf. */
interface Toast {
  text: string
  action?: { label: string; run: () => void }
}

/** Frage nach einem freien Zeitpunkt. */
interface TimeAsk {
  title: string
  confirm: string
  onPick: (at: number) => void
}

export default function App() {
  const workspace = useWorkspace()
  const { accounts, foldersByAccount, folders, settings, statuses, statusById } = workspace

  const [view, setView] = useState<ViewRef>(UNIFIED_INBOX)
  const [selected, setSelected] = useState<MessageSummary | null>(null)
  /** Mehrfachauswahl; enthaelt die Kennung von `selected` immer mit. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /** Ausgangspunkt fuer Auswahl mit gedrueckter Umschalttaste */
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [compose, setCompose] = useState<ComposeSeed | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [wizard, setWizard] = useState<{ account?: Account } | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [timeAsk, setTimeAsk] = useState<TimeAsk | null>(null)
  /** Mail aus der Unterhaltung, die statt der ausgewaehlten im Lesebereich steht */
  const [threadFocusId, setThreadFocusId] = useState<string | null>(null)
  /** Aus einer Benachrichtigung gemeldete Mail, die noch geoeffnet werden soll. */
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null)

  const search = useSearch()
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Ein Suchbegriff ueberlagert die gewaehlte Ansicht, ohne sie zu vergessen.
  const effectiveView: ViewRef = useMemo(() => {
    const text = search.debounced.trim()
    if (!text) return view
    return {
      kind: 'search',
      query: {
        text,
        accountId: view.kind === 'folder' ? view.accountId : undefined,
        folder: view.kind === 'folder' ? view.folder : undefined
      }
    }
  }, [search.debounced, view])

  const { messages, loading, patchFlags } = useMessages(effectiveView)

  /** Gelesen/ungelesen: sofort in der Liste, dann beim Server. */
  const markSeen = useCallback(
    (items: MessageSummary[], seen: boolean): Promise<void> => {
      patchFlags(new Set(items.map((m) => m.id)), '\\Seen', seen)
      return window.api.messages.setSeen(items, seen)
    },
    [patchFlags]
  )

  /*
    Die Liste zeigt Zeilen, nicht Mails: eine Zeile je Unterhaltung. `messages`
    bleibt die flache Liste zum Nachschlagen; ausgewaehlt und durchgeblaettert
    werden die Koepfe der Zeilen, und eine Aktion auf einer Zeile trifft alle
    Mails darunter.
  */
  const threaded = Boolean(settings?.threadView)
  const rows = useMemo<ThreadRow[]>(
    () => (threaded ? collapseThreads(messages) : messages.map((m) => ({ head: m, members: [m] }))),
    [messages, threaded]
  )
  const heads = useMemo(() => rows.map((row) => row.head), [rows])
  const rowByMember = useMemo(() => {
    const map = new Map<string, ThreadRow>()
    for (const row of rows) for (const member of row.members) map.set(member.id, row)
    return map
  }, [rows])
  const membersOf = useCallback(
    (message: MessageSummary): MessageSummary[] => rowByMember.get(message.id)?.members ?? [message],
    [rowByMember]
  )

  const thread = useThread(selected, threaded)
  /** Was im Lesebereich steht: die Auswahl oder eine andere Mail ihrer Unterhaltung. */
  const shown = useMemo(
    () => (threadFocusId ? (thread.find((m) => m.id === threadFocusId) ?? selected) : selected),
    [selected, thread, threadFocusId]
  )
  const { body, loading: bodyLoading, error: bodyError } = useMessageBody(shown)

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const folderByKey = useMemo(
    () => new Map(folders.map((f) => [`${f.accountId}|${f.path}`, f])),
    [folders]
  )

  const unreadByAccount = useMemo(() => {
    const map = new Map<string, number>()
    for (const folder of folders) {
      if (folder.role !== 'inbox') continue
      map.set(folder.accountId, (map.get(folder.accountId) ?? 0) + folder.unread)
    }
    return map
  }, [folders])

  const unreadTotal = useMemo(
    () => [...unreadByAccount.values()].reduce((sum, n) => sum + n, 0),
    [unreadByAccount]
  )

  const sync = useSyncFeedback(statuses)

  const selectedFolder = shown ? folderByKey.get(`${shown.accountId}|${shown.folder}`) : undefined
  const selectedAccount = shown ? accountsById.get(shown.accountId) : undefined

  /** Worauf sich eine Aktion bezieht: die Mehrfachauswahl, sonst die offene Zeile mit allem darunter. */
  const selection = useMemo(() => {
    if (selectedIds.size > 1) return heads.filter((m) => selectedIds.has(m.id)).flatMap(membersOf)
    return selected ? membersOf(selected) : []
  }, [heads, membersOf, selected, selectedIds])

  /** Aktionen im Lesebereich: steht dort eine einzelne Mail des Verlaufs, trifft es nur sie. */
  const readerTargets = useMemo(
    () => (shown && selected && shown.id !== selected.id ? [shown] : selection),
    [selected, selection, shown]
  )

  const moveTargets = useCallback(
    (accountId: string, currentFolder?: string): Folder[] =>
      (foldersByAccount.get(accountId) ?? []).filter(
        (f) => f.selectable && !f.hidden && f.path !== currentFolder && f.role !== 'drafts'
      ),
    [foldersByAccount]
  )

  const [readerZoom, setReaderZoom] = useState(1)
  const zoomSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.api.accounts.encryptionAvailable().then(setEncryptionAvailable)
  }, [])

  /*
    Die Vergroesserung des Nachrichteninhalts liegt hier und nicht in den
    Einstellungen, damit ein Raddreh sofort sichtbar wird; gespeichert wird sie
    erst, wenn das Drehen aufhoert - sonst schriebe jede Rastung auf die Platte.
  */
  useEffect(() => {
    if (settings) setReaderZoom(clampZoom(settings.readerZoom))
  }, [settings?.readerZoom])

  const stepReaderZoom = useCallback((step: ZoomStep) => {
    setReaderZoom((current) => {
      const next = nextZoom(current, step)
      if (zoomSaveTimer.current) clearTimeout(zoomSaveTimer.current)
      zoomSaveTimer.current = setTimeout(() => {
        void window.api.settings.update({ readerZoom: next })
      }, 600)
      return next
    })
  }, [])

  useEffect(() => window.api.on('menu:readerZoom', (payload) => stepReaderZoom(payload as ZoomStep)), [
    stepReaderZoom
  ])

  useEffect(() => attachZoomKeys(window, stepReaderZoom), [stepReaderZoom])

  // Theme auf das Wurzelelement schreiben; "system" folgt der Systemeinstellung.
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    const apply = (): void => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      root.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])

  // Ungelesen-Zaehler am Taskleisten-Symbol nachfuehren.
  useEffect(() => {
    void window.api.setBadge(unreadTotal, drawBadge(unreadTotal))
  }, [unreadTotal])

  // Ansichtswechsel raeumt die Mehrfachauswahl ab - sie bezieht sich auf eine
  // Liste, die es gleich nicht mehr gibt.
  useEffect(() => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }, [effectiveView])

  // Eine neue Auswahl zeigt wieder sich selbst, nicht den zuletzt angesehenen Teil des Verlaufs.
  useEffect(() => setThreadFocusId(null), [selected?.id])

  // Die gemeldete Mail oeffnen, sobald die Liste sie enthaelt.
  useEffect(() => {
    if (!pendingOpenId) return
    const target = messages.find((m) => m.id === pendingOpenId)
    if (!target) return
    setSelected(target)
    setSelectedIds(new Set([target.id]))
    setPendingOpenId(null)
  }, [messages, pendingOpenId])

  // Die Auswahl aktuell halten: nach einem Sync ist das Objekt ein anderes.
  useEffect(() => {
    if (!selected) return
    const fresh = messages.find((m) => m.id === selected.id)
    if (fresh && fresh !== selected) setSelected(fresh)
    else if (!fresh && !loading) setSelected(null)
  }, [messages, selected, loading])

  // Gelesen-Markierung mit Verzoegerung: kurzes Antippen soll nichts aendern.
  // Eine geoeffnete Unterhaltung gilt als Ganzes gelesen.
  const autoRead = useMemo(
    () => (selectedIds.size > 1 ? [] : selection.filter((m) => !m.flags.includes('\\Seen'))),
    [selectedIds, selection]
  )
  const autoReadKey = autoRead.map((m) => m.id).join(' ')
  useEffect(() => {
    if (!autoRead.length || !settings) return
    if (settings.markReadAfterMs < 0) return
    const targets = autoRead
    const timer = setTimeout(() => {
      void markSeen(targets, true)
    }, settings.markReadAfterMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReadKey, settings?.markReadAfterMs])

  // Serverseitige Suche anstossen, sobald die Eingabe steht.
  useEffect(() => {
    const text = search.debounced.trim()
    if (text.length < 3) return
    runServerSearch({
      text,
      accountId: view.kind === 'folder' ? view.accountId : undefined,
      folder: view.kind === 'folder' ? view.folder : undefined
    })
  }, [search.debounced, view])

  const showToast = useCallback((text: string, action?: Toast['action'], ms = 4000) => {
    // Ohne das raeumte der Zaehler einer aelteren Meldung die neue vorzeitig ab.
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ text, action })
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const act = useCallback(
    async (fn: () => Promise<void>, failureText: string) => {
      try {
        await fn()
      } catch (err) {
        showToast(`${failureText} ${(err as Error).message}`)
      }
    },
    [showToast]
  )

  // ------------------------------------------------------------ Auswahl

  const handleSelect = useCallback(
    (message: MessageSummary, event: React.MouseEvent) => {
      if (event.shiftKey && anchorId) {
        const from = heads.findIndex((m) => m.id === anchorId)
        const to = heads.findIndex((m) => m.id === message.id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from]
          setSelectedIds(new Set(heads.slice(start, end + 1).map((m) => m.id)))
          setSelected(message)
          return
        }
      }

      if (event.ctrlKey || event.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(message.id) && next.size > 1) next.delete(message.id)
          else next.add(message.id)
          return next
        })
        setSelected(message)
        setAnchorId(message.id)
        return
      }

      setSelectedIds(new Set([message.id]))
      setSelected(message)
      setAnchorId(message.id)
    },
    [anchorId, heads]
  )

  const selectNextAfterRemoval = useCallback(
    (removed: MessageSummary[]) => {
      const ids = new Set(removed.map((m) => m.id))
      // Eine Zeile ist weg, sobald eine ihrer Mails geht - Aktionen treffen die ganze Zeile.
      const gone = (head: MessageSummary): boolean => membersOf(head).some((m) => ids.has(m.id))
      const index = heads.findIndex(gone)
      const next = heads.slice(index + 1).find((m) => !gone(m)) ?? null
      const previous = [...heads.slice(0, Math.max(index, 0))].reverse().find((m) => !gone(m)) ?? null
      const target = next ?? previous
      setSelected(target)
      setSelectedIds(target ? new Set([target.id]) : new Set())
      setAnchorId(target?.id ?? null)
    },
    [heads, membersOf]
  )

  // ------------------------------------------------------------ Aktionen

  /** Neue Nachricht aus einem mailto:-Link, mit dem ersten Konto als Absender. */
  const composeFromMailto = useCallback(
    (draft: MailtoDraft) => {
      const account = accounts[0]
      if (!account) {
        showToast('Richte zuerst ein Konto ein.')
        return
      }
      setCompose({
        mode: 'new',
        accountId: account.id,
        to: draft.to.map((address) => ({ address })),
        cc: draft.cc.map((address) => ({ address })),
        bcc: draft.bcc.map((address) => ({ address })),
        subject: draft.subject,
        quotedHtml: '',
        bodyHtml: draft.body ? textToEditorHtml(draft.body) : undefined
      })
    },
    [accounts, showToast]
  )

  // Wurde die App ueber einen mailto:-Link gestartet, kommt er hier an, sobald es Konten gibt.
  const mailtoTaken = useRef(false)
  useEffect(() => {
    if (mailtoTaken.current || !accounts.length) return
    mailtoTaken.current = true
    void window.api.takeMailto().then((draft) => draft && composeFromMailto(draft))
  }, [accounts, composeFromMailto])

  const startCompose = useCallback(
    (mode: ComposeMode, message?: MessageSummary | null, to?: string) => {
      const account = message ? accountsById.get(message.accountId) : accounts[0]
      if (!account) {
        showToast('Richte zuerst ein Konto ein.')
        return
      }
      if (!message || mode === 'new') {
        setCompose({
          mode: 'new',
          accountId: account.id,
          to: to ? [{ address: to }] : [],
          cc: [],
          subject: '',
          quotedHtml: ''
        })
        return
      }

      const quoted = buildQuote(message, body?.html ?? (body?.text ? textToEditorHtml(body.text) : ''))
      if (mode === 'forward') {
        setCompose({
          mode,
          accountId: account.id,
          to: [],
          cc: [],
          subject: prefixSubject(message.subject, 'Fwd: '),
          quotedHtml: quoted
        })
        return
      }

      const replyTo = message.replyTo.length ? message.replyTo : message.from
      const others =
        mode === 'replyAll'
          ? [...message.to, ...message.cc].filter(
              (a) =>
                a.address.toLowerCase() !== account.email.toLowerCase() &&
                !replyTo.some((r) => r.address.toLowerCase() === a.address.toLowerCase())
            )
          : []

      setCompose({
        mode,
        accountId: account.id,
        to: replyTo,
        cc: others,
        subject: prefixSubject(message.subject, 'Re: '),
        quotedHtml: quoted,
        inReplyTo: message.messageId,
        references: [...(message.references ?? []), message.messageId].filter(Boolean) as string[]
      })
    },
    [accounts, accountsById, body, showToast]
  )

  const doArchive = useCallback(
    (items: MessageSummary[]) => {
      if (!items.length) return
      selectNextAfterRemoval(items)
      void act(() => window.api.messages.archive(items), 'Archivieren fehlgeschlagen:')
    },
    [act, selectNextAfterRemoval]
  )

  const doDelete = useCallback(
    (items: MessageSummary[]) => {
      if (!items.length) return
      selectNextAfterRemoval(items)
      void act(() => window.api.messages.remove(items), 'Loeschen fehlgeschlagen:')
    },
    [act, selectNextAfterRemoval]
  )

  const doMove = useCallback(
    (items: MessageSummary[], target: string) => {
      if (!items.length) return
      selectNextAfterRemoval(items)
      void act(() => window.api.messages.move(items, target), 'Verschieben fehlgeschlagen:')
    },
    [act, selectNextAfterRemoval]
  )

  const doSnooze = useCallback(
    (items: MessageSummary[], until: number) => {
      if (!items.length) return
      selectNextAfterRemoval(items)
      void act(() => window.api.messages.snooze(items, until), 'Zurueckstellen fehlgeschlagen:')
      showToast(`Zurueckgestellt bis ${shortDateTime(until)}.`, {
        label: 'Rueckgaengig',
        run: () => void window.api.messages.unsnooze(items)
      })
    },
    [act, selectNextAfterRemoval, showToast]
  )

  const askSnooze = useCallback(
    (items: MessageSummary[]) => {
      if (!items.length) return
      setTimeAsk({
        title: 'Zurueckstellen bis',
        confirm: 'Zurueckstellen',
        onPick: (at) => doSnooze(items, at)
      })
    },
    [doSnooze]
  )

  // ------------------------------------------------------------- Ausgang

  /** Holt eine wartende Nachricht aus dem Ausgang zurueck in den Verfassen-Dialog. */
  const reopenOutbox = useCallback(
    async (outboxId: string) => {
      const draft: OutgoingMessage | null = await window.api.outbox.take(outboxId).catch(() => null)
      if (!draft) {
        showToast('Zu spaet - die Nachricht ist schon unterwegs.')
        return
      }
      setToast(null)
      setCompose({
        mode: 'new',
        accountId: draft.accountId,
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        quotedHtml: '',
        inReplyTo: draft.inReplyTo,
        references: draft.references,
        draft
      })
    },
    [showToast]
  )

  const handleSent = useCallback(
    (result: SendResult) => {
      const id = result.outboxId
      if (result.queued) {
        showToast('Kein Netz. Die Nachricht liegt im Ausgang und geht raus, sobald es wieder geht.')
      } else if (result.scheduled && id && result.sendAt) {
        showToast(
          `Geplant fuer ${shortDateTime(result.sendAt)}. Bis dahin liegt sie im Ausgang.`,
          { label: 'Aendern', run: () => void reopenOutbox(id) },
          8000
        )
      } else if (result.undoable && id && result.sendAt) {
        // Der Knopf bleibt genau so lange stehen, wie sich die Nachricht noch aufhalten laesst.
        showToast(
          'Nachricht wird gesendet.',
          { label: 'Rueckgaengig', run: () => void reopenOutbox(id) },
          Math.max(result.sendAt - Date.now(), 1000)
        )
      } else {
        showToast('Gesendet.')
      }
    },
    [reopenOutbox, showToast]
  )

  // ------------------------------------------------------- Kontextmenues

  const openMenu = (event: React.MouseEvent, items: MenuItem[]): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const messageMenu = useCallback(
    (event: React.MouseEvent, message: MessageSummary) => {
      // Rechtsklick neben die Mehrfachauswahl setzt sie zurueck; innerhalb
      // bleibt sie stehen, damit sich das Menue auf alles Markierte bezieht.
      const many = selectedIds.has(message.id) && selectedIds.size > 1
      const items = many ? heads.filter((m) => selectedIds.has(m.id)).flatMap(membersOf) : membersOf(message)
      if (!many) {
        setSelected(message)
        setSelectedIds(new Set([message.id]))
        setAnchorId(message.id)
      }
      const waiting = items.filter((m) => m.snoozedUntil !== undefined && !m.snoozeOver)
      const anyUnread = items.some((m) => !m.flags.includes('\\Seen'))
      const anyUnflagged = items.some((m) => !m.flags.includes('\\Flagged'))
      const sender = message.from[0]?.address
      const targets = moveTargets(message.accountId, message.folder)
      const sameAccount = items.every((m) => m.accountId === message.accountId)

      const menuItems: MenuItem[] = [
        {
          kind: 'item',
          label: 'Antworten',
          icon: <IconReply size={15} />,
          hint: 'R',
          disabled: many,
          onSelect: () => startCompose('reply', message)
        },
        {
          kind: 'item',
          label: 'Allen antworten',
          icon: <IconReplyAll size={15} />,
          hint: 'A',
          disabled: many,
          onSelect: () => startCompose('replyAll', message)
        },
        {
          kind: 'item',
          label: 'Weiterleiten',
          icon: <IconForward size={15} />,
          hint: 'F',
          disabled: many,
          onSelect: () => startCompose('forward', message)
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: anyUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren',
          icon: <IconEnvelopeOpen size={15} />,
          hint: 'U',
          onSelect: () => void markSeen(items, anyUnread)
        },
        {
          kind: 'item',
          label: anyUnflagged ? 'Markieren' : 'Markierung entfernen',
          icon: <IconStar size={15} />,
          hint: 'S',
          onSelect: () => void window.api.messages.setFlagged(items, anyUnflagged)
        },
        {
          kind: 'submenu',
          label: 'Zurueckstellen',
          icon: <IconClock size={15} />,
          items: [
            ...timePresets().map((preset) => ({
              kind: 'item' as const,
              label: preset.label,
              onSelect: () => doSnooze(items, preset.at)
            })),
            { kind: 'item' as const, label: 'Zeitpunkt waehlen ...', onSelect: () => askSnooze(items) }
          ]
        },
        ...(waiting.length
          ? [
              {
                kind: 'item' as const,
                label: 'Zurueckstellung aufheben',
                onSelect: () => void window.api.messages.unsnooze(waiting)
              }
            ]
          : []),
        { kind: 'separator' },
        {
          kind: 'submenu',
          label: many && !sameAccount ? 'Verschieben (nur je Konto)' : 'Verschieben nach',
          icon: <IconFolder size={15} />,
          disabled: !sameAccount,
          items: targets.map((folder) => ({
            kind: 'item' as const,
            label: folderLabel(folder.name, folder.role),
            onSelect: () => doMove(items, folder.path)
          }))
        },
        {
          kind: 'item',
          label: 'Archivieren',
          icon: <IconArchive size={15} />,
          hint: 'E',
          onSelect: () => doArchive(items)
        },
        {
          kind: 'item',
          label: items.length > 1 ? `${items.length} in den Papierkorb` : 'In den Papierkorb',
          icon: <IconTrash size={15} />,
          hint: 'Entf',
          danger: true,
          onSelect: () => doDelete(items)
        }
      ]

      if (sender && !many) {
        menuItems.push(
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Absenderadresse kopieren',
            onSelect: () => {
              void window.api.copyToClipboard(sender)
              showToast(`${sender} kopiert.`)
            }
          },
          {
            kind: 'item',
            label: 'Neue Nachricht an diesen Absender',
            icon: <IconCompose size={15} />,
            onSelect: () => startCompose('new', null, sender)
          }
        )
      }

      openMenu(event, menuItems)
    },
    [
      askSnooze,
      markSeen,
      doArchive,
      doDelete,
      doMove,
      doSnooze,
      heads,
      membersOf,
      moveTargets,
      selectedIds,
      showToast,
      startCompose
    ]
  )

  const folderMenu = useCallback(
    (event: React.MouseEvent, accountId: string, folder: Folder) => {
      const account = accountsById.get(accountId)
      const items: MenuItem[] = [
        {
          kind: 'item',
          label: 'Alle als gelesen markieren',
          icon: <IconEnvelopeOpen size={15} />,
          disabled: folder.unread === 0,
          onSelect: () => {
            void act(
              () => window.api.messages.markRead({ accountId, folder: folder.path }),
              'Markieren fehlgeschlagen:'
            )
          }
        },
        {
          kind: 'item',
          label: 'Diesen Ordner abrufen',
          icon: <IconRefresh size={15} />,
          onSelect: () => void window.api.sync.refresh(accountId, folder.path)
        }
      ]

      if (folder.role === 'trash' || folder.role === 'junk') {
        items.push(
          { kind: 'separator' },
          {
            kind: 'item',
            label: folder.role === 'trash' ? 'Papierkorb leeren' : 'Spam-Ordner leeren',
            icon: <IconTrash size={15} />,
            danger: true,
            disabled: folder.total === 0,
            onSelect: () => {
              const label = folder.role === 'trash' ? 'Papierkorb' : 'Spam-Ordner'
              if (!window.confirm(`${label} von ${account?.label ?? 'diesem Konto'} endgueltig leeren? Das laesst sich nicht rueckgaengig machen.`)) return
              setSelected(null)
              setSelectedIds(new Set())
              void act(
                () => window.api.messages.emptyFolder(accountId, folder.path),
                'Leeren fehlgeschlagen:'
              )
            }
          }
        )
      }

      openMenu(event, items)
    },
    [accountsById, act]
  )

  const accountMenu = useCallback(
    (event: React.MouseEvent, accountId: string) => {
      const account = accountsById.get(accountId)
      if (!account) return
      const unread = unreadByAccount.get(accountId) ?? 0

      openMenu(event, [
        {
          kind: 'item',
          label: 'Alles als gelesen markieren',
          icon: <IconEnvelopeOpen size={15} />,
          disabled: unread === 0,
          onSelect: () =>
            void act(() => window.api.messages.markRead({ accountId }), 'Markieren fehlgeschlagen:')
        },
        {
          kind: 'item',
          label: 'Dieses Konto abrufen',
          icon: <IconRefresh size={15} />,
          onSelect: () => void window.api.sync.refresh(accountId)
        },
        {
          kind: 'item',
          label: 'Neue Nachricht von diesem Konto',
          icon: <IconCompose size={15} />,
          onSelect: () =>
            setCompose({
              mode: 'new',
              accountId,
              to: [],
              cc: [],
              subject: '',
              quotedHtml: ''
            })
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Konto bearbeiten',
          icon: <IconSettings size={15} />,
          onSelect: () => setWizard({ account })
        },
        {
          kind: 'item',
          label: 'Konto entfernen',
          icon: <IconTrash size={15} />,
          danger: true,
          onSelect: () => {
            if (!window.confirm(`${account.label} entfernen? Die lokale Kopie wird geloescht, auf dem Server bleibt alles unveraendert.`)) return
            void window.api.accounts.remove(accountId)
            setView(UNIFIED_INBOX)
            setSelected(null)
            setSelectedIds(new Set())
          }
        }
      ])
    },
    [accountsById, act, unreadByAccount]
  )

  const unifiedMenu = useCallback(
    (event: React.MouseEvent) => {
      openMenu(event, [
        {
          kind: 'item',
          label: 'Alles in allen Konten als gelesen markieren',
          icon: <IconInbox size={15} />,
          disabled: unreadTotal === 0,
          onSelect: () => {
            if (!window.confirm(`${unreadTotal} ungelesene Nachrichten in allen Konten als gelesen markieren?`)) return
            void act(() => window.api.messages.markRead({}), 'Markieren fehlgeschlagen:')
          }
        },
        {
          kind: 'item',
          label: 'Alle Konten abrufen',
          icon: <IconRefresh size={15} />,
          onSelect: () => void window.api.sync.refresh()
        }
      ])
    },
    [act, unreadTotal]
  )

  // ------------------------------------------------------- Tastaturkuerzel

  useEffect(() => {
    const off = [
      window.api.on('menu:compose', () => startCompose('new')),
      window.api.on('compose:mailto', (payload) => composeFromMailto(payload as MailtoDraft)),
      window.api.on('menu:refresh', () => void window.api.sync.refresh()),
      window.api.on('menu:settings', () => setShowSettings(true)),
      window.api.on('menu:search', () => searchInputRef.current?.focus()),
      // Klick auf eine Benachrichtigung: in den Sammelposteingang und die
      // gemeldete Mail vormerken - sie taucht auf, sobald die Liste steht.
      window.api.on('mail:open', (payload) => {
        setView(UNIFIED_INBOX)
        search.setText('')
        setPendingOpenId(typeof payload === 'string' ? payload : null)
      }),
      // Eine wartende Nachricht wurde beim Versand endgueltig abgelehnt.
      window.api.on('mail:sendFailed', (payload) => {
        const { subject, error } = (payload ?? {}) as { subject?: string; error?: string }
        showToast(
          `Senden fehlgeschlagen: ${subject || '(kein Betreff)'}. ${error ?? ''} Die Nachricht liegt im Ausgang.`,
          { label: 'Ausgang', run: () => setShowSettings(true) },
          12000
        )
      })
    ]
    return () => off.forEach((fn) => fn())
  }, [startCompose, composeFromMailto, search, showToast])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (typing || compose || wizard || showSettings || menu || timeAsk) return

      const index = selected ? heads.findIndex((m) => membersOf(m).some((x) => x.id === selected.id)) : -1
      const step = (next: MessageSummary | undefined): void => {
        if (!next) return
        event.preventDefault()
        setSelected(next)
        setSelectedIds(new Set([next.id]))
        setAnchorId(next.id)
      }

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          step(heads[Math.min(index + 1, heads.length - 1)] ?? heads[0])
          break
        case 'k':
        case 'ArrowUp':
          if (index > 0) step(heads[index - 1])
          break
        case 'a':
          if ((event.ctrlKey || event.metaKey) && heads.length) {
            event.preventDefault()
            setSelectedIds(new Set(heads.map((m) => m.id)))
            break
          }
          if (shown) {
            event.preventDefault()
            startCompose('replyAll', shown)
          }
          break
        case 'r':
          if (shown) {
            event.preventDefault()
            startCompose('reply', shown)
          }
          break
        case 'f':
          if (shown) {
            event.preventDefault()
            startCompose('forward', shown)
          }
          break
        case 'b':
          if (selection.length) {
            event.preventDefault()
            askSnooze(selection)
          }
          break
        case 'e':
          if (selection.length) {
            event.preventDefault()
            doArchive(selection)
          }
          break
        case 'Delete':
          if (selection.length) {
            event.preventDefault()
            doDelete(selection)
          }
          break
        case 's':
          if (selection.length) {
            event.preventDefault()
            const anyUnflagged = selection.some((m) => !m.flags.includes('\\Flagged'))
            void window.api.messages.setFlagged(selection, anyUnflagged)
          }
          break
        case 'u':
          if (selection.length) {
            event.preventDefault()
            void markSeen(selection, false)
            setSelected(null)
          }
          break
        case 'Escape':
          if (selectedIds.size > 1 && selected) {
            event.preventDefault()
            setSelectedIds(new Set([selected.id]))
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    askSnooze,
    markSeen,
    compose,
    doArchive,
    doDelete,
    heads,
    membersOf,
    menu,
    selected,
    selectedIds,
    selection,
    showSettings,
    shown,
    startCompose,
    timeAsk,
    wizard
  ])

  // ------------------------------------------------------------- Rendern

  if (!workspace.ready || !settings) return null

  if (!accounts.length) {
    return (
      <>
        <Welcome onAdd={() => setWizard({})} />
        {wizard && (
          <AccountWizard
            usedColors={[]}
            encryptionAvailable={encryptionAvailable}
            onClose={() => setWizard(null)}
            onSaved={() => {
              setWizard(null)
              showToast('Konto verbunden. Die Nachrichten werden jetzt geladen.')
            }}
          />
        )}
      </>
    )
  }

  const scopeAccountId =
    view.kind === 'folder' ? view.accountId : view.kind === 'search' ? view.query.accountId : undefined

  return (
    <>
      <div className="app" data-preview={settings.previewPosition} data-folders="shown">
        <AccountRail
          accounts={accounts}
          statusById={statusById}
          unreadByAccount={unreadByAccount}
          unreadTotal={unreadTotal}
          view={view}
          onSelectUnified={() => setView(UNIFIED_INBOX)}
          onSelectAccount={(accountId) => {
            const inbox = (foldersByAccount.get(accountId) ?? []).find((f) => f.role === 'inbox')
            setView(
              inbox
                ? { kind: 'folder', accountId, folder: inbox.path }
                : { kind: 'folder', accountId, folder: 'INBOX' }
            )
          }}
          onAccountContextMenu={accountMenu}
          onUnifiedContextMenu={unifiedMenu}
          onCompose={() => startCompose('new')}
          onAddAccount={() => setWizard({})}
          onSettings={() => setShowSettings(true)}
        />

        <FolderList
          accounts={accounts}
          foldersByAccount={foldersByAccount}
          view={view}
          scopeAccountId={scopeAccountId}
          onSelect={setView}
          onFolderContextMenu={folderMenu}
          onAccountContextMenu={accountMenu}
        />

        <MessageList
          rows={rows}
          threaded={threaded}
          loading={loading}
          view={effectiveView}
          accountsById={accountsById}
          folderByKey={folderByKey}
          settings={settings}
          selectedId={selected?.id ?? null}
          selectedIds={selectedIds}
          searchText={search.text}
          sync={sync}
          searchInputRef={searchInputRef}
          onSearchChange={search.setText}
          onSelect={handleSelect}
          onContextMenu={messageMenu}
          onToggleRead={(message) => {
            const members = membersOf(message)
            void markSeen(members, members.some((m) => !m.flags.includes('\\Seen')))
          }}
          onRefresh={() => void window.api.sync.refresh()}
        />

        {selectedIds.size > 1 ? (
          <BulkPanel
            count={selection.length}
            onMarkRead={() => void markSeen(selection, true)}
            onMarkUnread={() => void markSeen(selection, false)}
            onFlag={() => void window.api.messages.setFlagged(selection, true)}
            onSnooze={() => askSnooze(selection)}
            onArchive={() => doArchive(selection)}
            onDelete={() => doDelete(selection)}
            onClear={() => selected && setSelectedIds(new Set([selected.id]))}
          />
        ) : (
          <Reader
            message={shown}
            thread={thread}
            threadFolderLabel={(m) => {
              const folder = folderByKey.get(`${m.accountId}|${m.folder}`)
              return folder ? folderLabel(folder.name, folder.role) : m.folder
            }}
            onOpenThreadMessage={(m) => setThreadFocusId(m.id === selected?.id ? null : m.id)}
            onSnooze={(until) => doSnooze(readerTargets, until)}
            onAskSnooze={() => askSnooze(readerTargets)}
            onUnsnooze={() => void window.api.messages.unsnooze(readerTargets)}
            body={body}
            loading={bodyLoading}
            error={bodyError}
            account={selectedAccount}
            folder={selectedFolder}
            moveTargets={shown ? moveTargets(shown.accountId, shown.folder) : []}
            loadRemoteByDefault={settings.loadRemoteImages}
            trustedDomains={settings.remoteImageDomains}
            zoom={readerZoom}
            onZoomStep={stepReaderZoom}
            onReply={() => startCompose('reply', shown)}
            onReplyAll={() => startCompose('replyAll', shown)}
            onForward={() => startCompose('forward', shown)}
            onArchive={() => doArchive(readerTargets)}
            onDelete={() => doDelete(readerTargets)}
            onToggleFlag={() =>
              shown && void window.api.messages.setFlagged([shown], !shown.flags.includes('\\Flagged'))
            }
            onMarkUnread={() => {
              if (!shown) return
              void markSeen([shown], false)
              setSelected(null)
            }}
            onMove={(path) => doMove(readerTargets, path)}
            onTrustDomain={(domain) => {
              void workspace.updateSettings({
                remoteImageDomains: addTrustedDomain(settings.remoteImageDomains, domain)
              })
              showToast(`Bilder von ${domain} werden ab jetzt immer geladen.`)
            }}
          />
        )}
      </div>

      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}

      {compose && (
        <Composer
          accounts={accounts}
          seed={compose}
          templates={settings.templates}
          onClose={() => setCompose(null)}
          onSent={(result) => {
            setCompose(null)
            handleSent(result)
          }}
        />
      )}

      {timeAsk && (
        <TimeDialog
          title={timeAsk.title}
          confirm={timeAsk.confirm}
          onPick={timeAsk.onPick}
          onClose={() => setTimeAsk(null)}
        />
      )}

      {wizard && (
        <AccountWizard
          account={wizard.account}
          usedColors={accounts.map((a) => a.color)}
          encryptionAvailable={encryptionAvailable}
          onClose={() => setWizard(null)}
          onSaved={() => {
            setWizard(null)
            showToast(wizard.account ? 'Konto aktualisiert.' : 'Konto verbunden.')
          }}
        />
      )}

      {showSettings && (
        <SettingsDialog
          accounts={accounts}
          statusById={statusById}
          settings={settings}
          outbox={workspace.outbox}
          onEditOutbox={(id) => {
            setShowSettings(false)
            void reopenOutbox(id)
          }}
          onClose={() => setShowSettings(false)}
          folders={folders}
          onUpdate={(patch) => void workspace.updateSettings(patch)}
          onEditAccount={(account) => {
            setShowSettings(false)
            setWizard({ account })
          }}
          onAddAccount={() => {
            setShowSettings(false)
            setWizard({})
          }}
          onRemoveAccount={(account) => {
            void window.api.accounts.remove(account.id)
            if (scopeAccountId === account.id) setView(UNIFIED_INBOX)
            setSelected(null)
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toast.action?.run
                setToast(null)
                run?.()
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  )
}

/** Steht anstelle des Lesebereichs, sobald mehrere Nachrichten markiert sind. */
function BulkPanel({
  count,
  onMarkRead,
  onMarkUnread,
  onFlag,
  onSnooze,
  onArchive,
  onDelete,
  onClear
}: {
  count: number
  onMarkRead: () => void
  onMarkUnread: () => void
  onFlag: () => void
  onSnooze: () => void
  onArchive: () => void
  onDelete: () => void
  onClear: () => void
}) {
  return (
    <section className="reader" aria-label="Auswahl">
      <div className="bulk">
        <div className="bulk-inner">
          <div className="bulk-count">{count}</div>
          <p>
            Nachrichten ausgewaehlt. Rechtsklick in der Liste bietet dieselben Aktionen, inklusive
            Verschieben in einen Ordner.
          </p>
          <div className="bulk-actions">
            <button className="btn btn-outline" onClick={onMarkRead}>
              Als gelesen
            </button>
            <button className="btn btn-outline" onClick={onMarkUnread}>
              Als ungelesen
            </button>
            <button className="btn btn-outline" onClick={onFlag}>
              Markieren
            </button>
            <button className="btn btn-outline" onClick={onSnooze}>
              Zurueckstellen
            </button>
            <button className="btn btn-outline" onClick={onArchive}>
              Archivieren
            </button>
            <button className="btn btn-outline btn-danger" onClick={onDelete}>
              In den Papierkorb
            </button>
          </div>
          <button className="link-btn" style={{ marginTop: 16 }} onClick={onClear}>
            Auswahl aufheben
          </button>
        </div>
      </div>
    </section>
  )
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty" style={{ height: '100vh' }}>
      <div className="empty-inner">
        <h2>Noch kein Konto verbunden</h2>
        <p>
          Verbinde dein erstes Postfach. Gmail, iCloud, WEB.DE, GMX und alles andere mit IMAP
          funktionieren; die Servereinstellungen kommen automatisch, sobald du deine Adresse
          eintraegst.
        </p>
        <button className="btn btn-primary" onClick={onAdd}>
          Konto hinzufuegen
        </button>
      </div>
    </div>
  )
}

function prefixSubject(subject: string, prefix: string): string {
  const clean = subject.replace(/^((re|aw|antw|fwd|wg|fw)\s*(\[\d+\])?:\s*)+/i, '')
  return `${prefix}${clean}`
}

/**
 * Zitat im ueblichen Format. Der Originaltext bleibt HTML - er wurde beim
 * Anzeigen bereits bereinigt und wird beim Senden nur weitergereicht.
 */
function buildQuote(message: MessageSummary, originalHtml: string): string {
  const from = message.from.map(formatAddressFull).join(', ')
  const header = `Am ${fullDate(message.date)} schrieb ${from}:`
  const to = message.to.length ? `<div>An: ${escapeHtml(addressList(message.to, 5))}</div>` : ''
  return `<p></p><div>${escapeHtml(header)}</div>${to}<blockquote>${originalHtml}</blockquote>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
