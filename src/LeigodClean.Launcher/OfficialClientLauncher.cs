using System.Diagnostics;

namespace LeigodClean;

internal static class OfficialClientLauncher
{
    internal const string ExecutableName = "leigod_launcher.exe";

    internal static ProcessStartInfo CreateStartInfo(
        string installRoot,
        bool startInBackground,
        NativeBridgeOptions? nativeBridge = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installRoot);
        string fullInstallRoot = Path.GetFullPath(installRoot);
        var startInfo = new ProcessStartInfo
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
        if (nativeBridge is not null)
        {
            startInfo.Environment["LEIGOD_CLEAN_NATIVE_MODE"] = "1";
            startInfo.Environment["LEIGOD_CLEAN_NATIVE_PIPE"] = nativeBridge.PipeName;
            startInfo.Environment["LEIGOD_CLEAN_NATIVE_TOKEN"] = nativeBridge.Token;
        }
        return startInfo;
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

    internal static void LaunchNative(
        string installRoot,
        bool startInBackground,
        NativeBridgeOptions nativeBridge)
    {
        ProcessStartInfo startInfo = CreateStartInfo(installRoot, startInBackground, nativeBridge);
        if (!File.Exists(startInfo.FileName))
        {
            throw new FileNotFoundException("未找到雷神客户端启动程序。", startInfo.FileName);
        }

        Process launcher = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动雷神客户端。");
        _ = Task.Run(() =>
        {
            try
            {
                LauncherWindowSuppressor.HideUntilExit(launcher, TimeSpan.FromSeconds(30));
            }
            finally
            {
                launcher.Dispose();
            }
        });
    }
}

internal sealed record NativeBridgeOptions(string PipeName, string Token)
{
    internal static NativeBridgeOptions Create() => new(
        $"LeigodClean-{Environment.ProcessId}-{Guid.NewGuid():N}",
        Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)));
}
