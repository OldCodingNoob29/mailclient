import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Folder, MessageBody, MessageSummary } from '@shared/types'
import { timePresets } from '@shared/times'
import { addressList, fileSize, folderLabel, fullDate, shortDate, shortDateTime } from '../lib/format'
import { isTrustedDomain, senderDomain } from '../lib/remote-images'
import { sanitizeMailHtml, textToHtml, wrapMailDocument } from '../lib/sanitize'
import { attachZoomKeys, attachZoomWheel, type ZoomStep } from '../lib/zoom'
import {
  IconArchive,
  IconDownload,
  IconEnvelopeOpen,
  IconForward,
  IconPaperclip,
  IconReply,
  IconReplyAll,
  IconStar,
  IconStarFilled,
  IconTrash
} from './icons'

interface Props {
  message: MessageSummary | null
  body: MessageBody | null
  loading: boolean
  error: string | null
  account?: Account
  folder?: Folder
  moveTargets: Folder[]
  loadRemoteByDefault: boolean
  /** Absenderdomains, deren Bilder ohne Nachfrage geladen werden. */
  trustedDomains: string[]
  /** Vergroesserung des Nachrichteninhalts; 1 = Normalgroesse. */
  zoom: number
  onZoomStep: (step: ZoomStep) => void
  onReply: () => void
  onReplyAll: () => void
  onForward: () => void
  onArchive: () => void
  onDelete: () => void
  onToggleFlag: () => void
  onMarkUnread: () => void
  onMove: (path: string) => void
  onTrustDomain: (domain: string) => void
  /** Die Unterhaltung der Nachricht, aelteste zuerst; leer oder einzeln, wenn es keine gibt */
  thread: MessageSummary[]
  /** Ordnername einer Nachricht aus der Unterhaltung, fuer die Anzeige */
  threadFolderLabel: (message: MessageSummary) => string
  onOpenThreadMessage: (message: MessageSummary) => void
  /** Zurueckstellen bis zu einem Zeitpunkt in ms */
  onSnooze: (until: number) => void
  /** Nach einem freien Zeitpunkt fragen */
  onAskSnooze: () => void
  onUnsnooze: () => void
}

