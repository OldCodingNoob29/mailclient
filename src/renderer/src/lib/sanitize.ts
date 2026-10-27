import DOMPurify from 'dompurify'

export interface SanitizeResult {
  html: string
  /** Anzahl blockierter externer Bilder - die Leiste oben zeigt sie an. */
  blockedRemote: number
}

const BLOCKED_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base']

/**
 * Bereitet den HTML-Teil einer Mail fuers Anzeigen auf.
 *
 * Drei Dinge passieren hier: alles Ausfuehrbare fliegt raus, Inline-Bilder
 * (cid:) werden gegen die eingebetteten Daten getauscht, und externe Bilder
 * werden geparkt, bis der Leser sie ausdruecklich anfordert. Letzteres ist
 * kein Schoenheitsdetail - externe Bilder sind das Standardwerkzeug, um das
 * Oeffnen einer Mail zu verfolgen.
 */
export function sanitizeMailHtml(
  html: string,
  inlineImages: Record<string, string>,
  allowRemote: boolean
): SanitizeResult {
  let blockedRemote = 0

  const hook = (node: Element): void => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (/^(https?|mailto):/i.test(href)) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      } else {
        node.removeAttribute('href')
      }
    }

    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      const cidMatch = /^cid:(.+)$/i.exec(src)
      if (cidMatch) {
        const embedded = inlineImages[decodeURIComponent(cidMatch[1])]
        if (embedded) node.setAttribute('src', embedded)
        else node.removeAttribute('src')
        return
      }
      if (src.startsWith('data:image/')) return
      if (/^https?:/i.test(src)) {
        if (allowRemote) return
        blockedRemote++
        node.removeAttribute('src')
        node.removeAttribute('srcset')
        node.setAttribute('data-blocked', src)
        node.setAttribute('alt', node.getAttribute('alt') || 'Externes Bild')
        return
      }
      node.removeAttribute('src')
    }

    // Hintergrundbilder sind derselbe Trick mit anderem Namen.
    if (!allowRemote) {
      const style = node.getAttribute('style')
      if (style && /url\(\s*['"]?https?:/i.test(style)) {
        blockedRemote++
        node.setAttribute('style', style.replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none'))
      }
      const background = node.getAttribute('background')
      if (background) node.removeAttribute('background')
    }
  }

  DOMPurify.addHook('afterSanitizeAttributes', hook)
  try {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: BLOCKED_TAGS,
      FORBID_ATTR: ['srcset', 'ping', 'formaction'],
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target', 'data-blocked'],
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false
    })
    return { html: clean, blockedRemote }
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

/**
 * Baut das vollstaendige Dokument fuer den iframe. Der Rahmen setzt lesbare
 * Grundwerte, ohne die Gestaltung der Mail zu ueberschreiben.
 */
export function wrapMailDocument(bodyHtml: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  /*
    Der Rahmen ist immer so hoch wie sein Inhalt, also gibt es hier nichts
    vertikal zu rollen. Wichtig ist das trotzdem: ein scrollbares Dokument
    schluckt das Mausrad, und der Lesebereich darunter bewegt sich nicht mehr.
  */
  html { -webkit-text-size-adjust: 100%; overflow-y: hidden; overflow-x: auto; }
  body {
    margin: 0;
    padding: 24px 32px 32px;
    background: #fff;
    color: #23262c;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14.5px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  img[data-blocked] {
    min-width: 16px; min-height: 16px;
    border: 1px dashed #cfd4dc; border-radius: 3px; background: #f5f6f8;
  }
  table { max-width: 100%; }
  a { color: #1f4fb8; }
  blockquote {
    margin: 12px 0; padding-left: 14px;
    border-left: 2px solid #d8dce2; color: #5a6270;
  }
  pre { white-space: pre-wrap; word-wrap: break-word; }
</style>
</head><body>${bodyHtml}</body></html>`
}

/** Wandelt reinen Text in schlichtes HTML mit klickbaren Links. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  )
}

/** Reiner Text fuer den Editor: wie textToHtml, aber Zeilenumbrueche werden zu <br>,
 *  weil der Editor (contentEditable) sie sonst zu Leerzeichen zusammenzieht. */
export function textToEditorHtml(text: string): string {
  return textToHtml(text).replace(/\r?\n/g, '<br>')
}
