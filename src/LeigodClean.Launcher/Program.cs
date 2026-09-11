using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace LeigodClean;

internal static class Program
{
    private const string ElevatedLaunchArgument = "--elevated-launch";
    private const string RestoreArgument = "--restore";

    [STAThread]
    private static int Main(string[] args)
    {
        AppLog.Initialize();
        bool diagnosticMode = args.Contains("--minimal-ui-smoke-test", StringComparer.OrdinalIgnoreCase) ||
            args.Contains("--minimal-ui-preview", StringComparer.OrdinalIgnoreCase);

        try
        {
            if (args.Contains("--minimal-ui-smoke-test", StringComparer.OrdinalIgnoreCase))
            {
                return MinimalApplication.SmokeTest();
            }
            if (args.Length >= 2 &&
                string.Equals(args[0], "--minimal-ui-preview", StringComparison.OrdinalIgnoreCase))
            {
                return MinimalApplication.RenderPreview(args[1]);
            }

            WaitForRestartTarget(args);

            bool startInBackground = args.Contains("--background", StringComparer.OrdinalIgnoreCase);
            if (TryReadModePath(args, ElevatedLaunchArgument, out string? launchRoot))
            {
                return ApplyAndLaunch(launchRoot, startInBackground);
            }

            if (TryReadModePath(args, RestoreArgument, out string? restoreRoot))
            {
                return RestorePatch(restoreRoot);
            }

            string installRoot = InstallationLocator.Find(args);
            var patcher = new LeigodPatcher(installRoot);
            PatchInspection? inspection = TryInspect(patcher);
            if (!RuntimeInstaller.IsCurrent(installRoot) || inspection?.State != PatchState.Current)
            {
                EnsureClientIsClosed();
            }

            if (!IsAdministrator())
            {
                return RunElevated(ElevatedLaunchArgument, installRoot, startInBackground);
            }

            RuntimeInstaller.Install(installRoot);
            TryApplyPatch(patcher);
            LaunchClient(installRoot, startInBackground);
            return 0;
        }
        catch (OperationCanceledException)
        {
            return 1;
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            AppLog.Information("Administrator authorization was canceled");
            return 1;
        }
        catch (Exception exception)
        {
            AppLog.Error("Launcher failed", exception);
            if (!diagnosticMode)
            {
                NativeDialog.Error("LeigodClean", exception.Message);
            }
            return 1;
        }
    }

    private static int ApplyAndLaunch(string installRoot, bool startInBackground)
    {
        if (!IsAdministrator())
        {
            throw new InvalidOperationException("启动雷神客户端需要管理员权限。");
        }

        var patcher = new LeigodPatcher(installRoot);
        if (TryInspect(patcher)?.State != PatchState.Current)
        {
            EnsureClientIsClosed();
        }
        else if (!RuntimeInstaller.IsCurrent(installRoot))
        {
            EnsureClientIsClosed();
        }
        RuntimeInstaller.Install(installRoot);
        TryApplyPatch(patcher);
        LaunchClient(installRoot, startInBackground);
        return 0;
    }

    private static void LaunchClient(string installRoot, bool startInBackground)
    {
        InitialModeSelector.EnsureSelected();
        if (!MinimalModeSettings.IsEnabled())
        {
            OfficialClientLauncher.Launch(installRoot, startInBackground);
            return;
        }

        NativeBridgeOptions options = NativeBridgeOptions.Create();
        OfficialClientLauncher.LaunchNative(installRoot, startInBackground, options);
        MinimalApplication.Run(options, startInBackground);
    }

    private static PatchInspection? TryInspect(LeigodPatcher patcher)
    {
        try
        {
            return patcher.Inspect();
        }
        catch (Exception exception)
        {
            AppLog.Error("Could not inspect the official client entry", exception);
            return null;
        }
    }

    private static void TryApplyPatch(LeigodPatcher patcher)
    {
        try
        {
            if (patcher.Inspect().State != PatchState.Current)
            {
                patcher.Apply();
            }
        }
        catch (Exception exception)
        {
            AppLog.Error("LeigodClean compatibility setup failed; launching the official interface", exception);
        }
    }

    private static int RestorePatch(string installRoot)
    {
        if (!IsAdministrator())
        {
            return RunElevated(RestoreArgument, installRoot, false);
        }

        EnsureClientIsClosed();
        new LeigodPatcher(installRoot).Restore();
        NativeDialog.Information("LeigodClean", "已恢复雷神客户端原始入口。");
        return 0;
    }

    private static bool TryReadModePath(string[] args, string mode, out string path)
    {
        path = string.Empty;
        if (args.Length < 2 || !string.Equals(args[0], mode, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        path = Path.GetFullPath(args[1]);
        return true;
    }

    private static void EnsureClientIsClosed()
    {
        Process[] processes = [
            .. Process.GetProcessesByName("leigod"),
            .. Process.GetProcessesByName("leigod_launcher"),
        ];
        bool isRunning;
        try
        {
            isRunning = processes.Any(process => !process.HasExited);
        }
        finally
        {
            foreach (Process process in processes)
            {
                process.Dispose();
            }
        }

        if (isRunning)
        {
            throw new InvalidOperationException(
                "需要更新 LeigodClean 或客户端入口。请先退出正在运行的雷神加速器，然后重试。");
        }
    }

    private static bool IsAdministrator()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static void WaitForRestartTarget(string[] args)
    {
        for (int index = 0; index < args.Length - 1; index++)
        {
            if (!string.Equals(args[index], "--restart-wait", StringComparison.OrdinalIgnoreCase) ||
                !int.TryParse(args[index + 1], out int processId) || processId <= 0 ||
                processId == Environment.ProcessId)
            {
                continue;
            }
            try
            {
                using Process process = Process.GetProcessById(processId);
                if (!process.WaitForExit(30000))
                {
                    throw new TimeoutException("等待旧版 LeigodClean 退出超时。");
                }
            }
            catch (ArgumentException)
            {
                // The previous process has already exited.
            }
            return;
        }
    }

    private static int RunElevated(string mode, string installRoot, bool startInBackground)
    {
        string executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法确定当前可执行文件路径。");
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = true,
            Verb = "runas",
        };
        startInfo.ArgumentList.Add(mode);
        startInfo.ArgumentList.Add(installRoot);
        if (startInBackground)
        {
            startInfo.ArgumentList.Add("--background");
        }

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动提权补丁进程。");
        process.WaitForExit();
        return process.ExitCode;
    }

}
