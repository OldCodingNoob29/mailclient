import { useEffect, useMemo, useState } from 'react'
import type {
  Account,
  Folder,
  MailRule,
  MessageSummary,
  RuleCondition,
  RuleField,
  RuleOperator
} from '@shared/types'
import { activeConditions, isRuleUsable, matchesRule } from '@shared/rules'

interface Props {
  accounts: Account[]
  folders: Folder[]
  rules: MailRule[]
}

const FIELD_LABELS: Record<RuleField, string> = {
  from: 'Absender',
  to: 'Empfaenger',
  subject: 'Betreff'
}

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains: 'enthaelt',
  equals: 'ist genau',
  domain: 'hat die Domain'
}

/** Eine Domain gibt es nur bei Adressen. */
function operatorsFor(field: RuleField): RuleOperator[] {
  return field === 'subject' ? ['contains', 'equals'] : ['domain', 'contains', 'equals']
}

function newId(): string {
  return `regel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function blankRule(): MailRule {
  return {
    id: newId(),
    name: '',
    enabled: true,
    accountId: null,
    match: 'all',
    conditions: [{ field: 'from', op: 'domain', value: '' }],
    targetFolder: ''
  }
}

/** Die Regel als Satz, fuer die Liste. */
function describeRule(rule: MailRule, accounts: Account[]): string {
  const parts = activeConditions(rule).map(
    (c) => `${FIELD_LABELS[c.field]} ${OPERATOR_LABELS[c.op]} „${c.value.trim()}“`
  )
  const scope = rule.accountId
    ? (accounts.find((a) => a.id === rule.accountId)?.label ?? 'unbekanntes Konto')
    : 'alle Konten'
  const condition = parts.join(rule.match === 'all' ? ' und ' : ' oder ') || 'keine Bedingung'
  return `${condition} → ${rule.targetFolder || '?'} · ${scope}`
}

/** Electron verpackt Fehler aus dem Main-Prozess; der eigentliche Text steht hinten. */
function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

interface RunStatus {
  busy: boolean
  text: string
  error?: boolean
}

export function RulesPanel({ accounts, folders, rules }: Props) {
  const [draft, setDraft] = useState<MailRule | null>(null)
  const [status, setStatus] = useState<Record<string, RunStatus>>({})
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [inbox, setInbox] = useState<MessageSummary[]>([])

  // Fuer die Vorschau im Editor: was liegt gerade in den Posteingaengen?
  const editing = draft !== null
  useEffect(() => {
    if (!editing) return
    void window.api.messages.list({ kind: 'unified', id: 'inbox' }, 100000).then(setInbox)
  }, [editing])

  const previewCount = useMemo(() => {
    if (!draft) return 0
    return inbox.filter(
      (m) => (draft.accountId === null || m.accountId === draft.accountId) && matchesRule(draft, m)
    ).length
  }, [draft, inbox])

  const draftAccount = draft?.accountId
  const folderOptions = useMemo(() => {
    const pool = folders.filter(
      (f) => f.selectable && f.role !== 'inbox' && (!draftAccount || f.accountId === draftAccount)
    )
    return [...new Set(pool.map((f) => f.path))].sort((a, b) => a.localeCompare(b))
  }, [draftAccount, folders])

  const save = (next: MailRule[]): Promise<unknown> => window.api.settings.update({ rules: next })

  const run = async (rule: MailRule): Promise<void> => {
    setStatus((s) => ({ ...s, [rule.id]: { busy: true, text: 'Wird angewendet …' } }))
    try {
      const result = await window.api.rules.apply(rule.id)
      const moved =
        result.moved === 0
          ? 'Nichts Passendes im Posteingang.'
          : `${result.moved} ${result.moved === 1 ? 'Nachricht' : 'Nachrichten'} nach „${rule.targetFolder}“ verschoben.`
      setStatus((s) => ({
        ...s,
        [rule.id]: { busy: false, text: [moved, ...result.errors].join(' '), error: result.errors.length > 0 }
      }))
    } catch (err) {
      setStatus((s) => ({ ...s, [rule.id]: { busy: false, text: cleanError(err), error: true } }))
    }
  }

  const commit = async (apply: boolean): Promise<void> => {
    if (!draft) return
    const cleaned: MailRule = {
      ...draft,
      name: draft.name.trim(),
      targetFolder: draft.targetFolder.trim(),
      conditions: activeConditions(draft).map((c) => ({ ...c, value: c.value.trim() }))
    }
    const exists = rules.some((r) => r.id === cleaned.id)
    await save(exists ? rules.map((r) => (r.id === cleaned.id ? cleaned : r)) : [...rules, cleaned])
    setDraft(null)
    // Erst nach dem Speichern: der Main-Prozess liest die Regel aus den Einstellungen.
    if (apply) await run(cleaned)
  }

  const updateCondition = (index: number, patch: Partial<RuleCondition>): void => {
    setDraft((d) => {
      if (!d) return d
      const conditions = d.conditions.map((c, i) => {
        if (i !== index) return c
        const next = { ...c, ...patch }
        // Wechselt das Feld auf den Betreff, gibt es keine Domain mehr.
        if (!operatorsFor(next.field).includes(next.op)) next.op = 'contains'
        return next
      })
      return { ...d, conditions }
    })
  }

  if (draft) {
    const usable = isRuleUsable(draft)
    return (
      <div className="rule-editor">
        <div className="row-2">
          <div className="field">
            <label htmlFor="rule-name">Name</label>
            <input
              id="rule-name"
              className="input"
              value={draft.name}
              placeholder="z. B. GitHub"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="rule-account">Gilt fuer</label>
            <select
              id="rule-account"
              className="select"
              value={draft.accountId ?? ''}
              onChange={(e) => setDraft({ ...draft, accountId: e.target.value || null })}
            >
              <option value="">Posteingang aller Konten</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Posteingang von {a.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <div className="rule-match">
            Wenn
            <select
              className="select select-inline"
              value={draft.match}
              onChange={(e) => setDraft({ ...draft, match: e.target.value as MailRule['match'] })}
              aria-label="Wie viele Bedingungen zutreffen muessen"
            >
              <option value="all">alle</option>
              <option value="any">eine</option>
            </select>
            der Bedingungen zutreffen:
          </div>

          {draft.conditions.map((condition, index) => (
            <div className="rule-cond" key={index}>
              <select
                className="select"
                value={condition.field}
                onChange={(e) => updateCondition(index, { field: e.target.value as RuleField })}
                aria-label="Feld"
              >
                {(Object.keys(FIELD_LABELS) as RuleField[]).map((field) => (
                  <option key={field} value={field}>
                    {FIELD_LABELS[field]}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={condition.op}
                onChange={(e) => updateCondition(index, { op: e.target.value as RuleOperator })}
                aria-label="Vergleich"
              >
                {operatorsFor(condition.field).map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>
              <input
                className="input"
                value={condition.value}
                placeholder={
                  condition.op === 'domain'
                    ? 'github.com'
                    : condition.field === 'subject'
                      ? 'Rechnung'
                      : 'name@beispiel.de'
                }
                onChange={(e) => updateCondition(index, { value: e.target.value })}
                aria-label="Wert"
              />
              <button
                className="btn btn-icon"
                onClick={() =>
                  setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })
                }
                disabled={draft.conditions.length === 1}
                title="Bedingung entfernen"
                aria-label="Bedingung entfernen"
              >
                &times;
              </button>
            </div>
          ))}
          <button
            className="link-btn"
            onClick={() =>
              setDraft({
                ...draft,
                conditions: [...draft.conditions, { field: 'subject', op: 'contains', value: '' }]
              })
            }
          >
            + Weitere Bedingung
          </button>
        </div>

        <div className="field">
          <label htmlFor="rule-target">Verschieben nach</label>
          <input
            id="rule-target"
            className="input"
            list="rule-folders"
            value={draft.targetFolder}
            placeholder="z. B. GitHub"
            onChange={(e) => setDraft({ ...draft, targetFolder: e.target.value })}
          />
          <datalist id="rule-folders">
            {folderOptions.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <p className="hint">
            Fehlt der Ordner, wird er beim ersten Treffer angelegt. Unterordner mit &bdquo;/&ldquo;,
            etwa &bdquo;Benachrichtigungen/GitHub&ldquo;.
          </p>
        </div>

        <p className="rule-preview">
          {activeConditions(draft).length === 0
            ? 'Noch keine Bedingung mit Wert.'
            : previewCount === 0
              ? 'Im geladenen Posteingang trifft sie gerade nichts.'
              : `Im geladenen Posteingang trifft sie gerade ${previewCount} ${previewCount === 1 ? 'Nachricht' : 'Nachrichten'}.`}
        </p>

        <div className="rule-actions">
          <button className="btn" onClick={() => setDraft(null)}>
            Abbrechen
          </button>
          <button className="btn btn-outline" disabled={!usable} onClick={() => void commit(false)}>
            Speichern
          </button>
          <button className="btn btn-primary" disabled={!usable} onClick={() => void commit(true)}>
            Speichern und jetzt anwenden
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {!rules.length && (
        <p style={{ color: 'var(--ink-3)' }}>
          Noch keine Regeln. Eine Regel sortiert neue Post aus dem Posteingang in einen Ordner -
          etwa alles von GitHub in &bdquo;GitHub&ldquo;.
        </p>
      )}

      {rules.map((rule) => {
        const run_ = status[rule.id]
        return (
          <div className="rule-row" key={rule.id} data-enabled={rule.enabled}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) =>
                void save(rules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))
              }
              title={rule.enabled ? 'Regel ausschalten' : 'Regel einschalten'}
              aria-label={rule.enabled ? 'Regel ausschalten' : 'Regel einschalten'}
            />
            <div className="meta">
              <div className="name">{rule.name || rule.targetFolder || 'Regel ohne Namen'}</div>
              <div className="summary">{describeRule(rule, accounts)}</div>
              {run_ && (
                <div className="rule-status" data-error={run_.error ? 'true' : 'false'} role="status">
                  {run_.text}
                </div>
              )}
            </div>
            <div className="rule-buttons">
              <button
                className="btn btn-outline"
                disabled={run_?.busy || !isRuleUsable(rule)}
                onClick={() => void run(rule)}
              >
                Jetzt anwenden
              </button>
              <button className="btn btn-outline" onClick={() => setDraft(structuredClone(rule))}>
                Bearbeiten
              </button>
              {confirmId === rule.id ? (
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    void save(rules.filter((r) => r.id !== rule.id))
                    setConfirmId(null)
                  }}
                >
                  Wirklich entfernen
                </button>
              ) : (
                <button className="btn btn-danger" onClick={() => setConfirmId(rule.id)}>
                  Entfernen
                </button>
              )}
            </div>
          </div>
        )
      })}

      <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => setDraft(blankRule())}>
        Regel hinzufuegen
      </button>
      <p className="hint" style={{ marginTop: 12 }}>
        Regeln sortieren neue Post im Posteingang ein, sobald sie ankommt; die erste passende gewinnt.
        Einsortierte Post meldet sich nicht mit einer Benachrichtigung. &bdquo;Jetzt anwenden&ldquo;
        raeumt zusaetzlich auf, was schon im Posteingang liegt.
      </p>
    </>
  )
}
