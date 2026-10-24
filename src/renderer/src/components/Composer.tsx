import { useEffect, useRef, useState } from 'react'
import type { Account, ComposeSeed, MailTemplate, OutgoingAttachment, SendResult } from '@shared/types'
import { timePresets, toLocalInput } from '@shared/times'
import { fileSize, formatAddressFull, parseAddresses } from '../lib/format'
import { AddressField } from './AddressField'
import { IconAttach, IconClose, IconSent } from './icons'

interface Props {
  accounts: Account[]
  seed: ComposeSeed
  templates: MailTemplate[]
  onClose: () => void
  onSent: (result: SendResult) => void
}

/** Vorlagentext als HTML: maskiert, Zeilenumbrueche bleiben. */
function templateHtml(body: string): string {
  return body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
}

interface AttachmentDraft extends OutgoingAttachment {
  size: number
}

/** Liest eine abgelegte oder eingefuegte Datei als Anhang ein. */
function readAttachment(file: File, filename: string): Promise<AttachmentDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({
        filename,
        content: url.slice(url.indexOf(',') + 1),
        contentType: file.type || 'application/octet-stream',
        size: file.size
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error(`${filename} liess sich nicht lesen.`))
    reader.readAsDataURL(file)
  })
}

/**
 * Chromium nennt jedes eingefuegte Bild "image.png". Drei Screenshots hiessen
 * sonst gleich - und beim Empfaenger ueberschriebe einer den anderen.
 */
function pastedName(file: File, index: number): string {
  if (file.name && file.name !== 'image.png') return file.name
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  return `Einfuegung-${stamp}${index ? `-${index + 1}` : ''}.${ext}`
}

