// Starts the app the way Windows does for a mailto link and checks that the editor opens filled in.
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mailclient-mailto-'))
const launch = (extra) => electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.', `--user-data-dir=${userData}`, '--hidden', ...extra], cwd: root,
  env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
})
// first run: one account, so there is a sender
let app = await launch([])
let page = await app.firstWindow()
await page.evaluate(() => window.api.accounts.save({
  label: 'Test', displayName: 'Tim', email: 'tim@test.local', color: '#2f5bd0',
  imap: { host: '127.0.0.1', port: 3993, secure: true }, smtp: { host: '127.0.0.1', port: 3465, secure: true },
  username: 'tim@test.local', signature: 'Tim', enabled: true, password: 'x'
}))
await app.close()
// second run: started with a mailto link
app = await launch(['mailto:timotheusstotz@gmail.com?subject=Hello%20Tim&body=Saw%20your%20site%0D%0A%0D%0ASecond%20paragraph'])
page = await app.firstWindow()
await page.waitForSelector('.compose-dialog', { timeout: 20000 })
const got = await page.evaluate(() => ({
  to: document.querySelector('#compose-to')?.value,
  subject: document.querySelector('#compose-subject')?.value,
  body: document.querySelector('.compose-editor')?.innerText.split('\n').slice(0, 3)
}))
console.log(JSON.stringify(got))
await app.close()
