# Baut die Starter-exe (launcher\Mailclient.exe) und legt optional eine Verknuepfung auf den Desktop.
#   powershell -File scripts\build-launcher.ps1 [-Desktop]
param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$tmp = Join-Path $env:TEMP 'Launcher.cs'
(Get-Content (Join-Path $repo 'launcher\Launcher.cs') -Raw).Replace('__REPO__', $repo) | Set-Content $tmp -Encoding UTF8
$out = Join-Path $repo 'launcher\Mailclient.exe'
$ico = Join-Path $repo 'build\icon.ico'
& $csc /nologo /target:winexe /optimize "/out:$out" "/win32icon:$ico" /r:System.Windows.Forms.dll /r:System.Drawing.dll $tmp
if ($LASTEXITCODE -ne 0) { throw 'csc fehlgeschlagen' }

# Startmenue-Verknuepfung mit derselben AppUserModelID wie das App-Fenster. Ueber
# sie loest Windows ein angeheftetes Taskleisten-Symbol auf: Ziel, Name und Icon
# kommen dann von hier und nicht von der Programmdatei des gerade laufenden
# Prozesses. Ohne sie merkte sich Windows beim Anheften die nackte Laufzeit.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class AppShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class CShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointer;
    }

    public static void Create(string lnkPath, string target, string workDir, string icon, string appId)
    {
        var link = (IShellLinkW)new CShellLink();
        link.SetPath(target);
        link.SetWorkingDirectory(workDir);
        link.SetIconLocation(icon, 0);
        link.SetDescription("Mailclient");

        var store = (IPropertyStore)link;
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var value = new PropVariant { vt = 31, pointer = Marshal.StringToCoTaskMemUni(appId) };
        store.SetValue(ref key, ref value);
        store.Commit();
        Marshal.FreeCoTaskMem(value.pointer);

        ((IPersistFile)link).Save(lnkPath, true);
    }
}
'@
$appId = 'de.tim.mailclient.app'
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Mailclient.lnk'
[AppShortcut]::Create($lnk, $out, $repo, $out, $appId)
Write-Host "Startmenue: $lnk"

# Auf dem Desktop liegt eine Verknuepfung, keine Kopie der exe: sie heisst dort
# schlicht "Mailclient", ohne Dateiendung, und traegt dieselbe Kennung.
if ($Desktop) {
  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $old = Join-Path $desktopDir 'Mailclient.exe'
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
  $desktopLnk = Join-Path $desktopDir 'Mailclient.lnk'
  [AppShortcut]::Create($desktopLnk, $out, $repo, $out, $appId)
  Write-Host "Desktop: $desktopLnk"
}
# Als E-Mail-App bei Windows anmelden (nur fuer den aktuellen Benutzer, ohne Adminrechte).
# Windows setzt die Standard-App nicht auf Zuruf; danach unter Einstellungen > Apps >
# Standard-Apps > Mailclient einmal "MAILTO" auf Mailclient stellen.
$progId = 'Mailclient.mailto'
$classes = 'HKCU:\Software\Classes\' + $progId
New-Item -Path "$classes\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $classes -Name '(default)' -Value 'URL:MailTo Protocol'
Set-ItemProperty -Path $classes -Name 'URL Protocol' -Value ''
New-Item -Path "$classes\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$classes\DefaultIcon" -Name '(default)' -Value "`"$out`",0"
Set-ItemProperty -Path "$classes\shell\open\command" -Name '(default)' -Value "`"$out`" `"%1`""
$caps = 'HKCU:\Software\Mailclient\Capabilities'
New-Item -Path "$caps\URLAssociations" -Force | Out-Null
Set-ItemProperty -Path $caps -Name 'ApplicationName' -Value 'Mailclient'
Set-ItemProperty -Path $caps -Name 'ApplicationDescription' -Value 'Werbefreier Mail-Client fuer mehrere Konten'
Set-ItemProperty -Path "$caps\URLAssociations" -Name 'mailto' -Value $progId
New-Item -Path 'HKCU:\Software\RegisteredApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'Mailclient' -Value 'Software\Mailclient\Capabilities'
Write-Host "Als E-Mail-App angemeldet. Einmalig: Einstellungen > Apps > Standard-Apps > Mailclient > MAILTO."
Write-Host "Fertig: $out"
