import { useEffect, useRef, useState } from 'react'
import type { Account, Folder, MessageSummary, Settings, ViewRef } from '@shared/types'
import type { ThreadRow } from '@shared/threads'
import { listPartner, shortDate, shortDateTime } from '../lib/format'
import type { SyncFeedback } from '../state'
import { IconClock, IconPaperclip, IconRefresh, IconSearch, IconStarFilled } from './icons'

interface Props {
  /** Eine Zeile je Unterhaltung; ohne Zusammenfassen hat jede Zeile genau eine Mail */
  rows: ThreadRow[]
  /** Zaehler fuer Unterhaltungen zeigen */
  threaded: boolean
  loading: boolean
  view: ViewRef
  accountsById: Map<string, Account>
  folderByKey: Map<string, Folder>
  settings: Settings
  selectedId: string | null
  /** Alle markierten Nachrichten; enthaelt selectedId immer mit */
  selectedIds: Set<string>
  searchText: string
  sync: SyncFeedback
  onSearchChange: (value: string) => void
  onSelect: (message: MessageSummary, event: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent, message: MessageSummary) => void
  onToggleRead: (message: MessageSummary) => void
  onRefresh: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}

export function MessageList({
  rows,
  threaded,
  loading,
  view,
  accountsById,
  folderByKey,
  settings,
  selectedId,
  selectedIds,
  searchText,
  sync,
  onSearchChange,
  onSelect,
  onContextMenu,
  onToggleRead,
  onRefresh,
  searchInputRef
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  /*
    Der zuletzt gezeigte Text bleibt stehen, auch wenn die Meldung schon vorbei
    ist: sonst waere die Beschriftung weg, bevor der Knopf zusammengefahren ist,
    und es klappte eine leere Flaeche zu.
  */
  const [lastLabel, setLastLabel] = useState('')
  useEffect(() => {
    if (sync.label) setLastLabel(sync.label)
  }, [sync.label])

  // Beim Wechsel der Ansicht wieder nach oben - sonst landet man mitten in
  // einer fremden Liste.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [view])

  // In einem einzelnen Ordner ist die Kontofarbe redundant.
  const showAccountMarker = view.kind !== 'folder'
  const attachmentView = view.kind === 'unified' && view.id === 'attachments'

  return (
    <section className="list" data-density={settings.density} aria-label="Nachrichten">
      <div className="list-head">
        <div className="search">
          <IconSearch size={14} />
          <input
            ref={searchInputRef}
            type="search"
            value={searchText}
            placeholder="Durchsuchen"
            title={'Suchkuerzel: von:name  an:name  betreff:wort  datei:name  hat:anhang  ist:ungelesen  ist:markiert  vor:2026-01-31  nach:31.12.2025'}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Nachrichten durchsuchen"
          />
        </div>
        <button
          className="refresh-btn"
          data-tone={sync.tone}
          data-open={Boolean(sync.label)}
          onClick={onRefresh}
          title={sync.label ? `${sync.label} - Jetzt abrufen (Strg+R)` : 'Jetzt abrufen (Strg+R)'}
          aria-label="Jetzt abrufen"
        >
          <IconRefresh size={19} className={sync.busy ? 'spin' : undefined} />
          {/* Steht immer im Baum, damit sich die Breite animieren laesst. */}
          <span className="refresh-label" role="status">
            {sync.label ?? lastLabel}
          </span>
        </button>
      </div>

      <div className="list-scroll" ref={scrollRef} role="listbox" aria-label="Nachrichtenliste">
        {rows.map((row) => {
          const msg = row.head
          const account = accountsById.get(msg.accountId)
          const folder = folderByKey.get(`${msg.accountId}|${msg.folder}`)
          const unread = row.members.some((m) => !m.flags.includes('\\Seen'))
          const flagged = row.members.some((m) => m.flags.includes('\\Flagged'))
          // Die Zahl meint die ganze Unterhaltung, auch was in Gesendet liegt.
          const count = threaded ? Math.max(row.members.length, msg.threadSize ?? 1) : 1
          const files = attachmentView ? (msg.attachmentNames ?? []).join(', ') : ''
          return (
            <div
              key={msg.id}
              className="row"
              role="option"
              tabIndex={-1}
              aria-selected={row.members.some((m) => m.id === selectedId)}
              data-unread={unread}
              data-show-account={showAccountMarker}
              data-multi={selectedIds.size > 1 && selectedIds.has(msg.id)}
              style={{ ['--row-color' as string]: account?.color ?? 'transparent' }}
              onClick={(event) => onSelect(msg, event)}
              onContextMenu={(event) => onContextMenu(event, msg)}
            >
              <button
                className="row-dot"
                title={unread ? 'Als gelesen markieren' : 'Als ungelesen markieren'}
                aria-label={unread ? 'Als gelesen markieren' : 'Als ungelesen markieren'}
                aria-pressed={unread}
                onClick={(event) => {
                  // Der Punkt schaltet nur den Status um; die Zeile darunter
                  // soll sich davon nicht ausgewaehlt fuehlen.
                  event.stopPropagation()
                  onToggleRead(msg)
                }}
              />
              <div className="row-top">
                <span className="row-sender">{listPartner(msg, folder?.role)}</span>
                {count > 1 && (
                  <span className="row-count" title={`Unterhaltung mit ${count} Nachrichten`}>
                    {count}
                  </span>
                )}
                <span className="row-date">{shortDate(msg.date)}</span>
              </div>
              <div className="row-subject">
                <span className="text">{msg.subject}</span>
                <span className="row-marks">
                  {msg.snoozedUntil !== undefined && (
                    <span className="row-snooze" data-over={Boolean(msg.snoozeOver)}>
                      <IconClock size={12} />
                      {msg.snoozeOver ? 'Wieder da' : `bis ${shortDateTime(msg.snoozedUntil)}`}
                    </span>
                  )}
                  {row.members.some((m) => m.hasAttachments) && <IconPaperclip size={13} />}
                  {flagged && <IconStarFilled size={13} className="flagged" />}
                </span>
              </div>
              {settings.density === 'comfortable' && (
                <div className="row-snippet">
                  {files || msg.snippet || (unread ? 'Wird geladen' : 'Kein Vorschautext')}
                </div>
              )}
            </div>
          )
        })}

        {!rows.length && !loading && <EmptyList view={view} searchText={searchText} />}
      </div>
    </section>
  )
}

function EmptyList({ view, searchText }: { view: ViewRef; searchText: string }) {
  if (searchText.trim()) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <h2>Nichts gefunden</h2>
          <p>
            Kein Treffer fuer &bdquo;{searchText}&ldquo;. Die Suche laeuft ueber alles, was schon
            heruntergeladen ist, und fragt zusaetzlich den Server. Eingrenzen laesst sie sich mit
            Kuerzeln wie <code>von:anna</code>, <code>hat:anhang</code> oder <code>nach:2026-01-31</code>.
          </p>
        </div>
      </div>
    )
  }

  const text =
    view.kind === 'unified' && view.id === 'unread'
      ? 'Alles gelesen.'
      : view.kind === 'unified' && view.id === 'flagged'
        ? 'Noch nichts markiert. Der Stern in der Leseansicht legt Nachrichten hier ab.'
        : view.kind === 'unified' && view.id === 'snoozed'
          ? 'Nichts zurueckgestellt. Die Uhr in der Leseansicht blendet eine Nachricht aus, bis du sie brauchst.'
          : view.kind === 'unified' && view.id === 'attachments'
            ? 'Keine Nachricht mit Anhang.'
            : 'Dieser Ordner ist leer.'

  return (
    <div className="empty">
      <div className="empty-inner">
        <h2>Nichts da</h2>
        <p>{text}</p>
      </div>
    </div>
  )
}
