import { useEffect, useMemo, useState } from 'react'
import type { Account, AccountDraft, ConnectionTestResult } from '@shared/types'
import { ACCOUNT_COLORS, PROVIDERS, detectProvider } from '@shared/providers'
import { isValidEmail } from '../lib/format'
import { IconClose } from './icons'

interface Props {
  /** Vorhandenes Konto bearbeiten; leer bedeutet neu anlegen */
  account?: Account
  usedColors: string[]
  encryptionAvailable: boolean
  onClose: () => void
  onSaved: (account: Account) => void
}

export function AccountWizard({ account, usedColors, encryptionAvailable, onClose, onSaved }: Props) {
  const editing = Boolean(account)
  const [email, setEmail] = useState(account?.email ?? '')
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState(account?.label ?? '')
  const [displayName, setDisplayName] = useState(account?.displayName ?? '')
  const [username, setUsername] = useState(account?.username ?? '')
  const [color, setColor] = useState(
    account?.color ?? ACCOUNT_COLORS.find((c) => !usedColors.includes(c)) ?? ACCOUNT_COLORS[0]
  )
  const [signature, setSignature] = useState(account?.signature ?? '')
  const [providerId, setProviderId] = useState(() => detectProvider(account?.email ?? '').id)
  const [imapHost, setImapHost] = useState(account?.imap.host ?? '')
  const [imapPort, setImapPort] = useState(String(account?.imap.port ?? 993))
  const [imapSecure, setImapSecure] = useState(account?.imap.secure ?? true)
  const [smtpHost, setSmtpHost] = useState(account?.smtp.host ?? '')
  const [smtpPort, setSmtpPort] = useState(String(account?.smtp.port ?? 587))
  const [smtpSecure, setSmtpSecure] = useState(account?.smtp.secure ?? false)
  const [showServers, setShowServers] = useState(editing)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const provider = useMemo(
    () => PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[PROVIDERS.length - 1],
    [providerId]
  )

  // Beim Tippen der Adresse den Anbieter erraten und die Server vorbelegen.
  useEffect(() => {
    if (editing || !email.includes('@')) return
    const detected = detectProvider(email)
    setProviderId(detected.id)
  }, [email, editing])

  useEffect(() => {
    if (provider.id === 'custom') return
    setImapHost(provider.imap.host)
    setImapPort(String(provider.imap.port))
    setImapSecure(provider.imap.secure)
    setSmtpHost(provider.smtp.host)
    setSmtpPort(String(provider.smtp.port))
    setSmtpSecure(provider.smtp.secure)
  }, [provider])

  const buildDraft = (): AccountDraft => ({
    id: account?.id,
    label: label.trim() || email.split('@')[0] || 'Konto',
    displayName: displayName.trim() || label.trim() || email,
    email: email.trim(),
    color,
    username: (username.trim() || email).trim(),
    signature,
    enabled: account?.enabled ?? true,
    imap: { host: imapHost.trim(), port: Number(imapPort) || 993, secure: imapSecure },
    smtp: { host: smtpHost.trim(), port: Number(smtpPort) || 587, secure: smtpSecure },
    password: password || undefined
  })

  const canSubmit = isValidEmail(email) && imapHost && smtpHost && (editing || password.length > 0)

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      setTestResult(await window.api.accounts.test(buildDraft()))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await window.api.accounts.save(buildDraft()))
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>{editing ? `${account?.label} bearbeiten` : 'Konto hinzufuegen'}</h2>
          <div className="spacer" />
          <button className="btn btn-icon" onClick={onClose} aria-label="Schliessen">
            <IconClose size={15} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label htmlFor="wiz-email">E-Mail-Adresse</label>
            <input
              id="wiz-email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@gmail.com"
              autoFocus={!editing}
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label htmlFor="wiz-provider">Anbieter</label>
            <select
              id="wiz-provider"
              className="select"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <p className="notice notice-info">
            {provider.hint}
            {provider.appPasswordUrl && (
              <>
                {' '}
                <button
                  className="link-btn"
                  onClick={() => void window.api.openExternal(provider.appPasswordUrl!)}
                >
                  Seite oeffnen
                </button>
              </>
            )}
          </p>

          <div className="field">
            <label htmlFor="wiz-password">{editing ? 'Neues Passwort (leer lassen behaelt das alte)' : 'Passwort'}</label>
            <input
              id="wiz-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing ? 'Unveraendert' : 'App-Passwort'}
              spellCheck={false}
            />
            {!encryptionAvailable && (
              <p className="hint" style={{ color: 'var(--danger)' }}>
                Dieses System bietet keine Passwortverschluesselung an (unter Linux fehlt meist
                libsecret oder gnome-keyring). Das Passwort landet sonst im Klartext in der
                Konfigurationsdatei.
              </p>
            )}
          </div>

          <div className="row-2">
            <div className="field">
              <label htmlFor="wiz-label">Kurzname</label>
              <input
                id="wiz-label"
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Privat"
              />
              <p className="hint">Steht in der Kontenschiene links.</p>
            </div>
            <div className="field">
              <label htmlFor="wiz-name">Absendername</label>
              <input
                id="wiz-name"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Tim Beuter"
              />
              <p className="hint">So erscheinst du bei Empfaengern.</p>
            </div>
          </div>

          <div className="field">
            <label>Farbe</label>
            <div className="swatches">
              {ACCOUNT_COLORS.map((c) => (
                <button
                  key={c}
                  className="swatch-btn"
                  style={{ background: c }}
                  aria-pressed={color === c}
                  aria-label={`Farbe ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <p className="hint">Markiert Nachrichten dieses Kontos in Sammelansichten.</p>
          </div>

          <div className="field">
            <label htmlFor="wiz-signature">Signatur</label>
            <textarea
              id="wiz-signature"
              className="input"
              rows={3}
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Viele Gruesse
Tim"
            />
          </div>

          <button className="link-btn" onClick={() => setShowServers((v) => !v)}>
            {showServers ? 'Servereinstellungen ausblenden' : 'Servereinstellungen anzeigen'}
          </button>

          {showServers && (
            <div style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="wiz-user">Benutzername</label>
                <input
                  id="wiz-user"
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={email || 'meist die volle Adresse'}
                  spellCheck={false}
                />
              </div>

              <div className="row-3">
                <div className="field">
                  <label htmlFor="wiz-imap">IMAP-Server</label>
                  <input
                    id="wiz-imap"
                    className="input"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <label htmlFor="wiz-imap-port">Port</label>
                  <input
                    id="wiz-imap-port"
                    className="input"
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wiz-imap-sec">Verschluesselung</label>
                  <select
                    id="wiz-imap-sec"
                    className="select"
                    value={imapSecure ? 'tls' : 'starttls'}
                    onChange={(e) => setImapSecure(e.target.value === 'tls')}
                  >
                    <option value="tls">TLS</option>
                    <option value="starttls">STARTTLS</option>
                  </select>
                </div>
              </div>

              <div className="row-3">
                <div className="field">
                  <label htmlFor="wiz-smtp">SMTP-Server</label>
                  <input
                    id="wiz-smtp"
                    className="input"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <label htmlFor="wiz-smtp-port">Port</label>
                  <input
                    id="wiz-smtp-port"
                    className="input"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wiz-smtp-sec">Verschluesselung</label>
                  <select
                    id="wiz-smtp-sec"
                    className="select"
                    value={smtpSecure ? 'tls' : 'starttls'}
                    onChange={(e) => setSmtpSecure(e.target.value === 'tls')}
                  >
                    <option value="tls">TLS</option>
                    <option value="starttls">STARTTLS</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {testResult && (
            <>
              <p className={`notice ${testResult.imap.ok ? 'notice-ok' : 'notice-error'}`}>
                {testResult.imap.ok ? 'IMAP: Verbindung steht.' : `IMAP: ${testResult.imap.error}`}
              </p>
              <p className={`notice ${testResult.smtp.ok ? 'notice-ok' : 'notice-error'}`}>
                {testResult.smtp.ok ? 'SMTP: Versand moeglich.' : `SMTP: ${testResult.smtp.error}`}
              </p>
            </>
          )}

          {error && <p className="notice notice-error">{error}</p>}
        </div>

        <div className="dialog-foot">
          <button className="btn btn-primary" onClick={() => void save()} disabled={!canSubmit || saving}>
            {saving ? 'Wird gespeichert' : editing ? 'Aenderungen speichern' : 'Konto hinzufuegen'}
          </button>
          <button className="btn btn-outline" onClick={() => void runTest()} disabled={!canSubmit || testing}>
            {testing ? 'Wird geprueft' : 'Verbindung testen'}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
