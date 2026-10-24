import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem =
  | { kind: 'separator' }
  | {
      kind: 'item'
      label: string
      icon?: ReactNode
      /** Kuerzel rechts in der Zeile, rein informativ */
      hint?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'submenu'; label: string; icon?: ReactNode; disabled?: boolean; items: MenuItem[] }

export interface MenuRequest {
  x: number
  y: number
  items: MenuItem[]
}

interface Props {
  request: MenuRequest
  onClose: () => void
}

/**
 * Kontextmenue am Mauszeiger. Klappt an den Fensterraendern um, statt
 * abgeschnitten zu werden, und schliesst sich bei Escape, Klick daneben oder
 * wenn darunter gescrollt wird.
 */
export function ContextMenu({ request, onClose }: Props) {
  return (
    <div
      className="menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <MenuPanel items={request.items} x={request.x} y={request.y} onClose={onClose} />
    </div>
  )
}

function MenuPanel({
  items,
  x,
  y,
  onClose,
  /** Bei Untermenues: nach links aufklappen, wenn rechts kein Platz mehr ist */
  preferLeft = false
}: {
  items: MenuItem[]
  x: number
  y: number
  onClose: () => void
  preferLeft?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [subAnchor, setSubAnchor] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    let left = preferLeft ? x - width : x
    let top = y

    if (left + width > window.innerWidth - margin) left = Math.max(margin, x - width)
    if (left < margin) left = margin
    if (top + height > window.innerHeight - margin) top = Math.max(margin, y - height)
    if (top < margin) top = margin

    setPos({ left, top, ready: true })
  }, [x, y, preferLeft, items])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          if (item.kind === 'separator') return <div className="menu-sep" key={`sep-${index}`} />

          if (item.kind === 'submenu') {
            return (
              <button
                key={item.label}
                className="menu-item"
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={openSub === index}
                disabled={item.disabled || item.items.length === 0}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setSubAnchor({ left: rect.right - 3, top: rect.top - 5 })
                  setOpenSub(index)
                }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setSubAnchor({ left: rect.right - 3, top: rect.top - 5 })
                  setOpenSub(index)
                }}
              >
                <span className="menu-icon">{item.icon}</span>
                <span className="menu-label">{item.label}</span>
                <span className="menu-arrow" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 3.5 5 4.5-5 4.5" />
                  </svg>
                </span>
              </button>
            )
          }

          return (
            <button
              key={item.label}
              className={`menu-item${item.danger ? ' menu-item-danger' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => setOpenSub(null)}
              onClick={() => {
                item.onSelect()
                onClose()
              }}
            >
              <span className="menu-icon">{item.icon}</span>
              <span className="menu-label">{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          )
        })}
      </div>

      {openSub !== null && items[openSub]?.kind === 'submenu' && (
        <MenuPanel
          items={(items[openSub] as Extract<MenuItem, { kind: 'submenu' }>).items}
          x={subAnchor.left}
          y={subAnchor.top}
          onClose={onClose}
        />
      )}
    </>
  )
}
