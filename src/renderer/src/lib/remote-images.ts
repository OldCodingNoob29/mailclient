/**
 * Merken, von wem externe Bilder erlaubt sind.
 *
 * Die Entscheidung haengt an der Absenderdomain, nicht an der einzelnen Mail:
 * wer den Newsletter eines Shops einmal mit Bildern sehen will, will das beim
 * naechsten auch. Die Domain der Bild-URL waere der falsche Schluessel - die
 * zeigt bei den meisten Newslettern auf einen fremden Versanddienst, den man
 * damit fuer alle Absender freischalten wuerde.
 */

/** Domain aus einer Mailadresse, klein geschrieben. Leer, wenn unbrauchbar. */
export function senderDomain(address: string | undefined): string {
  const at = address ? address.lastIndexOf('@') : -1
  if (at < 0) return ''
  const domain = address!.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '')
  // Nur echte Namen merken - IP-Literale und Kaputtes fallen raus.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? domain : ''
}

/** Steht die Domain auf der Liste - direkt oder als Unterdomain eines Eintrags? */
export function isTrustedDomain(list: string[] | undefined, domain: string): boolean {
  if (!domain || !list?.length) return false
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`))
}

/** Domain aufnehmen und dabei aufraeumen, was sie ueberfluessig macht. */
export function addTrustedDomain(list: string[] | undefined, domain: string): string[] {
  const current = list ?? []
  if (!domain || isTrustedDomain(current, domain)) return current
  // Eine neue Oberdomain macht die bereits gemerkten Unterdomains hinfaellig.
  const kept = current.filter((entry) => !entry.endsWith(`.${domain}`))
  return [...kept, domain].sort()
}

export function removeTrustedDomain(list: string[] | undefined, domain: string): string[] {
  return (list ?? []).filter((entry) => entry !== domain)
}
