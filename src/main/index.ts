import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray
} from 'electron'
import { join } from 'node:path'
import fsp from 'node:fs/promises'
import type {
  Account,
  AccountDraft,
  AccountId,
  MessageSummary,
  OutgoingMessage,
  SearchQuery,
  Settings,
  ViewRef
} from '@shared/types'
import { MailService } from './service'
import { mailtoFromArgv, parseMailto, type MailtoDraft } from '@shared/mailto'

const isDev = !app.isPackaged
/** Beim Autostart faehrt die App still hoch - nur das Symbol im Infobereich. */
const startHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let service: MailService | null = null
let tray: Tray | null = null
/** Wird erst wahr, wenn wirklich beendet werden soll - nicht beim Zuklappen. */
let quitting = false

/**
 * Steckt der Code in einem fertigen Paket? app.isPackaged taugt dafuer nicht:
 * es ist auch wahr, wenn die Starter-exe den Build aus dem Repo ueber die
 * umbenannte Laufzeit (runtime\Mailclient.exe) startet.
 */
const bundled = __dirname.includes('app.asar')

/** Pfad zu einer Datei aus resources/, im Paket wie beim Start aus dem Repo. */
function resourceFile(name: string): string {
  return bundled
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', name)
    : join(__dirname, '../../resources', name)
}

