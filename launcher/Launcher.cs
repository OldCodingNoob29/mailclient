using System.Linq;
// Mailclient-Starter: baut bei geaenderten Quellen automatisch neu und startet dann die App.
// Der Repo-Pfad wird beim Kompilieren eingebacken (siehe scripts/build-launcher.ps1),
// die exe darf deshalb beliebig kopiert oder verknuepft werden.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string Repo = @"__REPO__";
    // Muss mit app.setAppUserModelId() in src/main/index.ts uebereinstimmen, damit
    // Windows Starter und App-Fenster als dasselbe Programm behandelt.
    const string AppUserModelId = "de.tim.mailclient.app";

    [DllImport("shell32.dll", SetLastError = true)]
    static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);

    static DateTime Stamp(string file)
    {
        return File.Exists(file) ? File.GetLastWriteTimeUtc(file) : DateTime.MinValue;
    }

    static bool Stale()
    {
        var built = Stamp(Path.Combine(Repo, "out", "main", "index.js"));
        var src = DateTime.MinValue;
        var dir = Path.Combine(Repo, "src");
        if (Directory.Exists(dir))
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                var m = File.GetLastWriteTimeUtc(f);
                if (m > src) src = m;
            }
        foreach (var f in new[] { "package.json", "electron.vite.config.ts", "tsconfig.node.json", "tsconfig.web.json" })
        {
            var m = Stamp(Path.Combine(Repo, f));
            if (m > src) src = m;
        }
        return src > built;
    }

    static string ReadOrEmpty(string file)
    {
        try { return File.ReadAllText(file).Trim(); } catch { return ""; }
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from))
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(from))
            CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    /*
      Die App laeuft nicht ueber node_modules\electron\dist\electron.exe, sondern
      ueber eine eigene Kopie der Laufzeit in runtime\, deren Programmdatei
      Mailclient.exe heisst und das App-Icon traegt. Sonst steht in Taskleiste und
      Task-Manager "Electron", und ein angeheftetes Fenster startet ein nacktes
      electron.exe ohne App. runtime\resources\app enthaelt nur einen Verweis auf
      den Build im Repo (out\), die Kopie muss also nur neu entstehen, wenn sich
      die Electron-Version aendert.
    */
    static string EnsureRuntime()
    {
        var dist = Path.Combine(Repo, "node_modules", "electron", "dist");
        var runtime = Path.Combine(Repo, "runtime");
        var exe = Path.Combine(runtime, "Mailclient.exe");
        var version = ReadOrEmpty(Path.Combine(dist, "version"));
        var have = ReadOrEmpty(Path.Combine(runtime, "version"));

        if (!File.Exists(exe) || (version != "" && version != have))
        {
            if (!File.Exists(Path.Combine(dist, "electron.exe"))) return File.Exists(exe) ? exe : null;
            try
            {
                CopyDir(dist, runtime);
                if (File.Exists(exe)) File.Delete(exe);
                File.Move(Path.Combine(runtime, "electron.exe"), exe);

                var rcedit = Path.Combine(Repo, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
                var icon = Path.Combine(Repo, "build", "icon.ico");
                if (File.Exists(rcedit) && File.Exists(icon))
                {
                    var psi = new ProcessStartInfo(rcedit,
                        "\"" + exe + "\" --set-icon \"" + icon + "\"" +
                        " --set-version-string \"ProductName\" \"Mailclient\"" +
                        " --set-version-string \"FileDescription\" \"Mailclient\"")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using (var p = Process.Start(psi)) p.WaitForExit();
                }
            }
            catch
            {
                // Laeuft die App gerade, ist die Datei gesperrt - dann bleibt die
                // vorhandene Laufzeit, und der naechste Start versucht es erneut.
                return File.Exists(exe) ? exe : null;
            }
        }

        // Der Verweis auf den Build. Ohne ihn zeigte die Laufzeit Electrons Standard-App.
        var appDir = Path.Combine(runtime, "resources", "app");
        Directory.CreateDirectory(appDir);
        var main = Path.Combine(Repo, "out", "main", "index.js").Replace("\\", "/");
        File.WriteAllText(Path.Combine(appDir, "package.json"),
            "{ \"name\": \"mailclient\", \"productName\": \"Mailclient\", \"version\": \"0.1.0\", \"main\": \"main.js\" }");
        File.WriteAllText(Path.Combine(appDir, "main.js"), "require(" + "\"" + main + "\"" + ")\n");
        return exe;
    }

    static bool RunBuild()
    {
        var splash = new Form
        {
            Text = "Mailclient",
            Width = 320,
            Height = 90,
            FormBorderStyle = FormBorderStyle.FixedToolWindow,
            StartPosition = FormStartPosition.CenterScreen,
            TopMost = true
        };
        splash.Controls.Add(new Label
        {
            Text = "Mailclient wird aktualisiert ...",
            Dock = DockStyle.Fill,
            TextAlign = System.Drawing.ContentAlignment.MiddleCenter
        });

        bool ok = true;
        string log = "";

        // Der Build laeuft auf einem Hintergrund-Thread; die Splash-Form bekommt
        // ueber Application.Run() einen richtigen Nachrichtenloop.
        splash.Shown += (s, e) =>
        {
            var worker = new Thread(() =>
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c npm run build")
                {
                    WorkingDirectory = Repo,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    p.OutputDataReceived += (s2, e2) => { if (e2.Data != null) log += e2.Data + "\n"; };
                    p.ErrorDataReceived += (s2, e2) => { if (e2.Data != null) log += e2.Data + "\n"; };
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    p.WaitForExit();
                    ok = p.ExitCode == 0;
                }
                if (!splash.IsDisposed) splash.BeginInvoke((Action)(() => splash.Close()));
            });
            worker.IsBackground = true;
            worker.Start();
        };
        Application.Run(splash);

        if (!ok)
        {
            if (log.Length > 1500) log = log.Substring(log.Length - 1500);
            MessageBox.Show("Build fehlgeschlagen, es startet die letzte funktionierende Version.\n\n" + log,
                "Mailclient", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return ok;
    }

    [STAThread]
    static void Main()
    {
        try { SetCurrentProcessExplicitAppUserModelID(AppUserModelId); } catch { /* egal, dann eben ohne */ }

        if (!Directory.Exists(Repo))
        {
            MessageBox.Show("Repo nicht gefunden:\n" + Repo, "Mailclient", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (Stale()) RunBuild();

        var exe = EnsureRuntime();
        if (exe == null || !File.Exists(Path.Combine(Repo, "out", "main", "index.js")))
        {
            MessageBox.Show("Keine Installation gefunden. Im Repo 'npm ci' und 'npm run build' ausfuehren.", "Mailclient", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        // Argumente durchreichen: Windows uebergibt hier den mailto:-Link, wenn der Client Standard-App fuer E-Mail ist.
        var args = string.Join(" ", Environment.GetCommandLineArgs().Skip(1).Select(a => "\"" + a.Replace("\"", "\\\"") + "\""));
        Process.Start(new ProcessStartInfo(exe, args) { WorkingDirectory = Repo, UseShellExecute = false });
    }
}
