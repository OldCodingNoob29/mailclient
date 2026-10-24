import type { Account, Folder, ViewRef } from '@shared/types'
import { folderLabel } from '../lib/format'
import {
  IconArchive,
  IconClock,
  IconDraft,
  IconEnvelopeOpen,
  IconFolder,
  IconInbox,
  IconJunk,
  IconPaperclip,
  IconSent,
  IconStar,
  IconTrash
} from './icons'

interface Props {
  accounts: Account[]
  foldersByAccount: Map<string, Folder[]>
  view: ViewRef
  /** Nur dieses Konto zeigen; leer bedeutet Sammelansicht ueber alle Konten */
  scopeAccountId?: string
  onSelect: (view: ViewRef) => void
  onFolderContextMenu: (event: React.MouseEvent, accountId: string, folder: Folder) => void
  onAccountContextMenu: (event: React.MouseEvent, accountId: string) => void
}

function roleIcon(role: string) {
  switch (role) {
    case 'inbox':
      return <IconInbox className="folder-icon" />
    case 'sent':
      return <IconSent className="folder-icon" />
    case 'drafts':
      return <IconDraft className="folder-icon" />
    case 'trash':
      return <IconTrash className="folder-icon" />
    case 'junk':
      return <IconJunk className="folder-icon" />
    case 'archive':
      return <IconArchive className="folder-icon" />
    default:
      return <IconFolder className="folder-icon" />
  }
}

export function FolderList({
  accounts,
  foldersByAccount,
  view,
  scopeAccountId,
  onSelect,
  onFolderContextMenu,
  onAccountContextMenu
}: Props) {
  const scoped = scopeAccountId ? accounts.filter((a) => a.id === scopeAccountId) : accounts
  const account = scopeAccountId ? accounts.find((a) => a.id === scopeAccountId) : undefined

  const isCurrentFolder = (accountId: string, path: string): boolean =>
    view.kind === 'folder' && view.accountId === accountId && view.folder === path

  return (
    <aside className="folders" aria-label="Ordner">
      <div
        className="folders-head"
        onContextMenu={(e) => account && onAccountContextMenu(e, account.id)}
      >
        <h1 className="folders-title">{account ? account.label : 'Alle Konten'}</h1>
        <p className="folders-sub">{account ? account.email : `${accounts.length} Konten verbunden`}</p>
      </div>

      <div className="folders-scroll">
        {!scopeAccountId && (
          <div className="folder-group">
            <button
              className="folder-item"
              aria-current={view.kind === 'unified' && view.id === 'inbox'}
              onClick={() => onSelect({ kind: 'unified', id: 'inbox' })}
            >
              <IconInbox className="folder-icon" />
              <span className="label">Posteingang</span>
            </button>
            <button
              className="folder-item"
              aria-current={view.kind === 'unified' && view.id === 'unread'}
              onClick={() => onSelect({ kind: 'unified', id: 'unread' })}
            >
              <IconEnvelopeOpen className="folder-icon" />
              <span className="label">Ungelesen</span>
            </button>
            <button
              className="folder-item"
              aria-current={view.kind === 'unified' && view.id === 'flagged'}
              onClick={() => onSelect({ kind: 'unified', id: 'flagged' })}
            >
              <IconStar className="folder-icon" />
              <span className="label">Markiert</span>
            </button>
            <button
              className="folder-item"
              aria-current={view.kind === 'unified' && view.id === 'snoozed'}
              onClick={() => onSelect({ kind: 'unified', id: 'snoozed' })}
            >
              <IconClock className="folder-icon" />
              <span className="label">Zurueckgestellt</span>
            </button>
            <button
              className="folder-item"
              aria-current={view.kind === 'unified' && view.id === 'attachments'}
              onClick={() => onSelect({ kind: 'unified', id: 'attachments' })}
            >
              <IconPaperclip className="folder-icon" />
              <span className="label">Anhaenge</span>
            </button>
          </div>
        )}

        {scoped.map((acc) => {
          const folders = (foldersByAccount.get(acc.id) ?? []).filter((f) => f.selectable && !f.hidden)
          if (!folders.length) return null
          return (
            <div className="folder-group" key={acc.id}>
              {!scopeAccountId && (
                <div
                  className="folder-group-label"
                  onContextMenu={(e) => onAccountContextMenu(e, acc.id)}
                >
                  <span className="swatch" style={{ background: acc.color }} />
                  {acc.label}
                </div>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  className="folder-item"
                  aria-current={isCurrentFolder(acc.id, folder.path)}
                  data-unread={folder.unread > 0 && folder.role !== 'drafts'}
                  style={{ paddingLeft: `${8 + Math.min(folder.depth, 3) * 12}px` }}
                  onClick={() => onSelect({ kind: 'folder', accountId: acc.id, folder: folder.path })}
                  onContextMenu={(e) => onFolderContextMenu(e, acc.id, folder)}
                  title={folder.path}
                >
                  {roleIcon(folder.role)}
                  <span className="label">{folderLabel(folder.name, folder.role)}</span>
                  {folder.unread > 0 && <span className="count">{folder.unread}</span>}
                  {folder.unread === 0 && folder.role === 'drafts' && folder.total > 0 && (
                    <span className="count">{folder.total}</span>
                  )}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
