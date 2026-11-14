// Starts the desktop engine, viewer listener and tunnel at sign-in without a console window (docs/CLOUDFLARE.md).
// The scheduled task runs this once per sign-in; start-cloudflare.ps1 refuses when the engine is already running.
using System;
using System.Diagnostics;
using System.IO;

internal static class AutostartLauncher
{
    private static int Main()
    {
        string scripts = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string root = Path.GetFullPath(Path.Combine(scripts, ".."));
        string log = Path.Combine(root, "data", "autostart.log");
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + Path.Combine(scripts, "start-cloudflare.ps1") + "\" -Mode Engine",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        int code;
        try
        {
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                code = child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Append(log, "launcher error: " + error.Message);
            return 1;
        }
        Append(log, "start-cloudflare.ps1 exit " + code);
        return code;
    }

    private static void Append(string path, string text)
    {
        try { File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text + Environment.NewLine); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
