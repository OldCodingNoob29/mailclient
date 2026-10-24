#!/usr/bin/env bash
#
# Installiert den gebauten Client unter Windows und legt Verknuepfungen an.
# Gedacht fuer den Fall, dass unter WSL gebaut und unter Windows benutzt wird.
#
#   npm run dist:win && scripts/install-windows.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$here/dist/win-unpacked"
powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
taskkill='/mnt/c/Windows/System32/taskkill.exe'
tasklist='/mnt/c/Windows/System32/tasklist.exe'

fail() {
  echo "Abbruch: $*" >&2
  exit 1
}

if [[ ! -d "$source_dir" ]]; then
  fail "dist/win-unpacked fehlt. Erst 'npm run dist:win' laufen lassen."
fi
if [[ ! -x "$powershell" ]]; then
  fail "Kein Windows erreichbar. Dieses Skript laeuft nur unter WSL."
fi

running() {
  "$tasklist" /FI 'IMAGENAME eq Mailclient.exe' /NH 2>/dev/null |
    tr -d '\r' | grep -qi '^[[:space:]]*Mailclient\.exe'
}

# Eine laufende Instanz haelt ihre Dateien gesperrt. taskkill meldet Erfolg
# aber schon, sobald Windows den Abschuss angenommen hat - die Dateihandles
# gibt der Prozess erst beim tatsaechlichen Ende frei. Wer sofort weiterloescht,
# scheitert an den noch offenen DirectX-DLLs des Grafikprozesses.
if running; then
  echo "Beende laufende Instanz"
  "$taskkill" /IM Mailclient.exe /F >/dev/null 2>&1 || true
  for _ in $(seq 40); do
    running || break
    sleep 0.5
  done
  if running; then
    fail "Mailclient laeuft weiterhin. Bitte von Hand beenden und neu versuchen."
  fi
  # Windows raeumt die Handles erst kurz nach dem Prozessende ab.
  sleep 1
fi

win_user_profile="$("$powershell" -NoProfile -Command 'Write-Output $env:LOCALAPPDATA' | tr -d '\r')"
target="/mnt/c${win_user_profile#C:}"
target="${target//\\//}/Programs/Mailclient"
staging="$target.neu"
backup="$target.alt"

echo "Installiere nach $target"
mkdir -p "$(dirname "$target")"

# Beide Hilfsordner muessen weg sein, bevor es losgeht. Besonders der Sicherungs-
# ordner: waere er noch da, wuerde `mv "$target" "$backup"` die Installation in
# ihn hineinschieben statt umzubenennen - und der Zielort waere leer.
rm -rf "$staging" "$backup" 2>/dev/null || true
for leftover in "$staging" "$backup"; do
  if [[ -e "$leftover" ]]; then
    fail "$leftover liess sich nicht raeumen. Die Installation wurde nicht angetastet.
       Ordner nach einem Neustart von Hand loeschen."
  fi
done

# Erst vollstaendig daneben aufbauen, dann tauschen. Solange das Kopieren
# laeuft, bleibt die vorhandene Installation unangetastet und benutzbar.
cp -r "$source_dir" "$staging"
cp "$here/build/icon.ico" "$staging/Mailclient.ico"
[[ -x "$staging/Mailclient.exe" ]] || fail "Der Build ist unvollstaendig - Mailclient.exe fehlt."

# Umbenennen statt loeschen: das gelingt entweder ganz oder gar nicht. Ein
# gescheitertes rm -rf hinterliesse dagegen einen halb ausgeraeumten Ordner
# ohne .exe - also eine kaputte Installation statt der alten.
if [[ -d "$target" ]]; then
  if ! mv "$target" "$backup"; then
    fail "Die vorhandene Installation ist gesperrt und wurde nicht angetastet.
       Laeuft Mailclient noch, oder hat ein Explorer-Fenster den Ordner offen?
       Die neue Fassung liegt bereit unter $staging"
  fi
fi

if ! mv "$staging" "$target"; then
  if [[ -d "$backup" ]]; then
    mv "$backup" "$target" && echo "Die vorherige Installation wurde wiederhergestellt." >&2
  fi
  fail "Die neue Fassung liess sich nicht an ihren Platz schieben."
fi

# Ab hier steht die Installation. Reste der alten Fassung sind nur noch Ballast:
# wenn sich davon etwas nicht loeschen laesst, ist das kein Grund zum Abbruch.
if ! rm -rf "$backup" 2>/dev/null; then
  echo "Hinweis: Reste der alten Fassung liegen noch unter $backup und koennen"
  echo "         nach dem naechsten Neustart von Hand geloescht werden."
fi

script="$(mktemp)"
cat > "$script" <<'PS1'
$app = "$env:LOCALAPPDATA\Programs\Mailclient\Mailclient.exe"
$ico = "$env:LOCALAPPDATA\Programs\Mailclient\Mailclient.ico"
$programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), $programs)) {
  if (-not (Test-Path $dir)) { continue }
  $lnk = $sh.CreateShortcut((Join-Path $dir 'Mailclient.lnk'))
  $lnk.TargetPath = $app
  $lnk.WorkingDirectory = Split-Path $app
  $lnk.IconLocation = $ico
  $lnk.Description = 'Mailclient - mehrere Postfaecher an einem Ort'
  $lnk.Save()
  Write-Output ('Verknuepfung: ' + (Join-Path $dir 'Mailclient.lnk'))
}
PS1

# PowerShell muss die Datei ueber einen Windows-Pfad sehen, deshalb der Umweg
# ueber das temporaere Verzeichnis des Benutzers.
staged_dir="/mnt/c${win_user_profile#C:}"
staged_dir="${staged_dir//\\//}/Temp"
cp "$script" "$staged_dir/mailclient-link.ps1"
"$powershell" -NoProfile -ExecutionPolicy Bypass \
  -File "$win_user_profile\\Temp\\mailclient-link.ps1" | tr -d '\r'
rm -f "$staged_dir/mailclient-link.ps1" "$script"

echo "Fertig. Mailclient liegt auf dem Desktop und im Startmenue."