export function Reader(props: Props) {
  const { message, body, loading, error } = props
  const domain = senderDomain(message?.from[0]?.address)
  const trusted = isTrustedDomain(props.trustedDomains, domain)
  const allowedUpfront = props.loadRemoteByDefault || trusted
  const [allowRemote, setAllowRemote] = useState(allowedUpfront)

  const scrollRef = useRef<HTMLDivElement>(null)

  // Jede Nachricht entscheidet neu, ob externe Bilder geladen werden - es sei
  // denn, ihre Absenderdomain steht auf der Liste.
  useEffect(() => setAllowRemote(allowedUpfront), [message?.id, allowedUpfront])

  // Am Lesebereich, damit die Geste auch neben dem Blatt und ueber Nur-Text-
  // Mails greift; der Nachrichtenrahmen bringt seinen eigenen Griff mit.
  const onZoomStep = props.onZoomStep
  useEffect(() => {
    const node = scrollRef.current
    return node ? attachZoomWheel(node, onZoomStep) : undefined
  }, [onZoomStep, message?.id])

  if (!message) {
    return (
      <section className="reader">
        <div className="empty">
          <div className="empty-inner">
            <h2>Keine Nachricht ausgewaehlt</h2>
            <p>Waehle links eine Nachricht aus, oder schreibe mit Strg+N eine neue.</p>
          </div>
        </div>
      </section>
    )
  }

  const flagged = message.flags.includes('\\Flagged')
  const snoozed = message.snoozedUntil !== undefined && !message.snoozeOver

  return (
    <section className="reader" aria-label="Nachricht">
      <div className="reader-bar">
        <button className="btn" onClick={props.onReply}>
          <IconReply size={15} /> Antworten
        </button>
        {message.to.length + message.cc.length > 1 && (
          <button className="btn" onClick={props.onReplyAll}>
            <IconReplyAll size={15} /> Allen antworten
          </button>
        )}
        <button className="btn" onClick={props.onForward}>
          <IconForward size={15} /> Weiterleiten
        </button>

        <div className="spacer" />

        <button
          className="btn btn-icon"
          onClick={props.onToggleFlag}
          title={flagged ? 'Markierung entfernen' : 'Markieren'}
          aria-label={flagged ? 'Markierung entfernen' : 'Markieren'}
        >
          {flagged ? <IconStarFilled size={15} className="flagged" /> : <IconStar size={15} />}
        </button>
        <button
          className="btn btn-icon"
          onClick={props.onMarkUnread}
          title="Als ungelesen markieren"
          aria-label="Als ungelesen markieren"
        >
          <IconEnvelopeOpen size={15} />
        </button>
        <select
          className="btn"
          value=""
          onChange={(e) => {
            const value = e.target.value
            e.target.value = ''
            if (value === 'custom') props.onAskSnooze()
            else if (value) props.onSnooze(Number(value))
          }}
          aria-label="Zurueckstellen"
          title="Ausblenden, bis die Nachricht wieder gebraucht wird (B)"
        >
          <option value="">Zurueckstellen</option>
          {timePresets().map((preset) => (
            <option key={preset.id} value={preset.at}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Zeitpunkt waehlen &hellip;</option>
        </select>
        {props.moveTargets.length > 0 && (
          <select
            className="btn"
            value=""
            onChange={(e) => {
              if (e.target.value) props.onMove(e.target.value)
              e.target.value = ''
            }}
            aria-label="In Ordner verschieben"
            title="In Ordner verschieben"
          >
            <option value="">Verschieben</option>
            {props.moveTargets.map((f) => (
              <option key={f.path} value={f.path}>
                {folderLabel(f.name, f.role)}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-icon" onClick={props.onArchive} title="Archivieren" aria-label="Archivieren">
          <IconArchive size={15} />
        </button>
        <button
          className="btn btn-icon btn-danger"
          onClick={props.onDelete}
          title="In den Papierkorb"
          aria-label="In den Papierkorb"
        >
          <IconTrash size={15} />
        </button>
      </div>

      <div className="reader-scroll" ref={scrollRef}>
       <div className="reader-stack">
        {props.thread.length > 1 && (
          <nav className="thread" aria-label="Unterhaltung">
            <div className="thread-head">Unterhaltung &middot; {props.thread.length} Nachrichten</div>
            <div className="thread-items">
              {props.thread.map((item) => (
                <button
                  key={item.id}
                  className="thread-item"
                  aria-current={item.id === message.id}
                  data-unread={!item.flags.includes('\\Seen')}
                  onClick={() => props.onOpenThreadMessage(item)}
                >
                  <span className="who">{item.from[0]?.name || item.from[0]?.address || 'Unbekannt'}</span>
                  <span className="what">{item.snippet || item.subject}</span>
                  <span className="where">{props.threadFolderLabel(item)}</span>
                  <span className="when">{shortDate(item.date)}</span>
                </button>
              ))}
            </div>
          </nav>
        )}
        <article className="sheet" key={message.id} data-zoomed={props.zoom > 1}>
          <header className="sheet-head">
            <h1 className="sheet-subject">{message.subject}</h1>
            <div className="sheet-from">
              <span className="name">{message.from[0]?.name || message.from[0]?.address || 'Unbekannt'}</span>
              {message.from[0]?.name && <span className="addr">{message.from[0].address}</span>}
              <span className="sheet-date" title={fullDate(message.date)}>
                {fullDate(message.date)}
              </span>
            </div>
            <div className="sheet-meta">
              An {addressList(message.to, 4) || props.account?.email || 'unbekannt'}
              {message.cc.length > 0 && <> &nbsp;&middot;&nbsp; Kopie an {addressList(message.cc, 3)}</>}
            </div>
          </header>

          {snoozed && (
            <p className="snooze-notice">
              <span>Zurueckgestellt bis {shortDateTime(message.snoozedUntil!)}.</span>
              <button className="link-btn" onClick={props.onUnsnooze}>
                Jetzt zurueckholen
              </button>
            </p>
          )}

          {body && body.attachments.length > 0 && (
            <AttachmentBar message={message} body={body} />
          )}

          <MailContent
            body={body}
            loading={loading}
            error={error}
            allowRemote={allowRemote}
            domain={domain}
            zoom={props.zoom}
            onZoomStep={onZoomStep}
            onAllowRemote={() => setAllowRemote(true)}
            onTrustDomain={() => {
              setAllowRemote(true)
              props.onTrustDomain(domain)
            }}
          />
        </article>
       </div>
      </div>
    </section>
  )
}

/**
 * Anhaenge stehen ueber dem Text, nicht darunter: sie sind oft der eigentliche
 * Inhalt der Mail und sollen nicht am Ende einer langen Nachricht versauern.
 * Ein Klick oeffnet die Datei, der Knopf daneben speichert sie.
 */
function AttachmentBar({ message, body }: { message: MessageSummary; body: MessageBody }) {
  const previews = body.previews ?? {}
  const totalSize = body.attachments.reduce((sum, att) => sum + att.size, 0)

  return (
    <div className="attachments" aria-label="Anhaenge">
      <div className="attachments-head">
        <IconPaperclip size={13} />
        <span>{body.attachments.length === 1 ? '1 Anhang' : `${body.attachments.length} Anhaenge`}</span>
        <span className="size">{fileSize(totalSize)}</span>
      </div>

      <div className="attachment-row">
        {body.attachments.map((att) => {
          const preview = previews[att.partId]
          return (
            <div className="attachment" key={att.partId}>
              <button
                className="attachment-main"
                onClick={() =>
                  void window.api.attachments.open(
                    message.accountId,
                    message.folder,
                    message.uid,
                    att.partId,
                    att.filename
                  )
                }
                title={`${att.filename} oeffnen`}
              >
                <span className="attachment-thumb">
                  {preview ? (
                    <img src={preview} alt="" draggable={false} />
                  ) : (
                    <span className="attachment-ext">{typeLabel(att.filename, att.contentType)}</span>
                  )}
                </span>
                <span className="attachment-text">
                  <span className="name">{att.filename}</span>
                  <span className="size">{fileSize(att.size)}</span>
                </span>
              </button>
              <button
                className="attachment-save"
                onClick={() =>
                  void window.api.attachments.save(
                    message.accountId,
                    message.folder,
                    message.uid,
                    att.partId,
                    att.filename
                  )
                }
                title={`${att.filename} speichern`}
                aria-label={`${att.filename} speichern`}
              >
                <IconDownload size={15} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Kurzes Kuerzel fuer Dateien ohne Bildvorschau, z. B. "PDF". */
function typeLabel(filename: string, contentType: string): string {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1]
  const fromType = contentType.split('/')[1]?.split(/[;+]/)[0]
  return (fromName || fromType || 'Datei').toUpperCase().slice(0, 4)
}

function MailContent({
  body,
  loading,
  error,
  allowRemote,
  domain,
  zoom,
  onZoomStep,
  onAllowRemote,
  onTrustDomain
}: {
  body: MessageBody | null
  loading: boolean
  error: string | null
  allowRemote: boolean
  /** Absenderdomain, leer wenn sie sich nicht bestimmen liess. */
  domain: string
  zoom: number
  onZoomStep: (step: ZoomStep) => void
  onAllowRemote: () => void
  onTrustDomain: () => void
}) {
  const prepared = useMemo(() => {
    if (!body) return null
    if (body.html) {
      const { html, blockedRemote } = sanitizeMailHtml(body.html, body.inlineImages, allowRemote)
      return { doc: wrapMailDocument(html), blockedRemote, plain: null as string | null }
    }
    return { doc: null, blockedRemote: 0, plain: body.text ?? '' }
  }, [body, allowRemote])

  if (loading && !body) {
    return <div className="plain-body">Wird geladen&hellip;</div>
  }
  if (error) {
    return <div className="plain-body">{error}</div>
  }
  if (!prepared) {
    return <div className="plain-body">Diese Nachricht hat keinen Inhalt.</div>
  }

  return (
    <div className="sheet-body">
      {prepared.blockedRemote > 0 && (
        <p className="remote-notice">
          <span>
            {prepared.blockedRemote === 1
              ? 'Ein externes Bild wurde blockiert.'
              : `${prepared.blockedRemote} externe Bilder wurden blockiert.`}{' '}
            Absender erkennen daran, wann du eine Mail oeffnest.
          </span>
          <span className="remote-actions">
            <button className="link-btn" onClick={onAllowRemote}>
              Bilder laden
            </button>
            {domain && (
              <button
                className="link-btn"
                onClick={onTrustDomain}
                title={`Bilder von ${domain} kuenftig ohne Nachfrage laden`}
              >
                Immer von {domain}
              </button>
            )}
          </span>
        </p>
      )}
      {prepared.doc ? (
        <MailFrame html={prepared.doc} zoom={zoom} onZoomStep={onZoomStep} />
      ) : (
        <div
          className="plain-body"
          style={{ zoom }}
          // Der Text wurde beim Umwandeln maskiert; nur die erkannten Links sind HTML.
          dangerouslySetInnerHTML={{ __html: textToHtml(prepared.plain ?? '') }}
        />
      )}
    </div>
  )
}

/**
 * Nachrichteninhalt in einem iframe ohne allow-scripts: nichts aus der Mail
 * kann laufen. allow-same-origin bleibt drin, damit die Hoehe messbar ist -
 * ohne allow-scripts ist das ungefaehrlich, weil es nichts gibt, was den
 * Zugriff nutzen koennte.
 */
function MailFrame({
  html,
  zoom,
  onZoomStep
}: {
  html: string
  zoom: number
  onZoomStep: (step: ZoomStep) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(320)
  /** Breite des Blatts; so breit wird die Mail gesetzt, bevor sie vergroessert wird. */
  const [baseWidth, setBaseWidth] = useState(0)
  const baseWidthRef = useRef(0)
  baseWidthRef.current = baseWidth

  // Ueber Referenzen, damit ein Zoomschritt oder ein neuer Rueckruf nicht das
  // ganze Dokument neu bindet - das wuerde die Mail neu aufbauen.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const stepRef = useRef(onZoomStep)
  stepRef.current = onZoomStep

  /*
    Zwei Masse, beide in Bildschirmpixeln und beide unabhaengig davon, wie hoch
    der Rahmen gerade ist - sonst koennte die Hoehe nur wachsen und beim
    Verkleinern bliebe ein weisses Feld unter der Mail stehen.

    Das erste ist der Koerper der Nachricht; seine Hoehe richtet sich nach dem
    Inhalt, nicht nach dem Rahmen. Das zweite faengt Inhalt, der aus dem Koerper
    herauslaeuft, und wird am kurz zusammengefalteten Rahmen genommen; gezeichnet
    wird dazwischen nicht, weil beide Zuweisungen in derselben Aufgabe stehen.

    body.scrollHeight taugt fuer keines von beiden: es zaehlt im eigenen Massstab
    des vergroesserten Elements und meldete bei 70% weiterhin die volle Hoehe.
  */
  /*
    Reinzoomen statt umbrechen: die Mail behaelt das Layout der Normalgroesse und
    wird als Ganzes groesser, damit auch Bilder wachsen - sonst deckelt sie
    max-width: 100% bei der Blattbreite. Der Rahmen waechst mit, und der
    Lesebereich scrollt in beide Richtungen. Verkleinern bricht normal um.
  */
  const applyZoom = useCallback((doc: Document): void => {
    if (!doc.body) return
    const zoom = zoomRef.current
    doc.body.style.zoom = String(zoom)
    const fixed = zoom > 1 && baseWidthRef.current > 0
    doc.body.style.boxSizing = fixed ? 'border-box' : ''
    doc.body.style.width = fixed ? `${baseWidthRef.current}px` : ''
  }, [])

  const measure = useCallback((): void => {
    const iframe = ref.current
    const doc = iframe?.contentDocument
    const root = doc?.documentElement
    if (!iframe || !root) return
    const koerper = doc?.body?.getBoundingClientRect().height ?? 0
    const gesetzt = iframe.style.height
    iframe.style.height = '0px'
    const ueberlauf = root.scrollHeight
    iframe.style.height = gesetzt
    // 40000px als Notbremse gegen Mails mit absurd langen Anhaengen im Body.
    // Aufgerundet: ein halber Pixel zu wenig schneidet die letzte Zeile an.
    setHeight(Math.ceil(Math.min(Math.max(koerper, ueberlauf, 80), 40000)))
  }, [])

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    let observer: ResizeObserver | null = null
    let timers: number[] = []
    let detachZoom: (() => void) | null = null

    const release = (): void => {
      observer?.disconnect()
      observer = null
      detachZoom?.()
      detachZoom = null
      for (const id of timers) window.clearTimeout(id)
      timers = []
    }

    /*
      Ein srcDoc-Rahmen durchlaeuft zwei Dokumente: erst ein leeres, dann die
      Mail - und beide melden "load". Gebunden wird deshalb jedes Mal neu, sonst
      haengen Messung und Zoomgriff am weggeworfenen ersten Dokument. Die Hoehe
      muss stimmen, weil der Rahmen bewusst nicht selbst scrollt; Bilder,
      Schriften und spaet gesetzte Breiten aendern sie noch, daher das mehrfache
      Nachmessen.
    */
    const bind = (): void => {
      release()
      const doc = iframe.contentDocument
      if (!doc?.documentElement) return
      applyZoom(doc)
      measure()
      // Rad und Tasten auch im Nachrichtendokument: hat es den Eingabefokus,
      // sieht das Fenster von beidem nichts.
      const zoomAb = [
        attachZoomWheel(doc, (step) => stepRef.current(step)),
        attachZoomKeys(doc, (step) => stepRef.current(step))
      ]
      detachZoom = () => zoomAb.forEach((ab) => ab())
      observer = new ResizeObserver(measure)
      observer.observe(doc.documentElement)
      if (doc.body) observer.observe(doc.body)
      for (const img of Array.from(doc.images)) {
        if (!img.complete) {
          img.addEventListener('load', measure, { once: true })
          img.addEventListener('error', measure, { once: true })
        }
      }
      timers = [120, 500, 1500].map((ms) => window.setTimeout(measure, ms))
    }

    iframe.addEventListener('load', bind)
    // Falls das Dokument schon steht, bevor der Griff hier haengt.
    bind()
    return () => {
      iframe.removeEventListener('load', bind)
      release()
    }
  }, [applyZoom, html, measure])

  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const read = (): void => setBaseWidth(parent.clientWidth)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  // Die Vergroesserung sitzt im Mail-Dokument, damit sie Text und Bilder der
  // Nachricht trifft und sonst nichts. Danach ist die Mail hoeher oder
  // niedriger als vorher - der Rahmen muss mitwachsen.
  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.body) return
    applyZoom(doc)
    measure()
  }, [applyZoom, baseWidth, zoom, html, measure])

  return (
    <iframe
      ref={ref}
      title="Nachrichteninhalt"
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height, width: zoom > 1 && baseWidth ? Math.ceil(baseWidth * zoom) : undefined }}
    />
  )
}
