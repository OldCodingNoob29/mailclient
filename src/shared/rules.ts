import type { MailRule, MessageSummary, RuleCondition } from './types'

/**
 * Wann eine Regel eine Nachricht trifft. Liegt in shared, weil beide Seiten es
 * brauchen: der Main-Prozess zum Verschieben, die Oberflaeche fuer die Vorschau
 * "trifft derzeit auf N Nachrichten zu" - und die darf nicht anders zaehlen als
 * das, was hinterher tatsaechlich passiert.
 */

/** Bedingungen ohne Wert zaehlen nicht - ein leeres Feld soll nicht alles treffen. */
export function activeConditions(rule: MailRule): RuleCondition[] {
  return rule.conditions.filter((c) => c.value.trim())
}

/** Ohne Ziel oder ohne Bedingung darf eine Regel nie laufen: sie traefe nichts oder alles. */
export function isRuleUsable(rule: MailRule): boolean {
  return Boolean(rule.targetFolder.trim()) && activeConditions(rule).length > 0
}

export function matchesRule(rule: MailRule, msg: MessageSummary): boolean {
  const conditions = activeConditions(rule)
  if (!conditions.length) return false
  const test = (condition: RuleCondition): boolean => matchesCondition(condition, msg)
  return rule.match === 'all' ? conditions.every(test) : conditions.some(test)
}

function matchesCondition(condition: RuleCondition, msg: MessageSummary): boolean {
  const needle = condition.value.trim().toLowerCase()

  if (condition.field === 'subject') {
    const subject = msg.subject.toLowerCase()
    return condition.op === 'equals' ? subject === needle : subject.includes(needle)
  }

  // "Empfaenger" meint jeden, der die Mail offen bekommen hat - An und Kopie.
  const people = condition.field === 'from' ? msg.from : [...msg.to, ...msg.cc]
  return people.some((person) => {
    const address = (person.address ?? '').toLowerCase()
    switch (condition.op) {
      case 'equals':
        return address === needle
      case 'domain': {
        const domain = needle.replace(/^@/, '')
        const host = address.split('@')[1] ?? ''
        // Unterdomains zaehlen mit: "github.com" deckt "noreply.github.com".
        return host === domain || host.endsWith(`.${domain}`)
      }
      default:
        return address.includes(needle) || (person.name ?? '').toLowerCase().includes(needle)
    }
  })
}
