/**
 * Strg+Mausrad vergroessert den Nachrichteninhalt - Text und Bilder der Mail,
 * nicht die Oberfläche ringsum. Listen, Ordner und Leisten behalten ihre
 * Groesse, damit sich nur das aendert, was man gerade liest.
 *
 * Der Griff muss an jedem Dokument einzeln haengen: der Nachrichtentext steckt
 * in einem eigenen Dokument, dessen Radereignisse das Fenster nie erreichen.
 */

/** Radweg fuer eine Stufe; eine Rastung des Mausrades liefert etwa 100. */
const STEP_DELTA = 100

/** Die waehlbaren Groessen. 1 ist die Normalgroesse. */
const ZOOM_STOPS = [0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5]

export type ZoomStep = 'in' | 'out' | 'reset'

/** Naechste Stufe in der gewuenschten Richtung, an den Enden unveraendert. */
export function nextZoom(current: number, step: ZoomStep): number {
  if (step === 'reset') return 1
  // Der gespeicherte Wert muss keine Stufe treffen: die naechstgelegene zaehlt.
  const nearest = ZOOM_STOPS.reduce((best, stop) =>
    Math.abs(stop - current) < Math.abs(best - current) ? stop : best
  )
  const index = ZOOM_STOPS.indexOf(nearest) + (step === 'in' ? 1 : -1)
  return ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, index))]
}

/** Haelt einen gespeicherten Wert im gueltigen Bereich. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(ZOOM_STOPS[0], Math.min(ZOOM_STOPS[ZOOM_STOPS.length - 1], value))
}

export function attachZoomWheel(target: EventTarget, onStep: (step: ZoomStep) => void): () => void {
  let travelled = 0

  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent
    if (!wheel.ctrlKey || wheel.deltaY === 0) return
    // Sonst scrollt der Lesebereich zusaetzlich zum Vergroessern.
    wheel.preventDefault()

    // Richtungswechsel faengt neu an, damit ein Zurueckdrehen sofort greift.
    if (Math.sign(wheel.deltaY) !== Math.sign(travelled)) travelled = 0
    travelled += wheel.deltaY

    while (travelled <= -STEP_DELTA) {
      travelled += STEP_DELTA
      onStep('in')
    }
    while (travelled >= STEP_DELTA) {
      travelled -= STEP_DELTA
      onStep('out')
    }
  }

  target.addEventListener('wheel', onWheel, { passive: false })
  return () => target.removeEventListener('wheel', onWheel)
}

/**
 * Strg+Plus, Strg+Minus, Strg+0 - dieselben Schritte ueber die Tastatur.
 *
 * Das laeuft hier und nicht ueber die Menuekuerzel, weil Electron "CmdOrCtrl+Plus"
 * nicht ausloest: weder die Plustaste noch die des Ziffernblocks kommen an,
 * waehrend Minus und Null tadellos gehen. Statt einer Mischung aus Menuekuerzel
 * und Notloesung liegen alle drei am selben Ort - und ueber e.code trifft es
 * auch Tastaturen, auf denen das Pluszeichen woanders sitzt.
 */
export function attachZoomKeys(target: EventTarget, onStep: (step: ZoomStep) => void): () => void {
  const onKey = (event: Event): void => {
    const key = event as KeyboardEvent
    if (!key.ctrlKey || key.altKey || key.metaKey) return

    const step: ZoomStep | null =
      key.key === '+' || key.key === '=' || key.code === 'NumpadAdd'
        ? 'in'
        : key.key === '-' || key.key === '_' || key.code === 'NumpadSubtract'
          ? 'out'
          : key.key === '0' || key.code === 'Numpad0'
            ? 'reset'
            : null
    if (!step) return

    key.preventDefault()
    onStep(step)
  }

  target.addEventListener('keydown', onKey)
  return () => target.removeEventListener('keydown', onKey)
}
