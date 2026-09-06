using System.Diagnostics;

namespace LeigodClean;

internal static class OfficialClientLauncher
{
    internal const string ExecutableName = "leigod_launcher.exe";

    internal static ProcessStartInfo CreateStartInfo(string installRoot, bool startInBackground)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installRoot);
        string fullInstallRoot = Path.GetFullPath(installRoot);
        return new ProcessStartInfo
        {
            FileName = Path.Combine(fullInstallRoot, ExecutableName),
            WorkingDirectory = fullInstallRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            Environment =
            {
                ["LEIGOD_CLEAN_START_HIDDEN"] = startInBackground ? "1" : "0",
            },
        };
    }

    internal static void Launch(string installRoot, bool startInBackground)
    {
        ProcessStartInfo startInfo = CreateStartInfo(installRoot, startInBackground);
        if (!File.Exists(startInfo.FileName))
        {
            throw new FileNotFoundException("未找到雷神客户端启动程序。", startInfo.FileName);
        }

        using Process launcher = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动雷神客户端。");
        LauncherWindowSuppressor.HideUntilExit(launcher, TimeSpan.FromSeconds(30));
    }
}
