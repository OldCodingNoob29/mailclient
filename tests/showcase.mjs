/*
  Screenshot for timotheusstotz.de/me: dark theme, two accounts, English mails.
  Needs the same local GreenMail as tests/e2e.mjs:

    docker run -d --name mailclient-greenmail -p 3465:3465 -p 3993:3993 -p 8080:8080 \
      -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
      greenmail/standalone:2.1.3
    npm run build && node tests/showcase.mjs <out.png>        (KEEP_GERMAN=1 keeps the German labels)

  The app's interface is German; for the English website the visible labels are swapped for English ones
  in the screenshot only (see LABELS). Nothing in the app changes.
*/
import { _electron as electron } from 'playwright-core'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] ?? path.join(root, 'tests', 'shots', 'showcase.png'))
const HOST = '127.0.0.1'
const WORK = 'tim@work.test'
const HOME = 'tim@home.test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function imap(user) {
  const client = new ImapFlow({ host: HOST, port: 3993, secure: true, auth: { user, pass: 'secret' }, logger: false, tls: { rejectUnauthorized: false } })
  client.on('error', () => {})
  await client.connect()
  return client
}
const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
const raw = async (o) => (await builder.sendMail(o)).message

async function fill(user, folders, mails) {
  const c = await imap(user)
  for (const f of folders) await c.mailboxCreate(f).catch(() => {})
  for (const f of ['INBOX', ...folders]) {
    const lock = await c.getMailboxLock(f)
    try { if (c.mailbox.exists) await c.messageDelete('1:*') } finally { lock.release() }
  }
  for (const [folder, m, flags] of mails) await c.append(folder, await raw(m), flags ?? [], m.date)
  await c.logout()
}

async function seed() {
  await fetch('http://localhost:8080/api/mail/purge', { method: 'POST' })
  const now = Date.now()
  const at = (min) => new Date(now - min * 60_000)
  const m = (from, name, to, subject, min, text, extra = {}) => ({ from: `${name} <${from}>`, to, subject, date: at(min), text, ...extra })
  const sarah = 'sarah@work.test'
  await fill(WORK, ['Sent', 'Archive', 'Drafts', 'Trash'], [
    ['INBOX', m('it@work.test', 'IT Service Desk', WORK, 'Planned maintenance on Saturday', 720, 'The VPN will be down from 8 to 10 am.'), ['\\Seen']],
    ['INBOX', m(sarah, 'Sarah Klein', WORK, 'Launch plan for the new newsletter', 300, 'Hi Tim,\n\nhere is the launch plan. Can you check the sign-up flow by Friday?\n\nSarah', { messageId: '<plan-1@work.test>' }), ['\\Seen']],
    ['Sent', m(WORK, 'Tim', sarah, 'Re: Launch plan for the new newsletter', 240, 'Thanks, I will go through the sign-up flow tomorrow morning.', { messageId: '<plan-2@work.test>', inReplyTo: '<plan-1@work.test>', references: ['<plan-1@work.test>'] }), ['\\Seen']],
    ['INBOX', m(sarah, 'Sarah Klein', WORK, 'Re: Launch plan for the new newsletter', 25, 'Perfect, then we go live on Monday. The double opt-in mail looks great.\n\nSarah', { messageId: '<plan-3@work.test>', inReplyTo: '<plan-2@work.test>', references: ['<plan-1@work.test>', '<plan-2@work.test>'] })],
    ['INBOX', m('ben@work.test', 'Ben Weber', WORK, 'Code review for the user API', 95, 'Left two small comments on the session limits, otherwise good to merge.'), ['\\Seen']],
    ['INBOX', m('billing@cloud.example', 'Cloud Billing', WORK, 'Invoice #4711 for October', 150, 'Your invoice is attached.', { attachments: [{ filename: 'invoice-4711.pdf', content: Buffer.from('%PDF-1.4 demo'), contentType: 'application/pdf' }] }), ['\\Seen']],
    ['INBOX', m('lena@work.test', 'Lena Hoffmann', WORK, 'Team lunch on Friday?', 50, 'The new Thai place around the corner?')]
  ])
  await fill(HOME, ['Sent', 'Archive', 'Drafts', 'Trash'], [
    ['INBOX', m('shop@outdoor.example', 'Outdoor Shop', HOME, 'Your order has shipped', 400, 'Your new hiking boots are on their way.'), ['\\Seen']],
    ['INBOX', m('jonas@home.test', 'Jonas', HOME, 'Weekend hike with Elmo?', 70, 'Taunus on Sunday? Bring the dog.')],
    ['INBOX', m('flights@air.example', 'Air Booking', HOME, 'Your flight to Lisbon', 200, 'Booking confirmed.'), ['\\Seen']]
  ])
}

