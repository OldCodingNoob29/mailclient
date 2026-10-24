import { useState } from 'react'
import type { MailTemplate } from '@shared/types'

interface Props {
  templates: MailTemplate[]
  onChange: (templates: MailTemplate[]) => void
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Textbausteine fuer den Verfassen-Dialog. Gespeichert wird erst mit
 * "Speichern" - halb getippte Vorlagen sollen nicht im Auswahlmenue auftauchen.
 */
export function TemplatesPanel({ templates, onChange }: Props) {
  const [editing, setEditing] = useState<MailTemplate | null>(null)

  const save = (): void => {
    if (!editing) return
    const clean = { ...editing, name: editing.name.trim(), subject: editing.subject.trim() }
    const exists = templates.some((t) => t.id === clean.id)
    onChange(exists ? templates.map((t) => (t.id === clean.id ? clean : t)) : [...templates, clean])
    setEditing(null)
  }

  if (editing) {
    const usable = editing.name.trim() && editing.body.trim()
    return (
      <div className="template-editor">
        <div className="field">
          <label htmlFor="tpl-name">Name</label>
          <input
            id="tpl-name"
            className="input"
            value={editing.name}
            placeholder="z. B. Terminbestaetigung"
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="tpl-subject">Betreff (optional)</label>
          <input
            id="tpl-subject"
            className="input"
            value={editing.subject}
            onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
          />
          <p className="hint">Wird nur eingesetzt, wenn die Betreffzeile noch leer ist.</p>
        </div>
        <div className="field">
          <label htmlFor="tpl-body">Text</label>
          <textarea
            id="tpl-body"
            className="input template-body"
            rows={9}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
        </div>
        <div className="rule-actions">
          <button className="btn btn-primary" onClick={save} disabled={!usable}>
            Speichern
          </button>
          <button className="btn btn-outline" onClick={() => setEditing(null)}>
            Abbrechen
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {!templates.length && (
        <p style={{ color: 'var(--ink-3)' }}>
          Noch keine Vorlagen. Eine Vorlage ist ein Text, den du immer wieder schreibst - im
          Verfassen-Dialog setzt du ihn ueber &bdquo;Vorlage&ldquo; an der Schreibmarke ein.
        </p>
      )}
      {templates.map((template) => (
        <div className="account-row" key={template.id}>
          <div className="meta">
            <div className="name">{template.name}</div>
            <div className="addr">{template.body.replace(/\s+/g, ' ').slice(0, 90)}</div>
          </div>
          <button className="btn btn-outline" onClick={() => setEditing(template)}>
            Bearbeiten
          </button>
          <button
            className="btn btn-danger"
            onClick={() => onChange(templates.filter((t) => t.id !== template.id))}
          >
            Loeschen
          </button>
        </div>
      ))}
      <button
        className="btn btn-primary"
        style={{ marginTop: 8 }}
        onClick={() => setEditing({ id: newId(), name: '', subject: '', body: '' })}
      >
        Vorlage anlegen
      </button>
    </>
  )
}