/** Nur Ziehvorgaenge mit Dateien gehen uns etwas an - Text im Editor zieht weiter wie gewohnt. */
function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function Composer({ accounts, seed, templates, onClose, onSent }: Props) {
  const draft = seed.draft
  const [accountId, setAccountId] = useState(seed.accountId)
  const [to, setTo] = useState((draft?.to ?? seed.to).map(formatAddressFull).join(', '))
  const [cc, setCc] = useState((draft?.cc ?? seed.cc).map(formatAddressFull).join(', '))
  const [bcc, setBcc] = useState((draft?.bcc ?? seed.bcc ?? []).map(formatAddressFull).join(', '))
  const [showCc, setShowCc] = useState(seed.cc.length > 0 || Boolean(draft?.cc.length || draft?.bcc.length))
  const [subject, setSubject] = useState(seed.subject)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>(() =>
    // Die Groesse stand nie in der Nachricht; aus der base64-Laenge ergibt sie sich nahezu genau.
    (draft?.attachments ?? []).map((a) => ({ ...a, size: Math.floor((a.content.length * 3) / 4) }))
  )
  /** Eingabefeld fuer einen freien Versandtermin; null = nicht sichtbar */
  const [customAt, setCustomAt] = useState<string | null>(null)
  // Die Schreibmarke im Text. Ein Klick auf "Vorlage" nimmt dem Editor den
  // Fokus - eingesetzt wird trotzdem dort, wo zuletzt geschrieben wurde.
  const caret = useRef<Range | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // dragenter und dragleave feuern an jedem Kindelement; erst bei 0 ist der
  // Zeiger wirklich draussen. Ohne Zaehler flackert der Hinweis.
  const dragDepth = useRef(0)

  const editorRef = useRef<HTMLDivElement>(null)
  const toRef = useRef<HTMLInputElement>(null)

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (draft) {
      // Zurueckgeholt aus dem Ausgang: genau so, wie sie abgeschickt wurde.
      editor.innerHTML = draft.html
      editor.focus()
      return
    }
    const signature = account?.signature
      ? `<p></p><div>--<br>${account.signature.replace(/\n/g, '<br>')}</div>`
      : '<p></p>'
    editor.innerHTML = `${seed.bodyHtml ?? '<p><br></p>'}${signature}${seed.quotedHtml}`
    // Bei einer Antwort steht der Empfaenger schon fest, der Cursor gehoert
    // in den Text; bei einer neuen Mail ist das Adressfeld dran.
    if (seed.to.length) editor.focus()
    else toRef.current?.focus()
    // Nur beim ersten Aufbau - spaeteres Tippen darf nicht ueberschrieben werden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickAttachments = async (): Promise<void> => {
    const picked = await window.api.attachments.pick()
    setAttachments((prev) => [...prev, ...picked])
  }

  const addFiles = async (files: File[], naming: (file: File, index: number) => string): Promise<void> => {
    if (!files.length) return
    try {
      const read = await Promise.all(files.map((file, index) => readAttachment(file, naming(file, index))))
      setAttachments((prev) => [...prev, ...read])
    } catch (err) {
      setError(`Anhang konnte nicht gelesen werden: ${(err as Error).message}`)
    }
  }

  const onDragEnter = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current++
    setDragging(true)
  }

  const onDragOver = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    // Ohne preventDefault gilt die Stelle als "hier nicht ablegen".
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    // Sonst fuegt der Editor selbst etwas ein oder das Fenster will zur Datei navigieren.
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)

    // Die Eintraege nur jetzt lesen: nach dem Ereignis gibt der Browser sie nicht mehr her.
    const files: File[] = []
    let folders = 0
    for (const item of Array.from(event.dataTransfer.items)) {
      if (item.kind !== 'file') continue
      if (item.webkitGetAsEntry()?.isDirectory) {
        folders++
        continue
      }
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (folders) {
      setError(
        folders === 1
          ? 'Ordner lassen sich nicht anhaengen - bitte die Dateien darin ablegen oder den Ordner vorher zippen.'
          : `${folders} Ordner uebersprungen - Ordner lassen sich nicht anhaengen.`
      )
    }
    void addFiles(files, (file) => file.name || 'anhang')
  }

  const onPaste = (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files)
    if (!files.length) return
    const types = Array.from(event.clipboardData.types)
    const carriesText = types.includes('text/plain') || types.includes('text/html')
    // Aus Word oder dem Browser kopierter Text bringt oft ein Bild derselben
    // Stelle mit. Gemeint ist dann der Text, nicht ein Bild davon.
    if (carriesText && files.every((file) => file.type.startsWith('image/'))) return
    event.preventDefault()
    void addFiles(files, pastedName)
  }

  const rememberCaret = (): void => {
    const selection = window.getSelection()
    const editor = editorRef.current
    if (!selection?.rangeCount || !editor) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) caret.current = range.cloneRange()
  }

  const insertTemplate = (template: MailTemplate): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    if (selection) {
      const range = caret.current ?? document.createRange()
      // Ohne gemerkte Stelle: ganz an den Anfang, vor Signatur und Zitat.
      if (!caret.current) {
        range.selectNodeContents(editor)
        range.collapse(true)
      }
      selection.removeAllRanges()
      selection.addRange(range)
    }
    document.execCommand('insertHTML', false, templateHtml(template.body))
    rememberCaret()
    if (!subject.trim() && template.subject) setSubject(template.subject)
  }

  const send = async (sendAt?: number): Promise<void> => {
    setError(null)
    const recipients = parseAddresses(to)
    if (!recipients.length) {
      setError('Trage mindestens einen Empfaenger ein.')
      toRef.current?.focus()
      return
    }
    if (!account) {
      setError('Kein Konto zum Senden vorhanden.')
      return
    }

    const editor = editorRef.current
    const html = editor?.innerHTML ?? ''
    const text = editor?.innerText ?? ''

    setSending(true)
    try {
      const result = await window.api.mail.send(
        {
          accountId: account.id,
          to: recipients,
          cc: parseAddresses(cc),
          bcc: parseAddresses(bcc),
          subject: subject.trim() || '(kein Betreff)',
          html,
          text,
          attachments: attachments.map(({ size: _size, ...rest }) => rest),
          inReplyTo: seed.inReplyTo,
          references: seed.references
        },
        sendAt ? { sendAt } : undefined
      )
      onSent(result)
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
      setSending(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void send()
  }

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0)

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      // Am Overlay statt am Dialog: auch wer knapp daneben loslaesst, haengt an.
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="dialog dialog-wide compose-dialog" onKeyDown={onKeyDown} onPaste={onPaste}>
        {dragging && (
          <div className="compose-drop" aria-hidden="true">
            Loslassen, um anzuhaengen
          </div>
        )}
        <div className="dialog-head">
          <h2>{seed.mode === 'new' ? 'Neue Nachricht' : seed.subject || 'Nachricht'}</h2>
          <div className="spacer" />
          <button className="btn btn-icon" onClick={onClose} aria-label="Schliessen">
            <IconClose size={15} />
          </button>
        </div>

        <div className="compose-fields">
          <div className="compose-line">
            <label htmlFor="compose-from">Von</label>
            <select id="compose-from" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </div>

          <AddressField
            id="compose-to"
            label="An"
            value={to}
            onChange={setTo}
            inputRef={toRef}
            placeholder="name@beispiel.de"
            trailing={
              !showCc && (
                <button className="link-btn" onClick={() => setShowCc(true)}>
                  Kopie
                </button>
              )
            }
          />

          {showCc && (
            <>
              <AddressField id="compose-cc" label="Kopie" value={cc} onChange={setCc} />
              <AddressField id="compose-bcc" label="Blindkopie" value={bcc} onChange={setBcc} />
            </>
          )}

          <div className="compose-line">
            <label htmlFor="compose-subject">Betreff</label>
            <input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Worum geht es?"
            />
          </div>
        </div>

        <div
          className="compose-editor"
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Nachrichtentext"
          onBlur={rememberCaret}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
        />

        {attachments.length > 0 && (
          <div className="compose-attachments">
            {attachments.map((att, index) => (
              <span className="chip" key={`${att.filename}-${index}`}>
                {att.filename} <span style={{ color: 'var(--ink-3)' }}>{fileSize(att.size)}</span>
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                  aria-label={`${att.filename} entfernen`}
                >
                  <IconClose size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <p className="notice notice-error" style={{ margin: '12px 22px 0' }}>
            {error}
          </p>
        )}

        {customAt !== null && (
          <div className="compose-schedule">
            <label htmlFor="compose-send-at">Senden am</label>
            <input
              id="compose-send-at"
              className="input"
              type="datetime-local"
              value={customAt}
              min={toLocalInput(Date.now())}
              onChange={(e) => setCustomAt(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={sending || !(new Date(customAt).getTime() > Date.now())}
              onClick={() => void send(new Date(customAt).getTime())}
            >
              Planen
            </button>
            <button className="btn btn-outline" onClick={() => setCustomAt(null)}>
              Abbrechen
            </button>
          </div>
        )}

        <div className="dialog-foot">
          <button className="btn btn-primary" onClick={() => void send()} disabled={sending}>
            <IconSent size={15} /> {sending ? 'Wird gesendet' : 'Senden'}
          </button>
          <select
            className="btn btn-outline"
            value=""
            disabled={sending}
            onChange={(e) => {
              const value = e.target.value
              e.target.value = ''
              if (value === 'custom') setCustomAt(toLocalInput(Date.now() + 3_600_000))
              else if (value) void send(Number(value))
            }}
            aria-label="Spaeter senden"
            title="Die Nachricht wartet im Ausgang und geht zum gewaehlten Zeitpunkt raus - dafuer muss die App laufen."
          >
            <option value="">Spaeter senden</option>
            {timePresets().map((preset) => (
              <option key={preset.id} value={preset.at}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Zeitpunkt waehlen &hellip;</option>
          </select>
          <button className="btn btn-outline" onClick={() => void pickAttachments()}>
            <IconAttach size={15} /> Anhang
          </button>
          {templates.length > 0 && (
            <select
              className="btn btn-outline"
              value=""
              onChange={(e) => {
                const template = templates.find((t) => t.id === e.target.value)
                e.target.value = ''
                if (template) insertTemplate(template)
              }}
              aria-label="Vorlage einsetzen"
              title="Textbaustein an der Schreibmarke einsetzen"
            >
              <option value="">Vorlage</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          )}
          {totalSize > 0 && (
            <span style={{ fontSize: 12, color: totalSize > 20e6 ? 'var(--danger)' : 'var(--ink-3)' }}>
              {fileSize(totalSize)}
              {totalSize > 20e6 && ' - viele Server lehnen mehr als 20 MB ab'}
            </span>
          )}
          <div className="spacer" />
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Dateien hineinziehen oder mit Strg+V einfuegen &middot; Strg+Enter sendet
          </span>
        </div>
      </div>
    </div>
  )
}
