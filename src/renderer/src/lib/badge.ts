/**
 * Zeichnet das Zaehler-Abzeichen fuer das Symbol in der Taskleiste.
 *
 * Das passiert im Renderer, weil hier ein Canvas samt Schriftsatz zur
 * Verfuegung steht - der Hauptprozess muesste die Ziffern sonst aus
 * vorgerenderten Bilddateien zusammensetzen.
 */
const SIZE = 32

export function drawBadge(count: number): string | null {
  if (count <= 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const label = count > 99 ? '99+' : String(count)

  // Dunkler Ring aussen: das Abzeichen liegt auf einer Taskleiste, deren Farbe
  // wir nicht kennen, und braucht gegen beide Extreme eine Kante.
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 0.5, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2)
  ctx.fillStyle = '#d92d20'
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const fontSize = label.length === 1 ? 21 : label.length === 2 ? 17 : 13
  ctx.font = `600 ${fontSize}px "Segoe UI", -apple-system, system-ui, sans-serif`
  // Optische statt geometrischer Mitte - Ziffern sitzen sonst zu tief.
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1)

  return canvas.toDataURL('image/png')
}