// Ein zweiter Start soll das vorhandene Fenster nach vorne holen, nicht die
// Ablage ein zweites Mal oeffnen.
// Ein mailto:-Link (Klick auf "Mail schreiben" im Browser) kommt als Argument:
// beim ersten Start in process.argv, bei laufender App ueber second-instance.
let pendingMailto: MailtoDraft | null = parseMailto(mailtoFromArgv(process.argv) ?? '')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow()
    const draft = parseMailto(mailtoFromArgv(argv) ?? '')
    if (draft) emit('compose:mailto', draft)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: resourceFile('icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f7f7f5',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  // Beim Autostart bleibt das Fenster unsichtbar; die App arbeitet trotzdem.
  window.once('ready-to-show', () => {
    if (!startHidden) window.show()
  })

  /*
    Das Kreuz beendet die App nicht, sondern legt sie in den Infobereich - sonst
    gibt es keinen Abruf im Hintergrund. Ueber das Menue oder das Tray-Menue
    kommt man weiterhin richtig raus.
  */
  window.on('close', (event) => {
    if (quitting || !service?.getSettings().runInTray) return
    // Ohne Symbol im Infobereich gaebe es keinen Weg zurueck - dann lieber
    // beenden, als ein unerreichbares Programm zu hinterlassen.
    if (!tray) return
    event.preventDefault()
    window.hide()
  })

  // Links aus Mails oeffnen im Systembrowser, nie in einem Electron-Fenster.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    // Nur die eigene Oberflaeche ist ein erlaubtes Ziel. Frueher galt jede
    // file://-Adresse - eine aufs Fenster fallengelassene Datei haette dann die
    // ganze App durch sich selbst ersetzt.
    const rendererRoot = pathToFileURL(join(__dirname, '../renderer')).href
    const isAppUrl = url.startsWith(rendererRoot) || url.startsWith(process.env.ELECTRON_RENDERER_URL ?? ' ')
    if (isAppUrl) return
    event.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function emit(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

/** Holt das Fenster nach vorne, egal ob versteckt, minimiert oder geschlossen. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// ------------------------------------------------------------- Infobereich

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(resourceFile('tray.png'))
  // Ohne lesbares Bild waere das Symbol unsichtbar und die App unerreichbar.
  if (icon.isEmpty()) {
    console.error('[tray] Symbol nicht gefunden:', resourceFile('tray.png'))
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('Mailclient')
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
  updateTrayMenu(0)
}

function updateTrayMenu(unread: number): void {
  if (!tray) return
  tray.setToolTip(unread > 0 ? `Mailclient - ${unread} ungelesen` : 'Mailclient')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: unread > 0 ? `${unread} ungelesen` : 'Keine neue Post', enabled: false },
      { type: 'separator' },
      { label: 'Oeffnen', click: () => showWindow() },
      {
        label: 'Neue Nachricht',
        click: () => {
          showWindow()
          emit('menu:compose', null)
        }
      },
      { label: 'Jetzt abrufen', click: () => void service?.refresh() },
      { type: 'separator' },
      {
        label: 'Beenden',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// --------------------------------------------------------- Benachrichtigung

/**
 * Meldet eingetroffene Post. Mehrere Mails auf einmal ergeben eine einzige
 * Meldung - bei einem Newsletter-Schwall will niemand zwanzig Blasen wegklicken.
 */
function notifyNewMail(account: Account, messages: MessageSummary[]): void {
  if (!service?.getSettings().notifyOnNewMail) return
  if (!Notification.isSupported() || !messages.length) return

  const newest = messages[messages.length - 1]
  const single = messages.length === 1
  const sender = newest.from[0]?.name || newest.from[0]?.address || 'Unbekannt'

  const notification = new Notification({
    title: single ? sender : `${messages.length} neue Nachrichten`,
    body: single
      ? newest.subject || '(kein Betreff)'
      : `${account.label || account.email}: zuletzt ${sender}`,
    subtitle: single ? account.label : undefined,
    silent: false
  })
  notification.on('click', () => {
    showWindow()
    // Der Renderer waehlt die Mail aus, sobald ihre Liste sie kennt.
    emit('mail:open', single ? newest.id : null)
  })
  notification.show()
}

/** Meldet eine zurueckgestellte Mail, die wieder an der Reihe ist. */
function notifyReturned(account: Account, message: MessageSummary): void {
  if (!service?.getSettings().notifyOnNewMail || !Notification.isSupported()) return
  const sender = message.from[0]?.name || message.from[0]?.address || 'Unbekannt'
  const notification = new Notification({
    title: `Wieder da: ${sender}`,
    body: message.subject || '(kein Betreff)',
    subtitle: account.label,
    silent: false
  })
  notification.on('click', () => {
    showWindow()
    emit('mail:open', message.id)
  })
  notification.show()
}

function buildMenu(): void {
  const send = (channel: string) => () => emit(channel, null)
  const sendZoom = (step: 'in' | 'out' | 'reset') => () => emit('menu:readerZoom', step)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Datei',
      submenu: [
        { label: 'Neue Nachricht', accelerator: 'CmdOrCtrl+N', click: send('menu:compose') },
        { label: 'Jetzt abrufen', accelerator: 'CmdOrCtrl+R', click: send('menu:refresh') },
        { type: 'separator' },
        { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
        { type: 'separator' },
        {
          label: 'Fenster schliessen',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.close()
        },
        {
          label: 'Beenden',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Rueckgaengig' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfuegen' },
        { role: 'selectAll', label: 'Alles auswaehlen' },
        { type: 'separator' },
        { label: 'Suchen', accelerator: 'CmdOrCtrl+F', click: send('menu:search') }
      ]
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
        { type: 'separator' },
        /*
          Vergroessert wird die Nachricht, nicht das Fenster - das Chrome ringsum
          soll seine Groesse behalten. Die Kuerzel stehen im Text statt als
          accelerator, weil Electron "CmdOrCtrl+Plus" nicht ausloest; getastet
          wird deshalb im Renderer, wo alle drei am selben Ort liegen.
        */
        { label: 'Nachricht groesser (Strg +)', click: sendZoom('in') },
        { label: 'Nachricht kleiner (Strg -)', click: sendZoom('out') },
        { label: 'Nachricht in Normalgroesse (Strg 0)', click: sendZoom('reset') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(service: MailService): void {
  const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>) => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as T)))
  }

  // Die Oberflaeche holt einen mailto:-Link vom Start ab, sobald die Konten stehen.
  handle('mailto:take', () => {
    const draft = pendingMailto
    pendingMailto = null
    return draft
  })
  handle('accounts:list', () => service.listAccounts())
  handle('accounts:save', (draft: AccountDraft) => service.saveAccount(draft))
  handle('accounts:delete', (id: AccountId) => service.deleteAccount(id))
  handle('accounts:test', (draft: AccountDraft) => service.testConnection(draft))
  handle('accounts:statuses', () => service.getStatuses())
  handle('accounts:encryptionAvailable', () => service.isEncryptionAvailable())

  handle('folders:list', () => service.listFolders())

  handle('messages:list', (view: ViewRef, limit?: number) => service.listMessages(view, limit))
  handle('messages:body', (accountId: AccountId, folder: string, uid: number) =>
    service.getBody(accountId, folder, uid)
  )
  handle('messages:setSeen', (items: MessageSummary[], seen: boolean) => service.setSeen(items, seen))
  handle('messages:setFlagged', (items: MessageSummary[], flagged: boolean) =>
    service.setFlagged(items, flagged)
  )
  handle('messages:delete', (items: MessageSummary[]) => service.remove(items))
  handle('messages:archive', (items: MessageSummary[]) => service.archive(items))
  handle('messages:move', (items: MessageSummary[], target: string) => service.moveTo(items, target))

  handle('messages:thread', (accountId: AccountId, folder: string, uid: number) =>
    service.getThread(accountId, folder, uid)
  )
  handle('messages:snooze', (items: MessageSummary[], until: number) => service.snooze(items, until))
  handle('messages:unsnooze', (items: MessageSummary[]) => service.unsnooze(items))

  handle('messages:markRead', (target: { accountId?: AccountId; folder?: string }) =>
    service.markRead(target)
  )
  handle('messages:emptyFolder', (accountId: AccountId, folder: string) =>
    service.emptyFolder(accountId, folder)
  )

  handle('sync:refresh', (accountId?: AccountId, folder?: string) => service.refresh(accountId, folder))
  handle('search:server', (query: SearchQuery) => service.searchServer(query))

  handle('settings:get', () => service.getSettings())
  handle('settings:update', async (patch: Partial<Settings>) => {
    const settings = await service.updateSettings(patch)
    nativeTheme.themeSource = settings.theme
    applyBackgroundSettings(settings)
    return settings
  })

  handle('contacts:suggest', (query: string, limit?: number) =>
    service.suggestContacts(query, limit)
  )

  handle('mail:send', (msg: OutgoingMessage, opts?: { sendAt?: number }) => service.send(msg, opts))
  handle('outbox:list', () => service.getOutbox())
  handle('outbox:discard', (id: string) => service.discardOutboxEntry(id))
  handle('outbox:take', (id: string) => service.takeOutboxEntry(id))
  handle('outbox:sendNow', (id: string) => service.sendOutboxEntryNow(id))

  handle('clipboard:write', (text: string) => clipboard.writeText(text))

  /**
   * Ungelesen-Zaehler am Symbol in der Taskleiste. Windows kennt dafuer nur
   * das Overlay-Bild, macOS und Linux nur den Zahlenwert - also beides.
   */
  handle('badge:set', (count: number, dataUrl: string | null) => {
    updateTrayMenu(count)
    if (process.platform === 'win32') {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const overlay = dataUrl ? nativeImage.createFromDataURL(dataUrl) : null
      mainWindow.setOverlayIcon(
        overlay,
        count > 0 ? `${count} ungelesene Nachrichten` : 'Keine ungelesenen Nachrichten'
      )
    } else {
      app.setBadgeCount(count)
    }
  })

  /*
    Strg+Mausrad zoomt nicht von selbst: Electron fuehrt die Geste nicht aus,
    und ueber dem Nachrichtenrahmen bekaeme das Fenster sie ohnehin nicht zu
    sehen. Die Oberflaeche meldet sie deshalb selbst hierher.
    Die Grenzen entsprechen etwa 60% bis 250%.
  */
  handle('rules:apply', (ruleId: string) => service.applyRule(ruleId))

  handle('shell:openExternal', (url: string) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })

  // Anhaenge werden erst beim Speichern vom Server geholt - sie liegen nicht
  // dauerhaft im Cache herum.
  handle(
    'attachment:save',
    async (accountId: AccountId, folder: string, uid: number, partId: string, filename: string) => {
      const target = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: filename,
        title: 'Anhang speichern'
      })
      if (target.canceled || !target.filePath) return { saved: false }
      const attachment = await service.getAttachment(accountId, folder, uid, partId)
      if (!attachment) return { saved: false, error: 'Anhang konnte nicht geladen werden.' }
      await fsp.writeFile(target.filePath, attachment.data)
      return { saved: true, path: target.filePath }
    }
  )

  handle('attachment:open', async (accountId: AccountId, folder: string, uid: number, partId: string, filename: string) => {
    const attachment = await service.getAttachment(accountId, folder, uid, partId)
    if (!attachment) return { opened: false }
    const target = join(app.getPath('temp'), `mailclient-${Date.now()}-${sanitizeFilename(filename)}`)
    await fsp.writeFile(target, attachment.data)
    const error = await shell.openPath(target)
    return { opened: !error, error: error || undefined }
  })

  // Dateien fuer den Verfassen-Dialog auswaehlen.
  handle('compose:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      title: 'Anhaenge auswaehlen'
    })
    if (result.canceled) return []
    return Promise.all(
      result.filePaths.map(async (file) => {
        const data = await fsp.readFile(file)
        return {
          filename: file.split(/[\\/]/).pop() ?? 'anhang',
          content: data.toString('base64'),
          contentType: 'application/octet-stream',
          size: data.length
        }
      })
    )
  })
}

