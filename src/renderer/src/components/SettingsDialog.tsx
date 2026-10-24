import { useState } from 'react'
import type { Account, AccountStatus, Folder, OutboxItem, Settings } from '@shared/types'
import { fullDate } from '../lib/format'
import { removeTrustedDomain } from '../lib/remote-images'
import { IconClose } from './icons'
import { RulesPanel } from './RulesPanel'
import { TemplatesPanel } from './TemplatesPanel'

interface Props {
  accounts: Account[]
  folders: Folder[]
  statusById: Map<string, AccountStatus>
  settings: Settings
  outbox: OutboxItem[]
  /** Holt einen Eintrag aus dem Ausgang in den Verfassen-Dialog zurueck */
  onEditOutbox: (id: string) => void
  onClose: () => void
  onUpdate: (patch: Partial<Settings>) => void
  onEditAccount: (account: Account) => void
  onAddAccount: () => void
  onRemoveAccount: (account: Account) => void
}

type Tab = 'accounts' | 'rules' | 'templates' | 'display' | 'outbox'

/** Eine Zeile, die sagt, worauf ein Eintrag im Ausgang wartet. */
function outboxState(entry: OutboxItem): { text: string; problem: boolean } {
  if (entry.failed) {
    return { text: `Vom Server abgelehnt${entry.lastError ? ` - ${entry.lastError}` : ''}`, problem: true }
  }
  if (entry.kind === 'scheduled' && entry.sendAt) {
    return { text: `Geplant fuer ${fullDate(entry.sendAt)}`, problem: false }
  }
  if (entry.kind === 'undo') return { text: 'Geht gleich raus', problem: false }
  return {
    text: `${entry.attempts} Versuche${entry.lastError ? ` - ${entry.lastError}` : ''}`,
    problem: true
  }
}

