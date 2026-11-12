// Runs ensure-standby.ps1 without a console window for the every-minute scheduled task (docs/LAPTOP-STANDBY.md).
using System;
using System.Diagnostics;
using System.IO;

internal static class StandbyLauncher
{
    private static int Main()
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(directory, "ensure-standby.ps1");
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"",
            WorkingDirectory = directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        try
        {
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            try { File.AppendAllText(Path.Combine(directory, "standby-launcher.err.log"), DateTime.UtcNow.ToString("o") + " " + error.Message + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return 1;
        }
    }
}