/** Verhindert, dass ein praeparierter Dateiname aus dem temp-Ordner ausbricht. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'anhang'
}

/**
 * Setzt um, was an Einstellungen ausserhalb des Fensters wirkt: Symbol im
 * Infobereich und Eintrag im Autostart des Betriebssystems.
 */
function applyBackgroundSettings(settings: Settings): void {
  if (settings.runInTray) createTray()
  else destroyTray()

  // Der Autostart faehrt still hoch - deshalb --hidden. Nur in der installierten
  // App: ein Start aus dem Repo darf sich nicht in den Autostart eintragen.
  if (process.platform !== 'linux' && bundled) {
    app.setLoginItemSettings({ openAtLogin: settings.startWithSystem, args: ['--hidden'] })
  }
}

app.whenReady().then(async () => {
  // Dieselbe Kennung tragen die Starter-exe und die Verknuepfungen (siehe
  // scripts/build-launcher.ps1). Die fruehere Kennung 'de.tim.mailclient' hatte
  // Windows fest mit electron.exe verbunden - ein Pin landete immer wieder dort.
  // Deshalb bekommt ein Start ueber das nackte electron.exe (Entwicklung, Tests)
  // eine eigene Kennung: Windows merkt sich zu jeder Kennung die Programmdatei,
  // und die der App darf nie wieder auf electron.exe zeigen.
  const viaElectron = /(^|[\\/])electron(\.exe)?$/i.test(process.execPath)
  app.setAppUserModelId(viaElectron ? 'de.tim.mailclient.dev' : 'de.tim.mailclient.app')

  service = new MailService(emit, notifyNewMail, notifyReturned)
  registerIpc(service)
  buildMenu()

  mainWindow = createWindow()

  await service.init()
  const settings = service.getSettings()
  nativeTheme.themeSource = settings.theme
  applyBackgroundSettings(settings)
  emit('accounts:changed', null)

  app.on('activate', () => showWindow())
})

app.on('window-all-closed', () => {
  // Mit Symbol im Infobereich laeuft die App weiter und holt weiter Post ab.
  if (process.platform === 'darwin' || tray) return
  app.quit()
})


app.on('before-quit', async (event) => {
  // Ab hier darf das Fenster sich wirklich schliessen, statt sich zu verstecken.
  quitting = true
  if (!service) return
  const pending = service
  service = null
  event.preventDefault()
  // Ungeschriebene Aenderungen erst auf die Platte, dann wirklich beenden.
  await pending.shutdown().catch(() => {})
  app.quit()
})
