/** Ein Vorschlag fuer "spaeter": Zurueckstellen und geplanter Versand teilen sich die Liste. */
export interface TimePreset {
  id: string
  label: string
  /** Zeitpunkt in ms */
  at: number
}

function atHour(base: Date, addDays: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, 0, 0, 0)
}

/**
 * Vorschlaege relativ zu jetzt. "Heute Abend" gibt es nur, solange es noch
 * nicht Abend ist; "Montag" meint immer den naechsten, nie den heutigen.
 */
export function timePresets(now = new Date()): TimePreset[] {
  const presets: TimePreset[] = [{ id: 'hour', label: 'In einer Stunde', at: now.getTime() + 3_600_000 }]

  if (now.getHours() < 17) {
    presets.push({ id: 'evening', label: 'Heute Abend, 18 Uhr', at: atHour(now, 0, 18).getTime() })
  }
  presets.push({ id: 'tomorrow', label: 'Morgen frueh, 8 Uhr', at: atHour(now, 1, 8).getTime() })

  const untilMonday = (8 - now.getDay()) % 7 || 7
  // Ist morgen schon Montag, stuende derselbe Zeitpunkt zweimal da.
  if (untilMonday > 1) {
    presets.push({ id: 'monday', label: 'Montag, 8 Uhr', at: atHour(now, untilMonday, 8).getTime() })
  }
  return presets
}

/** Wert fuer ein <input type="datetime-local">, in Ortszeit. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
