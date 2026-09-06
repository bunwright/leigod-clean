using Microsoft.Win32;

namespace LeigodClean;

internal static class InstallationLocator
{
    private static readonly string[] RegistryRoots =
    [
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    public static string Find(string[] args)
    {
        string? explicitPath = ReadInstallDirectory(args);
        IEnumerable<string> candidates = CandidateDirectories(explicitPath);

        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(candidate);
            }
            catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
            {
                continue;
            }

            if (File.Exists(Path.Combine(fullPath, "leigod_launcher.exe")) &&
                File.Exists(Path.Combine(fullPath, "resources", "app.asar")))
            {
                return fullPath;
            }
        }

        throw new DirectoryNotFoundException(
            "未找到雷神加速器。可将 LeigodClean 放入雷神安装目录，或使用 --install-dir 指定路径。");
    }

    private static string? ReadInstallDirectory(string[] args)
    {
        for (int index = 0; index < args.Length - 1; index++)
        {
            if (string.Equals(args[index], "--install-dir", StringComparison.OrdinalIgnoreCase))
            {
                return args[index + 1];
            }
        }

        return null;
    }

    private static IEnumerable<string> CandidateDirectories(string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            yield return explicitPath;
        }

        yield return AppContext.BaseDirectory;
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "LeiGod_Acc");

        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                foreach (string directory in ReadRegistryCandidates(hive, view))
                {
                    yield return directory;
                }
            }
        }
    }

    private static IEnumerable<string> ReadRegistryCandidates(RegistryHive hive, RegistryView view)
    {
        using RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view);
        foreach (string rootPath in RegistryRoots)
        {
            using RegistryKey? root = baseKey.OpenSubKey(rootPath);
            if (root is null)
            {
                continue;
            }

            foreach (string subKeyName in root.GetSubKeyNames())
            {
                using RegistryKey? application = root.OpenSubKey(subKeyName);
                string displayName = application?.GetValue("DisplayName") as string ?? string.Empty;
                if (!displayName.Contains("雷神", StringComparison.OrdinalIgnoreCase) &&
                    !displayName.Contains("LeiGod", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (application?.GetValue("InstallLocation") is string location &&
                    !string.IsNullOrWhiteSpace(location))
                {
                    yield return location.Trim('"');
                }
            }
        }
    }
}