export function SettingsDialog(props: Props) {
  const [tab, setTab] = useState<Tab>('accounts')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>Einstellungen</h2>
          <div className="spacer" />
          <button className="btn btn-icon" onClick={props.onClose} aria-label="Schliessen">
            <IconClose size={15} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}>
              Konten
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>
              Regeln{props.settings.rules.length > 0 ? ` (${props.settings.rules.length})` : ''}
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>
              Vorlagen{props.settings.templates.length > 0 ? ` (${props.settings.templates.length})` : ''}
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'display'} onClick={() => setTab('display')}>
              Darstellung
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'outbox'} onClick={() => setTab('outbox')}>
              Ausgang{props.outbox.length > 0 ? ` (${props.outbox.length})` : ''}
            </button>
          </div>

          {tab === 'accounts' && (
            <>
              {props.accounts.map((account) => {
                const status = props.statusById.get(account.id)
                return (
                  <div className="account-row" key={account.id}>
                    <span className="spine" style={{ background: account.color }} />
                    <div className="meta">
                      <div className="name">{account.label}</div>
                      <div className="addr">{account.email}</div>
                      {status?.phase === 'error' && (
                        <div className="addr" style={{ color: 'var(--danger)' }}>
                          {status.message}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-outline" onClick={() => props.onEditAccount(account)}>
                      Bearbeiten
                    </button>
                    {confirmId === account.id ? (
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          props.onRemoveAccount(account)
                          setConfirmId(null)
                        }}
                      >
                        Wirklich entfernen
                      </button>
                    ) : (
                      <button className="btn btn-danger" onClick={() => setConfirmId(account.id)}>
                        Entfernen
                      </button>
                    )}
                  </div>
                )
              })}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={props.onAddAccount}>
                Konto hinzufuegen
              </button>
              <p className="hint" style={{ marginTop: 12 }}>
                Beim Entfernen wird nur die lokale Kopie geloescht. Auf dem Server bleibt alles, wie
                es ist.
              </p>
            </>
          )}

          {tab === 'rules' && (
            <RulesPanel accounts={props.accounts} folders={props.folders} rules={props.settings.rules} />
          )}

          {tab === 'templates' && (
            <TemplatesPanel
              templates={props.settings.templates}
              onChange={(templates) => props.onUpdate({ templates })}
            />
          )}

          {tab === 'display' && (
            <>
              <div className="field">
                <label htmlFor="set-theme">Erscheinungsbild</label>
                <select
                  id="set-theme"
                  className="select"
                  value={props.settings.theme}
                  onChange={(e) => props.onUpdate({ theme: e.target.value as Settings['theme'] })}
                >
                  <option value="system">Wie das System</option>
                  <option value="light">Hell</option>
                  <option value="dark">Dunkel</option>
                </select>
              </div>

              <div className="row-2">
                <div className="field">
                  <label htmlFor="set-density">Zeilenhoehe der Liste</label>
                  <select
                    id="set-density"
                    className="select"
                    value={props.settings.density}
                    onChange={(e) => props.onUpdate({ density: e.target.value as Settings['density'] })}
                  >
                    <option value="comfortable">Luftig, mit Vorschautext</option>
                    <option value="compact">Kompakt</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="set-preview">Lesebereich</label>
                  <select
                    id="set-preview"
                    className="select"
                    value={props.settings.previewPosition}
                    onChange={(e) =>
                      props.onUpdate({ previewPosition: e.target.value as Settings['previewPosition'] })
                    }
                  >
                    <option value="right">Rechts neben der Liste</option>
                    <option value="bottom">Unter der Liste</option>
                  </select>
                </div>
              </div>

              <div className="row-2">
                <div className="field">
                  <label htmlFor="set-interval">Abrufintervall</label>
                  <select
                    id="set-interval"
                    className="select"
                    value={String(props.settings.syncIntervalSec)}
                    onChange={(e) => props.onUpdate({ syncIntervalSec: Number(e.target.value) })}
                  >
                    <option value="60">Jede Minute</option>
                    <option value="300">Alle 5 Minuten</option>
                    <option value="900">Alle 15 Minuten</option>
                    <option value="3600">Stuendlich</option>
                  </select>
                  <p className="hint">
                    Der Posteingang kommt ohnehin sofort an, solange die Verbindung steht. Das
                    Intervall gilt fuer die uebrigen Ordner.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="set-count">Nachrichten je Ordner</label>
                  <select
                    id="set-count"
                    className="select"
                    value={String(props.settings.initialFetchCount)}
                    onChange={(e) => props.onUpdate({ initialFetchCount: Number(e.target.value) })}
                  >
                    <option value="200">200</option>
                    <option value="400">400</option>
                    <option value="1000">1000</option>
                    <option value="3000">3000</option>
                  </select>
                  <p className="hint">Mehr bedeutet vollstaendigere Suche, aber laengeres Abgleichen.</p>
                </div>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={props.settings.loadRemoteImages}
                  onChange={(e) => props.onUpdate({ loadRemoteImages: e.target.checked })}
                />
                <span>
                  Externe Bilder sofort laden
                  <br />
                  <span className="check-hint">
                    Ohne diesen Haken bleiben Bilder blockiert, bis du sie anforderst. Werbemails
                    erkennen sonst, wann und wie oft du sie oeffnest.
                  </span>
                </span>
              </label>

              {!props.settings.loadRemoteImages && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Bilder immer laden von</label>
                  {props.settings.remoteImageDomains.length ? (
                    <div className="domain-list">
                      {props.settings.remoteImageDomains.map((domain) => (
                        <span className="domain" key={domain}>
                          {domain}
                          <button
                            onClick={() =>
                              props.onUpdate({
                                remoteImageDomains: removeTrustedDomain(
                                  props.settings.remoteImageDomains,
                                  domain
                                )
                              })
                            }
                            title={`${domain} wieder blockieren`}
                            aria-label={`${domain} wieder blockieren`}
                          >
                            &times;
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="hint">
                      Noch keine. In der Leseansicht steht neben der Bildwarnung
                      &bdquo;Immer von &hellip;&ldquo; - damit landet die Absenderdomain hier.
                    </p>
                  )}
                </div>
              )}

              <label className="check" style={{ marginTop: 14 }}>
                <input
                  type="checkbox"
                  checked={props.settings.threadView}
                  onChange={(e) => props.onUpdate({ threadView: e.target.checked })}
                />
                <span>
                  Unterhaltungen zusammenfassen
                  <br />
                  <span className="check-hint">
                    Mails, die aufeinander antworten, stehen als eine Zeile in der Liste. Die
                    Leseansicht zeigt den ganzen Verlauf, auch deine eigenen Antworten.
                  </span>
                </span>
              </label>

              <h3 className="section-title">Senden</h3>

              <div className="field">
                <label htmlFor="set-undo">Versand zurueckholen</label>
                <select
                  id="set-undo"
                  className="select"
                  value={String(props.settings.undoSendSec)}
                  onChange={(e) => props.onUpdate({ undoSendSec: Number(e.target.value) })}
                >
                  <option value="0">Aus - sofort senden</option>
                  <option value="5">5 Sekunden</option>
                  <option value="10">10 Sekunden</option>
                  <option value="20">20 Sekunden</option>
                  <option value="30">30 Sekunden</option>
                </select>
                <p className="hint">
                  So lange wartet eine Nachricht nach &bdquo;Senden&ldquo; im Ausgang und laesst sich
                  mit einem Klick zurueckholen.
                </p>
              </div>

              <h3 className="section-title">Im Hintergrund</h3>

              <label className="check">
                <input
                  type="checkbox"
                  checked={props.settings.runInTray}
                  onChange={(e) => props.onUpdate({ runInTray: e.target.checked })}
                />
                <span>
                  Beim Schliessen weiterlaufen
                  <br />
                  <span className="check-hint">
                    Das Fenster verschwindet, die App bleibt als Symbol neben der Uhr und holt
                    weiter Post ab. Ohne diesen Haken beendet das Kreuz die App - dann kommt
                    nichts mehr an, solange sie zu ist.
                  </span>
                </span>
              </label>

              <label className="check">
                <input
                  type="checkbox"
                  checked={props.settings.startWithSystem}
                  onChange={(e) => props.onUpdate({ startWithSystem: e.target.checked })}
                />
                <span>
                  Mit dem Rechner starten
                  <br />
                  <span className="check-hint">
                    Faehrt beim Anmelden still im Hintergrund mit hoch, ohne Fenster.
                  </span>
                </span>
              </label>

              <label className="check">
                <input
                  type="checkbox"
                  checked={props.settings.notifyOnNewMail}
                  onChange={(e) => props.onUpdate({ notifyOnNewMail: e.target.checked })}
                />
                <span>
                  Bei neuer Post Bescheid geben
                  <br />
                  <span className="check-hint">
                    Kurze Meldung mit Absender und Betreff, nur fuer ungelesene Post im
                    Posteingang. Ein Klick darauf oeffnet die Nachricht.
                  </span>
                </span>
              </label>

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="set-markread">Als gelesen markieren</label>
                <select
                  id="set-markread"
                  className="select"
                  value={String(props.settings.markReadAfterMs)}
                  onChange={(e) => props.onUpdate({ markReadAfterMs: Number(e.target.value) })}
                >
                  <option value="0">Sofort beim Oeffnen</option>
                  <option value="1200">Nach gut einer Sekunde</option>
                  <option value="4000">Nach vier Sekunden</option>
                  <option value="-1">Nie automatisch</option>
                </select>
              </div>
            </>
          )}

          {tab === 'outbox' && (
            <>
              {!props.outbox.length && (
                <p style={{ color: 'var(--ink-3)' }}>
                  Nichts wartet. Hier liegen geplante Nachrichten bis zu ihrem Termin, und alles,
                  was am Netz gescheitert ist - das wird von selbst erneut versucht.
                </p>
              )}
              {props.outbox.map((entry) => {
                const account = props.accounts.find((a) => a.id === entry.accountId)
                const state = outboxState(entry)
                return (
                  <div className="account-row" key={entry.id}>
                    <span className="spine" style={{ background: account?.color ?? 'var(--line-strong)' }} />
                    <div className="meta">
                      <div className="name">{entry.subject || '(kein Betreff)'}</div>
                      <div className="addr">An {entry.recipients.join(', ')}</div>
                      <div className="addr" style={state.problem ? { color: 'var(--danger)' } : undefined}>
                        {state.text}
                      </div>
                    </div>
                    {entry.editable && (
                      <button className="btn btn-outline" onClick={() => props.onEditOutbox(entry.id)}>
                        Bearbeiten
                      </button>
                    )}
                    {(entry.kind === 'scheduled' || entry.failed) && (
                      <button className="btn btn-outline" onClick={() => void window.api.outbox.sendNow(entry.id)}>
                        Jetzt senden
                      </button>
                    )}
                    <button className="btn btn-danger" onClick={() => void window.api.outbox.discard(entry.id)}>
                      Verwerfen
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div className="dialog-foot">
          <div className="spacer" />
          <button className="btn btn-primary" onClick={props.onClose}>
            Fertig
          </button>
        </div>
      </div>
    </div>
  )
}
