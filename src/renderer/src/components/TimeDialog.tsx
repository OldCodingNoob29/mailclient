import { useState } from 'react'
import { toLocalInput } from '@shared/times'
import { IconClose } from './icons'

interface Props {
  title: string
  /** Beschriftung des Knopfes, der den Zeitpunkt uebernimmt */
  confirm: string
  onPick: (at: number) => void
  onClose: () => void
}

/** Fragt nach einem freien Zeitpunkt - fuer Zurueckstellen und geplanten Versand. */
export function TimeDialog({ title, confirm, onPick, onClose }: Props) {
  const [value, setValue] = useState(() => toLocalInput(Date.now() + 3_600_000))
  const at = new Date(value).getTime()
  const valid = Number.isFinite(at) && at > Date.now()

  const submit = (): void => {
    if (!valid) return
    onPick(at)
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog dialog-small"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter') submit()
        }}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn btn-icon" onClick={onClose} aria-label="Schliessen">
            <IconClose size={15} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label htmlFor="time-dialog-at">Datum und Uhrzeit</label>
            <input
              id="time-dialog-at"
              className="input"
              type="datetime-local"
              value={value}
              min={toLocalInput(Date.now())}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            {!valid && <p className="hint">Der Zeitpunkt muss in der Zukunft liegen.</p>}
          </div>
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <button className="btn btn-outline" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!valid}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
