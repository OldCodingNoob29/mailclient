/*
  Ende-zu-Ende-Test gegen einen lokalen Mailserver (GreenMail in Docker).

    docker run -d --name mailclient-greenmail -p 3465:3465 -p 3993:3993 -p 8080:8080 \
      -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
      greenmail/standalone:2.1.3
    npm run build && node tests/e2e.mjs

  Der Test startet die App mit einem eigenen, leeren Datenverzeichnis und einem
  unsichtbaren Fenster - die echten Konten bleiben unberuehrt. Er legt zwei
  Postfaecher an (tim@ und anna@test.local), bespielt sie und bedient dann die
  Oberflaeche wie ein Mensch.
*/
import { _electron as electron } from 'playwright-core'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
process.removeAllListeners('warning')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(root, 'tests', 'shots')
fs.mkdirSync(shots, { recursive: true })

const HOST = '127.0.0.1'
const TIM = 'tim@test.local'
const ANNA = 'anna@test.local'
const only = process.argv.slice(2)

// ------------------------------------------------------------ Hilfsmittel

const results = []
async function check(name, fn) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok    ${name} (${Date.now() - started} ms)`)
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`  FEHLER ${name}\n         ${String(err.message).split('\n').join('\n         ')}`)
    await shot(`fehler-${name.replace(/[^a-z0-9]+/gi, '-')}`)
  }
  await reset()
}

/** Bildschirmfoto fuer die Durchsicht. Scheitert es (unsichtbares Fenster), ist das kein Testfehler. */
async function shot(name) {
  await page?.screenshot({ path: path.join(shots, `${name}.png`), timeout: 5000 }).catch(() => {})
}

/** Zurueck in den Sammelposteingang, ohne offenen Dialog und ohne Suchbegriff. */
async function reset() {
  if (!page) return
  try {
    for (let i = 0; i < 3 && (await page.locator('.overlay, .menu-backdrop').count()); i++) {
      await page.keyboard.press('Escape')
      const done = page.locator('.dialog-foot .btn-primary', { hasText: 'Fertig' })
      if (await done.count()) await done.click({ timeout: 1000 }).catch(() => {})
      await sleep(150)
    }
    if (await page.locator('.search input').count()) {
      if (await page.inputValue('.search input')) await search('')
      // Aus einem Kontoordner zurueck in die Sammelansicht - nur dort stehen deren Eintraege.
      await page.click('.rail-tile[title="Alle Konten zusammen"]', { timeout: 2000 })
      await folderItem('Posteingang').click({ timeout: 2000 })
    }
  } catch {
    /* der naechste Test meldet, was nicht stimmt */
  }
}

async function openSettings(tab) {
  await page.click('.rail-tile[title^="Einstellungen"]')
  await page.waitForSelector('.tabs')
  await page.locator('.tab', { hasText: tab }).click()
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await sleep(200)
  }
  throw new Error(`${message} (zuletzt: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

async function imap(user) {
  const client = new ImapFlow({
    host: HOST,
    port: 3993,
    secure: true,
    auth: { user, pass: 'geheim' },
    logger: false,
    tls: { rejectUnauthorized: false }
  })
  client.on('error', () => {})
  await client.connect()
  return client
}

/** Betreffzeilen eines Ordners, direkt vom Server. */
async function subjects(user, folder = 'INBOX') {
  const client = await imap(user)
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      const out = []
      if (client.mailbox.exists) {
        for await (const msg of client.fetch('1:*', { envelope: true, flags: true })) {
          out.push({ subject: msg.envelope.subject, seen: msg.flags.has('\\Seen'), flagged: msg.flags.has('\\Flagged') })
        }
      }
      return out
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
async function raw(options) {
  return (await builder.sendMail(options)).message
}

const mail = (from, to, subject, extra = {}) => ({
  from: `${from.split('@')[0]} <${from}>`,
  to,
  subject,
  text: extra.text ?? `Text von ${subject}`,
  ...extra
})

// ---------------------------------------------------------------- Bestand

async function seed() {
  await fetch('http://localhost:8080/api/mail/purge', { method: 'POST' })
  const tim = await imap(TIM)
  const anna = await imap(ANNA)
  await anna.logout()

  // Dazu Gmails Sichten: dort liegen Kopien, die nie doppelt erscheinen duerfen.
  const folders = ['Sent', 'Trash', 'Archive', 'Drafts', 'Arbeit', '[Gmail]/All Mail', '[Gmail]/Important', '[Gmail]/Starred']
  for (const folder of folders) {
    await tim.mailboxCreate(folder).catch(() => {})
  }
  // Reste frueherer Laeufe aus den Nebenordnern entfernen.
  for (const folder of ['INBOX', ...folders]) {
    const lock = await tim.getMailboxLock(folder)
    try {
      if (tim.mailbox.exists) await tim.messageDelete('1:*')
    } finally {
      lock.release()
    }
  }

  const now = Date.now()
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000)
  const put = async (folder, options, flags = []) =>
    tim.append(folder, await raw(options), flags, options.date)

  // Eine alte Unterhaltung, deren Anfang ausserhalb des lokal geholten Fensters liegt:
  // danach kommen mehr als 200 Fuellmails.
  await put('INBOX', mail(ANNA, TIM, 'Altes Thema', { messageId: '<alt-1@test.local>', date: new Date('2019-03-01T10:00:00Z'), text: 'Der Anfang der alten Unterhaltung.' }), ['\\Seen'])
  for (let i = 0; i < 205; i++) {
    await put('INBOX', mail('fuell@test.local', TIM, `Fuellmail ${i}`, { date: new Date(Date.UTC(2021, 0, 1, 0, i)) }), ['\\Seen'])
  }

  // Unterhaltung ueber Posteingang und Gesendet.
  await put('INBOX', mail(ANNA, TIM, 'Projektplan', { messageId: '<plan-1@test.local>', date: at(300), text: 'Hier ist der Projektplan.' }), ['\\Seen'])
  await put('Sent', mail(TIM, ANNA, 'Re: Projektplan', { messageId: '<plan-2@test.local>', inReplyTo: '<plan-1@test.local>', references: ['<plan-1@test.local>'], date: at(240), text: 'Danke, ich schaue ihn mir an - Antwort von Tim.' }), ['\\Seen'])
  await put('INBOX', mail(ANNA, TIM, 'Re: Projektplan', { messageId: '<plan-3@test.local>', inReplyTo: '<plan-2@test.local>', references: ['<plan-1@test.local>', '<plan-2@test.local>'], date: at(200), text: 'Super, dann bis Montag.' }))

  await put('INBOX', mail(ANNA, TIM, 'Re: Altes Thema', { messageId: '<alt-2@test.local>', inReplyTo: '<alt-1@test.local>', references: ['<alt-1@test.local>'], date: at(180), text: 'Nachtrag zum alten Thema.' }), ['\\Seen'])

  await put('INBOX', mail('buchhaltung@firma.example', TIM, 'Rechnung 4711', { date: at(120), text: 'Im Anhang die Rechnung.', attachments: [{ filename: 'rechnung-4711.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }] }), ['\\Seen'])
  await put('INBOX', mail('news@shop.example', TIM, 'Newsletter Herbst', { date: at(90), text: 'Neue Angebote im Herbst.' }), ['\\Seen'])
  await put('INBOX', mail(ANNA, TIM, 'Mittagessen', { date: at(60), text: 'Gehen wir morgen essen?' }))
  await put('INBOX', mail('chef@firma.example', TIM, 'Bitte um Rueckruf', { date: at(30), text: 'Ruf mich bitte an.' }), ['\\Seen'])

  // Eine Mail mit Gmail-Label: dieselbe Nachricht im Posteingang, im Label-Ordner
  // und in den Sichten "Alle Nachrichten" und "Wichtig".
  const meeting = mail(ANNA, TIM, 'Teammeeting', { messageId: '<meeting@test.local>', date: at(45), text: 'Morgen um zehn.' })
  for (const folder of ['INBOX', 'Arbeit', '[Gmail]/All Mail', '[Gmail]/Important']) await put(folder, meeting)
  await put('[Gmail]/All Mail', mail(ANNA, TIM, 'Nur in Alle Nachrichten', { date: at(40) }))
  await tim.logout()
}

// -------------------------------------------------------------------- App

let app
let page

const rowBySubject = (text) => page.locator('.row', { has: page.locator('.row-subject .text', { hasText: text }) })
const rowTexts = () => page.locator('.row .row-subject .text').allTextContents()
const folderItem = (label) => page.locator('.folder-item', { hasText: label }).first()
const toast = () => page.locator('.toast')

async function search(text) {
  await page.fill('.search input', text)
  // Die Eingabe wird entprellt und die Liste danach neu geholt.
  await sleep(700)
}

async function openComposer() {
  await page.click('.btn-compose')
  await page.waitForSelector('.compose-dialog')
}

async function fillComposer({ to, subject, body }) {
  await page.fill('#compose-to', to)
  await page.fill('#compose-subject', subject)
  await page.click('.compose-editor')
  await page.keyboard.press('Control+Home')
  await page.keyboard.type(body)
}

async function start(userData) {
  app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.', `--user-data-dir=${userData}`, '--hidden', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    cwd: root,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.log('  [seitenfehler]', err.message))
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
}

async function main() {
  console.log('Bestand anlegen ...')
  await seed()

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mailclient-e2e-'))
  console.log(`App starten (Daten: ${userData}) ...`)
  await start(userData)

  // Einstellungen vor dem Konto, damit schon der erste Abgleich das kleine Fenster nimmt.
  await page.evaluate(() =>
    window.api.settings.update({ initialFetchCount: 200, notifyOnNewMail: false, undoSendSec: 3, runInTray: false })
  )
  await page.evaluate(
    ([email, host]) =>
      window.api.accounts.save({
        label: 'Test',
        displayName: 'Tim Test',
        email,
        color: '#2f5bd0',
        imap: { host, port: 3993, secure: true },
        smtp: { host, port: 3465, secure: true },
        username: email,
        signature: 'Tim',
        enabled: true,
        password: 'geheim'
      }),
    [TIM, HOST]
  )
  await page.reload()
  await page.waitForSelector('.row', { timeout: 60000 })
  await until(async () => (await rowTexts()).some((t) => t.includes('Bitte um Rueckruf')), 'Posteingang wurde nicht geladen', 60000)
  // Der erste Abgleich laeuft noch durch die uebrigen Ordner.
  await until(
    () => page.evaluate(() => window.api.accounts.statuses().then((s) => s.every((x) => x.phase === 'idle'))),
    'Konto kommt nicht zur Ruhe',
    90000
  )
  await shot('01-start')

  console.log('Gmail-Sichten und Doppelte')
  await check('Sichten: "All Mail", "Important", "Starred" stehen nicht in der Ordnerliste', async () => {
    const labels = await page.locator('.folder-item .label').allTextContents()
    expect(labels.includes('Arbeit'), `Label-Ordner "Arbeit" fehlt: ${labels}`)
    for (const hidden of ['All Mail', 'Important', 'Starred']) {
      expect(!labels.includes(hidden), `"${hidden}" steht in der Ordnerliste`)
    }
  })

  await check('Sichten: werden nicht abgeglichen', async () => {
    const found = await page.evaluate(() =>
      window.api.messages.list({ kind: 'search', query: { text: 'betreff:"nur in alle"' } }).then((l) => l.length)
    )
    expect(found === 0, `Mail, die nur in "All Mail" liegt, ist lokal vorhanden (${found})`)
  })

  await check('Doppelte: dieselbe Mail steht in Sammelansicht und Suche nur einmal', async () => {
    await folderItem('Ungelesen').click()
    await until(async () => (await rowTexts()).length > 0, 'Ungelesen bleibt leer')
    const unread = (await rowTexts()).filter((t) => t === 'Teammeeting').length
    expect(unread === 1, `"Teammeeting" steht ${unread}-mal unter Ungelesen`)
    await folderItem('Posteingang').click()
    await search('teammeeting')
    const hits = (await rowTexts()).filter((t) => t === 'Teammeeting').length
    expect(hits === 1, `Suche zeigt "Teammeeting" ${hits}-mal`)
    await search('')
    await folderItem('Arbeit').click()
    await until(async () => (await rowTexts()).includes('Teammeeting'), 'im Label-Ordner fehlt die Mail')
    await page.click('.rail-tile[title="Alle Konten zusammen"]')
  })

  await check('Gelesen: sofort beim Oeffnen, auch waehrend ein Abgleich laeuft', async () => {
    const settings = await page.evaluate(() => window.api.settings.get())
    expect(settings.markReadAfterMs === 0, `Standard ist nicht "sofort", sondern ${settings.markReadAfterMs} ms`)
    await folderItem('Posteingang').click()
    const row = rowBySubject('Teammeeting')
    expect((await row.getAttribute('data-unread')) === 'true', 'Ausgangslage: Mail ist nicht ungelesen')
    // Einen vollen Abgleich anstossen - "gelesen" darf nicht dahinter warten.
    void page.evaluate(() => window.api.sync.refresh()).catch(() => {})
    await sleep(100)
    // Gemessen im Fenster selbst: vom Klick, bis die Zeile nicht mehr als ungelesen
    // gilt. Playwrights Klick wartet erst, bis die Liste stillhaelt - das zaehlt nicht.
    const measure = page.evaluate(
      () =>
        new Promise((resolve) => {
          let clickedAt = 0
          const target = () =>
            [...document.querySelectorAll('.row')].find(
              (r) => r.querySelector('.row-subject .text')?.textContent === 'Teammeeting'
            )
          document.addEventListener('click', () => (clickedAt ||= performance.now()), { capture: true, once: true })
          const timer = setInterval(() => {
            if (clickedAt && target()?.dataset.unread === 'false') {
              clearInterval(timer)
              resolve(performance.now() - clickedAt)
            }
          }, 10)
          setTimeout(() => {
            clearInterval(timer)
            resolve(-1)
          }, 10000)
        })
    )
    await row.click()
    const took = await measure
    expect(took >= 0, 'Zeile wird nicht als gelesen angezeigt')
    console.log(`         (gelesen ${Math.round(took)} ms nach dem Klick)`)
    expect(took < 300, `"gelesen" kam erst ${Math.round(took)} ms nach dem Klick`)
    await until(
      () => page.evaluate(() => window.api.accounts.statuses().then((s) => s.every((x) => x.phase === 'idle'))),
      'Abgleich wird nicht fertig',
      90000
    )
    expect((await row.getAttribute('data-unread')) === 'false', 'nach dem Abgleich ist die Mail wieder ungelesen')
    await until(async () => (await subjects(TIM)).find((m) => m.subject === 'Teammeeting')?.seen, 'Server kennt die Mail nicht als gelesen')
  })

  console.log('Unterhaltungen')
  await check('Thread: eine Zeile je Unterhaltung mit Zaehler', async () => {
    const rows = rowBySubject('Projektplan')
    expect((await rows.count()) === 1, `erwartet 1 Zeile "Projektplan", gefunden ${await rows.count()}`)
    expect((await rows.locator('.row-count').textContent()) === '3', 'Zaehler ist nicht 3')
    expect((await rows.getAttribute('data-unread')) === 'true', 'Zeile mit ungelesener Mail ist nicht als ungelesen markiert')
  })

  await check('Thread: Verlauf im Lesebereich samt eigener Antwort', async () => {
    await rowBySubject('Projektplan').click()
    await page.waitForSelector('.thread-item')
    await until(async () => (await page.locator('.thread-item').count()) === 3, 'Verlauf hat nicht 3 Eintraege')
    const where = await page.locator('.thread-item .where').allTextContents()
    expect(where.includes('Gesendet'), `Antwort aus Gesendet fehlt im Verlauf: ${where}`)
    await page.locator('.thread-item', { hasText: 'Gesendet' }).click()
    const frame = page.frameLocator('iframe[title="Nachrichteninhalt"]')
    await until(async () => {
      const plain = await page.locator('.plain-body').textContent().catch(() => '')
      const html = await frame.locator('body').textContent({ timeout: 500 }).catch(() => '')
      return `${plain}${html}`.includes('Antwort von Tim')
    }, 'Text der eigenen Antwort erscheint nicht')
    await shot('02-thread')
  })

  await check('Thread: oeffnen markiert die ganze Unterhaltung als gelesen', async () => {
    await until(async () => (await rowBySubject('Projektplan').getAttribute('data-unread')) === 'false', 'Zeile bleibt ungelesen')
    const server = await subjects(TIM)
    expect(server.filter((m) => m.subject === 'Re: Projektplan').every((m) => m.seen), 'Server kennt die Mail noch als ungelesen')
  })

  await check('Thread: fehlender Anfang wird vom Server nachgeladen', async () => {
    const before = await page.evaluate(() =>
      window.api.messages.list({ kind: 'search', query: { text: 'betreff:"altes thema"' } }).then((l) => l.length)
    )
    expect(before === 1, `der alte Anfang sollte lokal fehlen, gefunden: ${before} Mails`)
    await rowBySubject('Re: Altes Thema').click()
    await until(async () => (await page.locator('.thread-item').count()) === 2, 'Verlauf wurde nicht um die Mail vom Server ergaenzt', 20000)
    expect((await rowBySubject('Re: Altes Thema').locator('.row-count').textContent()) === '2', 'Zaehler zeigt nicht 2')
  })

  await check('Thread: abschaltbar', async () => {
    await page.evaluate(() => window.api.settings.update({ threadView: false }))
    await until(async () => (await rowBySubject('Projektplan').count()) === 2, 'ohne Zusammenfassen sollten 2 Zeilen stehen')
    expect((await page.locator('.row-count').count()) === 0, 'Zaehler trotz abgeschalteter Ansicht')
    await page.evaluate(() => window.api.settings.update({ threadView: true }))
    await until(async () => (await rowBySubject('Projektplan').count()) === 1, 'Zusammenfassen kommt nicht zurueck')
  })

  console.log('Senden')
  await check('Undo Send: zurueckholen verhindert den Versand', async () => {
    await openComposer()
    await fillComposer({ to: ANNA, subject: 'Undo-Test', body: 'Das soll nie ankommen.' })
    await page.click('.compose-dialog .btn-primary')
    await toast().locator('.toast-action', { hasText: 'Rueckgaengig' }).click()
    await page.waitForSelector('.compose-dialog')
    expect((await page.inputValue('#compose-subject')) === 'Undo-Test', 'Betreff ging beim Zurueckholen verloren')
    expect((await page.inputValue('#compose-to')).includes(ANNA), 'Empfaenger ging verloren')
    expect((await page.locator('.compose-editor').innerText()).includes('Das soll nie ankommen.'), 'Text ging verloren')
    await page.keyboard.press('Escape')
    await sleep(4500)
    const got = await subjects(ANNA)
    expect(!got.some((m) => m.subject === 'Undo-Test'), 'Nachricht kam trotz Zurueckholen an')
    expect((await page.evaluate(() => window.api.outbox.list())).length === 0, 'Ausgang ist nicht leer')
  })

  await check('Undo Send: ohne Eingreifen geht die Mail nach der Frist raus', async () => {
    await openComposer()
    await fillComposer({ to: ANNA, subject: 'Frist-Test', body: 'Das soll ankommen.' })
    await page.click('.compose-dialog .btn-primary')
    await toast().waitFor()
    expect(!(await subjects(ANNA)).some((m) => m.subject === 'Frist-Test'), 'Nachricht ging vor Ablauf der Frist raus')
    await until(async () => (await subjects(ANNA)).some((m) => m.subject === 'Frist-Test'), 'Nachricht kam nie an')
    await until(async () => (await subjects(TIM, 'Sent')).some((m) => m.subject === 'Frist-Test'), 'Kopie fehlt in Gesendet')
  })

  await check('Undo Send: Frist 0 sendet sofort', async () => {
    await page.evaluate(() => window.api.settings.update({ undoSendSec: 0 }))
    await openComposer()
    await fillComposer({ to: ANNA, subject: 'Sofort-Test', body: 'Ohne Frist.' })
    await page.click('.compose-dialog .btn-primary')
    await until(async () => (await toast().textContent().catch(() => '')).includes('Gesendet'), 'Meldung "Gesendet" fehlt')
    expect((await subjects(ANNA)).some((m) => m.subject === 'Sofort-Test'), 'Nachricht kam nicht an')
    await page.evaluate(() => window.api.settings.update({ undoSendSec: 3 }))
  })

  await check('Send Later: geplante Nachricht wartet im Ausgang, "Jetzt senden" schickt sie', async () => {
    await openComposer()
    await fillComposer({ to: ANNA, subject: 'Geplant-Test', body: 'Spaeter.' })
    const select = page.locator('.compose-dialog select[aria-label="Spaeter senden"]')
    const value = await select.locator('option').nth(1).getAttribute('value')
    await select.selectOption(value)
    await until(async () => (await toast().textContent().catch(() => '')).includes('Geplant'), 'Meldung "Geplant" fehlt')
    const outbox = await page.evaluate(() => window.api.outbox.list())
    expect(outbox.length === 1 && outbox[0].kind === 'scheduled', `Ausgang: ${JSON.stringify(outbox)}`)
    expect(outbox[0].sendAt - Date.now() > 50 * 60_000, 'Termin liegt nicht rund eine Stunde voraus')
    await sleep(4000)
    expect(!(await subjects(ANNA)).some((m) => m.subject === 'Geplant-Test'), 'geplante Nachricht ging sofort raus')

    await openSettings('Ausgang')
    expect((await page.locator('.account-row', { hasText: 'Geplant-Test' }).textContent()).includes('Geplant fuer'), 'Ausgang zeigt den Termin nicht')
    await shot('03-ausgang')
    await page.locator('.account-row', { hasText: 'Geplant-Test' }).locator('button', { hasText: 'Jetzt senden' }).click()
    await until(async () => (await subjects(ANNA)).some((m) => m.subject === 'Geplant-Test'), 'Nachricht kam nach "Jetzt senden" nicht an')
  })

  await check('Send Later: Termin wird eingehalten', async () => {
    const sendAt = Date.now() + 6000
    await page.evaluate(
      ([to, at]) =>
        window.api.accounts.list().then((accounts) =>
          window.api.mail.send(
            { accountId: accounts[0].id, to: [{ address: to }], cc: [], bcc: [], subject: 'Termin-Test', html: '<p>x</p>', text: 'x', attachments: [] },
            { sendAt: at }
          )
        ),
      [ANNA, sendAt]
    )
    await sleep(3000)
    expect(!(await subjects(ANNA)).some((m) => m.subject === 'Termin-Test'), 'ging vor dem Termin raus')
    await until(async () => (await subjects(ANNA)).some((m) => m.subject === 'Termin-Test'), 'kam zum Termin nicht an')
    expect(Date.now() >= sendAt, 'kam vor dem Termin an')
  })

  await check('Send Later: geplante Nachricht laesst sich bearbeiten', async () => {
    await page.evaluate(
      ([to]) =>
        window.api.accounts.list().then((accounts) =>
          window.api.mail.send(
            { accountId: accounts[0].id, to: [{ address: to }], cc: [], bcc: [{ address: 'blind@test.local' }], subject: 'Bearbeiten-Test', html: '<p>Inhalt bleibt</p>', text: 'Inhalt bleibt', attachments: [{ filename: 'a.txt', content: 'aGFsbG8=', contentType: 'text/plain' }] },
            { sendAt: Date.now() + 3_600_000 }
          )
        ),
      [ANNA]
    )
    await openSettings('Ausgang')
    await page.locator('.account-row', { hasText: 'Bearbeiten-Test' }).locator('button', { hasText: 'Bearbeiten' }).click()
    await page.waitForSelector('.compose-dialog')
    expect((await page.locator('.compose-editor').innerText()).includes('Inhalt bleibt'), 'Text fehlt')
    expect((await page.inputValue('#compose-bcc')).includes('blind@test.local'), 'Blindkopie fehlt')
    expect((await page.locator('.compose-attachments .chip').count()) === 1, 'Anhang fehlt')
    expect((await page.evaluate(() => window.api.outbox.list())).length === 0, 'Eintrag liegt weiter im Ausgang')
    await page.keyboard.press('Escape')
  })

  console.log('Zurueckstellen')
  await check('Snooze: Mail verschwindet und steht unter "Zurueckgestellt"', async () => {
    await rowBySubject('Newsletter Herbst').click()
    const select = page.locator('.reader-bar select[aria-label="Zurueckstellen"]')
    const value = await select.locator('option').nth(1).getAttribute('value')
    await select.selectOption(value)
    await until(async () => (await rowBySubject('Newsletter Herbst').count()) === 0, 'Mail steht weiter im Posteingang')
    expect((await subjects(TIM)).some((m) => m.subject === 'Newsletter Herbst'), 'Mail ist auf dem Server verschwunden - Zurueckstellen soll lokal bleiben')
    await folderItem('Zurueckgestellt').click()
    await until(async () => (await rowBySubject('Newsletter Herbst').count()) === 1, 'Mail fehlt unter "Zurueckgestellt"')
    expect((await rowBySubject('Newsletter Herbst').locator('.row-snooze').textContent()).startsWith('bis'), 'Zeitpunkt wird nicht gezeigt')
    await shot('04-zurueckgestellt')
  })

  await check('Snooze: "Jetzt zurueckholen" bringt die Mail zurueck', async () => {
    await folderItem('Zurueckgestellt').click()
    await rowBySubject('Newsletter Herbst').click()
    await page.locator('.snooze-notice button').click()
    await until(async () => (await rowBySubject('Newsletter Herbst').count()) === 0, 'Mail steht weiter unter "Zurueckgestellt"')
    await folderItem('Posteingang').click()
    await until(async () => (await rowBySubject('Newsletter Herbst').count()) === 1, 'Mail fehlt im Posteingang')
  })

  await check('Snooze: taucht zum Zeitpunkt oben und ungelesen wieder auf', async () => {
    await page.evaluate(() =>
      window.api.messages.list({ kind: 'unified', id: 'inbox' }).then((list) => {
        const target = list.find((m) => m.subject === 'Rechnung 4711')
        return window.api.messages.snooze([target], Date.now() + 4000)
      })
    )
    await until(async () => (await rowBySubject('Rechnung 4711').count()) === 0, 'Mail wurde nicht ausgeblendet')
    await until(async () => (await rowBySubject('Rechnung 4711').count()) === 1, 'Mail kam nicht zurueck', 12000)
    const first = await page.locator('.row .row-subject .text').first().textContent()
    expect(first === 'Rechnung 4711', `wieder aufgetauchte Mail steht nicht oben, sondern: ${first}`)
    expect((await rowBySubject('Rechnung 4711').locator('.row-snooze').textContent()).includes('Wieder da'), 'Hinweis "Wieder da" fehlt')
    await until(async () => (await rowBySubject('Rechnung 4711').getAttribute('data-unread')) === 'true', 'Mail ist nicht ungelesen')
    await shot('05-wieder-da')
    // Lesen erledigt die Sache: der Hinweis verschwindet, die Mail sortiert sich wieder ein.
    await rowBySubject('Rechnung 4711').click()
    await until(async () => (await rowBySubject('Rechnung 4711').locator('.row-snooze').count()) === 0, 'Hinweis bleibt nach dem Lesen stehen')
  })

  await check('Snooze: ueberlebt einen Neustart der App', async () => {
    await page.evaluate(() =>
      window.api.messages.list({ kind: 'unified', id: 'inbox' }).then((list) => {
        const target = list.find((m) => m.subject === 'Mittagessen')
        return window.api.messages.snooze([target], Date.now() + 3_600_000)
      })
    )
    await until(async () => (await rowBySubject('Mittagessen').count()) === 0, 'Mail wurde nicht ausgeblendet')
    await app.close()
    await start(userData)
    await page.waitForSelector('.row', { timeout: 60000 })
    await sleep(1500)
    expect((await rowBySubject('Mittagessen').count()) === 0, 'nach dem Neustart ist die Mail wieder sichtbar')
    await folderItem('Zurueckgestellt').click()
    await until(async () => (await rowBySubject('Mittagessen').count()) === 1, 'Zurueckstellung ging beim Neustart verloren')
    await folderItem('Posteingang').click()
    await until(
      () => page.evaluate(() => window.api.accounts.statuses().then((s) => s.every((x) => x.phase === 'idle'))),
      'Konto kommt nach dem Neustart nicht zur Ruhe',
      90000
    )
  })

  console.log('Vorlagen')
  await check('Vorlagen: anlegen und im Verfassen-Dialog einsetzen', async () => {
    await openSettings('Vorlagen')
    await page.locator('button', { hasText: 'Vorlage anlegen' }).click()
    await page.fill('#tpl-name', 'Terminzusage')
    await page.fill('#tpl-subject', 'Termin bestaetigt')
    await page.fill('#tpl-body', 'Hallo,\n\nder Termin passt <gut>.\n\nGruss')
    await page.locator('button', { hasText: 'Speichern' }).click()
    await until(async () => (await page.locator('.account-row', { hasText: 'Terminzusage' }).count()) === 1, 'Vorlage steht nicht in der Liste')
    await page.locator('.dialog-foot .btn-primary', { hasText: 'Fertig' }).click()

    await openComposer()
    await page.locator('.compose-dialog select[aria-label="Vorlage einsetzen"]').selectOption({ label: 'Terminzusage' })
    const text = await page.locator('.compose-editor').innerText()
    expect(text.includes('der Termin passt <gut>.'), `Vorlagentext fehlt oder wurde als HTML gelesen: ${JSON.stringify(text)}`)
    expect(text.indexOf('Hallo') < text.indexOf('--'), 'Vorlage steht nicht vor der Signatur')
    expect((await page.inputValue('#compose-subject')) === 'Termin bestaetigt', 'Betreff wurde nicht uebernommen')
    await shot('06-vorlage')
    await page.keyboard.press('Escape')
  })

  await check('Vorlagen: vorhandener Betreff bleibt stehen', async () => {
    await openComposer()
    await page.fill('#compose-subject', 'Mein Betreff')
    await page.locator('.compose-dialog select[aria-label="Vorlage einsetzen"]').selectOption({ label: 'Terminzusage' })
    expect((await page.inputValue('#compose-subject')) === 'Mein Betreff', 'Betreff wurde ueberschrieben')
    await page.keyboard.press('Escape')
  })

  console.log('Anhaenge und Suche')
  await check('Anhaenge: Sammelansicht zeigt nur Mails mit Anhang samt Dateinamen', async () => {
    await folderItem('Anhaenge').click()
    await until(async () => {
      const texts = await rowTexts()
      return texts.length === 1 && texts[0] === 'Rechnung 4711'
    }, 'erwartet nur "Rechnung 4711" in der Ansicht')
    expect((await page.locator('.row .row-snippet').first().textContent()).includes('rechnung-4711.pdf'), 'Dateiname fehlt in der Zeile')
    await shot('07-anhaenge')
    await folderItem('Posteingang').click()
  })

  const searches = [
    ['hat:anhang', ['Rechnung 4711']],
    ['datei:4711', ['Rechnung 4711']],
    ['von:buchhaltung', ['Rechnung 4711']],
    ['von:anna betreff:mittag', []], // zurueckgestellt, aber die Suche findet trotzdem -> siehe unten
    ['betreff:"bitte um"', ['Bitte um Rueckruf']],
    ['von:chef rueckruf', ['Bitte um Rueckruf']],
    ['vor:2020-01-01', ['Altes Thema']],
    ['nach:gestern von:news', ['Newsletter Herbst']],
    ['von:niemand', []]
  ]
  for (const [text, expected] of searches) {
    if (text === 'von:anna betreff:mittag') {
      await check(`Suche: ${text} findet auch Zurueckgestelltes`, async () => {
        await search(text)
        const texts = await rowTexts()
        expect(texts.length === 1 && texts[0] === 'Mittagessen', `gefunden: ${texts}`)
      })
      continue
    }
    await check(`Suche: ${text}`, async () => {
      await search(text)
      const texts = [...new Set(await rowTexts())].sort()
      expect(JSON.stringify(texts) === JSON.stringify([...expected].sort()), `erwartet ${JSON.stringify(expected)}, gefunden ${JSON.stringify(texts)}`)
    })
  }
  await check('Suche: gewoehnlicher Text ohne Kuerzel geht weiter', async () => {
    await search('herbst')
    expect((await rowTexts()).includes('Newsletter Herbst'), 'Freitextsuche findet nichts')
    await search('ist:ungelesen')
    const texts = await rowTexts()
    expect(texts.length > 0 && !texts.includes('Bitte um Rueckruf'), `ist:ungelesen liefert Gelesenes: ${texts}`)
    await search('')
  })

  console.log('Bestehendes')
  await check('Bestand: Antworten fuellt Empfaenger, Betreff und Zitat', async () => {
    await rowBySubject('Bitte um Rueckruf').click()
    await page.waitForSelector('.sheet-subject')
    await sleep(600)
    await page.locator('.reader-bar button', { hasText: 'Antworten' }).first().click()
    await page.waitForSelector('.compose-dialog')
    expect((await page.inputValue('#compose-subject')) === 'Re: Bitte um Rueckruf', 'Betreff stimmt nicht')
    expect((await page.inputValue('#compose-to')).includes('chef@firma.example'), 'Empfaenger fehlt')
    expect((await page.locator('.compose-editor').innerText()).includes('Ruf mich bitte an.'), 'Zitat fehlt')
    await page.keyboard.press('Escape')
  })

  await check('Bestand: markieren, ungelesen, archivieren, loeschen', async () => {
    await rowBySubject('Bitte um Rueckruf').click()
    await page.keyboard.press('s')
    await until(async () => (await subjects(TIM)).find((m) => m.subject === 'Bitte um Rueckruf')?.flagged, 'Markierung kam nicht beim Server an')
    await folderItem('Markiert').click()
    await until(async () => (await rowBySubject('Bitte um Rueckruf').count()) === 1, 'fehlt unter "Markiert"')
    await folderItem('Posteingang').click()

    await rowBySubject('Bitte um Rueckruf').click()
    await page.keyboard.press('e')
    await until(async () => (await subjects(TIM, 'Archive')).some((m) => m.subject === 'Bitte um Rueckruf'), 'Archivieren kam nicht beim Server an')
    expect((await rowBySubject('Bitte um Rueckruf').count()) === 0, 'archivierte Mail steht weiter im Posteingang')

    await rowBySubject('Newsletter Herbst').click()
    await page.keyboard.press('Delete')
    await until(async () => (await subjects(TIM, 'Trash')).some((m) => m.subject === 'Newsletter Herbst'), 'Loeschen kam nicht beim Server an')
  })

  await check('Bestand: Archivieren einer Unterhaltung nimmt alle Mails der Zeile mit', async () => {
    await rowBySubject('Projektplan').click()
    await page.keyboard.press('e')
    await until(
      async () => (await subjects(TIM, 'Archive')).filter((m) => /Projektplan/.test(m.subject)).length === 2,
      'nicht beide Posteingangs-Mails der Unterhaltung wurden archiviert'
    )
    expect(!(await subjects(TIM)).some((m) => /Projektplan/.test(m.subject)), 'im Posteingang blieb ein Teil der Unterhaltung liegen')
    expect((await subjects(TIM, 'Sent')).some((m) => m.subject === 'Re: Projektplan'), 'die eigene Antwort in Gesendet wurde mit verschoben')
  })

  await check('Bestand: neue Post kommt an und landet in ihrer Unterhaltung', async () => {
    const transport = nodemailer.createTransport({ host: HOST, port: 3465, secure: true, tls: { rejectUnauthorized: false } })
    await transport.sendMail(mail(ANNA, TIM, 'Re: Altes Thema', { messageId: '<alt-3@test.local>', inReplyTo: '<alt-2@test.local>', references: ['<alt-1@test.local>', '<alt-2@test.local>'], text: 'Noch ein Nachtrag.' }))
    transport.close()
    await page.evaluate(() => window.api.sync.refresh())
    await until(async () => (await rowBySubject('Re: Altes Thema').locator('.row-count').textContent().catch(() => '')) === '3', 'neue Antwort wurde nicht in die Unterhaltung einsortiert', 30000)
    expect((await rowBySubject('Re: Altes Thema').count()) === 1, 'Unterhaltung steht doppelt in der Liste')
  })

  await shot('08-ende')
  await app.close()
  fs.rmSync(userData, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} von ${results.length} bestanden.`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (err) => {
  console.error('Abbruch:', err)
  await app?.close().catch(() => {})
  process.exit(2)
})
