import { useEffect, useId, useRef, useState } from 'react'
import type { Contact } from '@shared/types'
import { formatAddressFull } from '../lib/format'

interface Props {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  /** Wird rechts neben dem Feld gezeigt, etwa der Knopf "Kopie". */
  trailing?: React.ReactNode
}

/**
 * Empfaengerfeld mit Vorschlaegen aus dem Adressbuch.
 *
 * Das Adressbuch pflegt niemand - es entsteht im Hauptprozess aus den Mails,
 * die ohnehin da sind. Vervollstaendigt wird immer nur der letzte Eintrag der
 * Zeile, alles vor dem letzten Komma bleibt unangetastet.
 */
export function AddressField(props: Props) {
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  /** Der Anteil hinter dem letzten Komma - nur der wird gesucht und ersetzt. */
  const fragment = props.value.slice(props.value.lastIndexOf(',') + 1).trim()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.contacts.suggest(fragment).then((list) => {
        if (cancelled) return
        setSuggestions(list)
        setActive(list.length ? 0 : -1)
      })
    }, 90)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fragment, open])

  // Ein Klick ausserhalb schliesst die Liste, ohne etwas zu uebernehmen.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const apply = (contact: Contact): void => {
    const cut = props.value.lastIndexOf(',')
    const head = cut < 0 ? '' : `${props.value.slice(0, cut + 1)} `
    props.onChange(`${head}${formatAddressFull({ name: contact.name, address: contact.address })}, `)
    setOpen(false)
    setSuggestions([])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open || !suggestions.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (active < 0) return
      // Enter im offenen Vorschlagsfeld uebernimmt, statt die Mail zu senden.
      event.preventDefault()
      event.stopPropagation()
      apply(suggestions[active])
      return
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  const visible = open && suggestions.length > 0

  return (
    <div className="compose-line">
      <label htmlFor={props.id}>{props.label}</label>
      <div className="address-box" ref={boxRef}>
        <input
          id={props.id}
          ref={props.inputRef}
          value={props.value}
          placeholder={props.placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={visible}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            props.onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {visible && (
          <ul className="address-suggestions" id={listId} role="listbox">
            {suggestions.map((contact, index) => (
              <li
                key={contact.address}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                // mousedown statt click: sonst verliert das Feld vorher den Fokus.
                onMouseDown={(event) => {
                  event.preventDefault()
                  apply(contact)
                }}
              >
                <span className="name">{contact.name || contact.address}</span>
                {contact.name && <span className="addr">{contact.address}</span>}
                {contact.written && <span className="mark">geschrieben</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.trailing}
    </div>
  )
}