// German interface labels and their English counterparts, swapped in the screenshot only.
const LABELS = [
  ['Alle Konten', 'All accounts'], ['Konten verbunden', 'accounts connected'], ['Posteingang', 'Inbox'], ['Ungelesen', 'Unread'],
  ['Markiert', 'Flagged'], ['Zurueckgestellt', 'Snoozed'], ['Zurueckstellen', 'Snooze'], ['Anhaenge', 'Attachments'],
  ['Archiv', 'Archive'], ['Gesendet', 'Sent'], ['Entwuerfe', 'Drafts'], ['Papierkorb', 'Trash'], ['Durchsuchen', 'Search'],
  ['Antworten', 'Reply'], ['Weiterleiten', 'Forward'], ['Verschieben', 'Move'], ['Unterhaltung', 'Conversation'],
  ['Nachrichten', 'messages'], ['Arbeit', 'Work'], ['Privat', 'Personal']
]

async function main() {
  await seed()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mailclient-showcase-'))
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.', `--user-data-dir=${userData}`, '--hidden', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    cwd: root,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await page.evaluate(() => window.api.settings.update({ initialFetchCount: 50, notifyOnNewMail: false, runInTray: false, theme: 'dark' }))
  for (const [label, email, color] of [['Work', WORK, '#2f5bd0'], ['Personal', HOME, '#d9822b']]) {
    await page.evaluate(([label, email, color, host]) => window.api.accounts.save({
      label, displayName: 'Tim Stotz', email, color, imap: { host, port: 3993, secure: true }, smtp: { host, port: 3465, secure: true },
      username: email, signature: 'Tim', enabled: true, password: 'secret'
    }), [label, email, color, HOST])
  }
  await page.reload()
  await page.waitForSelector('.row', { timeout: 60_000 })
  await sleep(3000)
  await page.locator('.row', { hasText: 'Launch plan' }).first().click()
  await sleep(1500)
  // KEEP_GERMAN=1 shows the interface as it really is (used for the README)
  if (!process.env.KEEP_GERMAN) await page.evaluate((labels) => {
    const swap = (t) => labels.reduce((s, [de, en]) => s.split(de).join(en), t)
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = walk.nextNode());) n.nodeValue = swap(n.nodeValue)
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach((e) => {
      for (const a of ['placeholder', 'title', 'aria-label']) if (e.hasAttribute(a)) e.setAttribute(a, swap(e.getAttribute(a)))
    })
    // the reader's long German date, e.g. "Mi., 30. September 2026 um 06:17"
    const de = { Januar: 'January', Februar: 'February', März: 'March', April: 'April', Mai: 'May', Juni: 'June', Juli: 'July', August: 'August', September: 'September', Oktober: 'October', November: 'November', Dezember: 'December' }
    const days = { 'Mo.': 'Mon,', 'Di.': 'Tue,', 'Mi.': 'Wed,', 'Do.': 'Thu,', 'Fr.': 'Fri,', 'Sa.': 'Sat,', 'So.': 'Sun,' }
    const walk2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = walk2.nextNode());) {
      n.nodeValue = n.nodeValue
        .replace(/(Mo\.|Di\.|Mi\.|Do\.|Fr\.|Sa\.|So\.), (\d+)\. (\S+) (\d{4}) um (\d\d:\d\d)/, (_, d, day, mon, y, t) => `${days[d]} ${de[mon] ?? mon} ${day}, ${y} at ${t}`)
        .replace(/^An /, 'To ')
    }
  }, LABELS)
  await sleep(300)
  // the hidden window sometimes stalls Playwright's screenshot; Electron's own capture is the fallback
  await page.screenshot({ path: out, timeout: 10_000 }).catch(async () => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(out, Buffer.from(png, 'base64'))
  })
  console.log('saved', out)
  await app.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
