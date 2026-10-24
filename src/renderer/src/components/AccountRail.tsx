import type { Account, AccountStatus, ViewRef } from '@shared/types'
import { initials } from '../lib/format'
import { IconCompose, IconLayers, IconPlus, IconSettings } from './icons'

interface Props {
  accounts: Account[]
  statusById: Map<string, AccountStatus>
  unreadByAccount: Map<string, number>
  unreadTotal: number
  view: ViewRef
  onSelectUnified: () => void
  onSelectAccount: (accountId: string) => void
  onAccountContextMenu: (event: React.MouseEvent, accountId: string) => void
  onUnifiedContextMenu: (event: React.MouseEvent) => void
  onCompose: () => void
  onAddAccount: () => void
  onSettings: () => void
}

/**
 * Die Kontenschiene traegt die Identitaet der App: jedes Konto hat eine feste
 * Farbe, und dieselbe Farbe markiert spaeter dessen Nachrichten im
 * Sammelposteingang. Ein Klick wechselt den Kontext der ganzen Oberflaeche.
 */
export function AccountRail({
  accounts,
  statusById,
  unreadByAccount,
  unreadTotal,
  view,
  onSelectUnified,
  onSelectAccount,
  onAccountContextMenu,
  onUnifiedContextMenu,
  onCompose,
  onAddAccount,
  onSettings
}: Props) {
  const activeAccountId =
    view.kind === 'folder' ? view.accountId : view.kind === 'search' ? view.query.accountId : undefined
  const unifiedActive = view.kind === 'unified'

  return (
    <nav className="rail" aria-label="Konten">
      <button className="btn-compose" onClick={onCompose} title="Neue Nachricht (Strg+N)">
        <IconCompose size={17} />
      </button>

      <div className="rail-divider" />

      <button
        className="rail-tile"
        aria-pressed={unifiedActive}
        onClick={onSelectUnified}
        onContextMenu={onUnifiedContextMenu}
        title="Alle Konten zusammen"
        style={{ ['--tile-color' as string]: 'var(--ink-3)' }}
      >
        <IconLayers size={17} />
        {unreadTotal > 0 && <span className="rail-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
      </button>

      {accounts.map((account) => {
        const status = statusById.get(account.id)
        const unread = unreadByAccount.get(account.id) ?? 0
        return (
          <button
            key={account.id}
            className="rail-tile"
            aria-pressed={activeAccountId === account.id}
            data-error={status?.phase === 'error'}
            onClick={() => onSelectAccount(account.id)}
            onContextMenu={(event) => onAccountContextMenu(event, account.id)}
            title={`${account.label} - ${account.email}${status?.message ? `\n${status.message}` : ''}`}
            style={{ ['--tile-color' as string]: account.color }}
          >
            {initials(account.label || account.email)}
            {unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        )
      })}

      <button className="rail-tile" onClick={onAddAccount} title="Konto hinzufuegen">
        <IconPlus size={16} />
      </button>

      <div className="rail-spacer" />

      <button className="rail-tile" onClick={onSettings} title="Einstellungen (Strg+,)">
        <IconSettings size={16} />
      </button>
    </nav>
  )
}
