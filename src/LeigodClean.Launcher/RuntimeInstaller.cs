using System.Reflection;
using System.Security.Cryptography;

namespace LeigodClean;

internal static class RuntimeInstaller
{
    private static readonly string[] Files =
    [
        "main.cjs",
        "native-pipe.cjs",
        "process-observer.exe",
        "auto-acceleration.cjs",
        "local-games.cjs",
        "monitor.cjs",
        "process-events.cjs",
        "shutdown.cjs",
        "official-tray.cjs",
        "tray.cjs",
        "official-bridge.cjs",
        "preload.cjs",
        "community-processes.json",
        "product.json",
        "renderer/index.html",
        "renderer/styles.css",
        "renderer/view-state.js",
        "renderer/telemetry.js",
        "renderer/app.js",
        "assets/leigodclean.svg",
        "assets/leigodclean.png",
        "assets/leigodclean.ico",
    ];

    internal static string RuntimeRoot(string installRoot) => Path.Combine(
        Path.GetFullPath(installRoot),
        "resources",
        "leigodclean");

    public static bool IsCurrent(string installRoot)
    {
        Assembly assembly = typeof(RuntimeInstaller).Assembly;
        string runtimeRoot = RuntimeRoot(installRoot);
        return Files.All(relativePath =>
        {
            string destination = DestinationPath(runtimeRoot, relativePath);
            return File.Exists(destination) && FilesEqual(destination, ReadResource(assembly, relativePath));
        });
    }

    public static void Install(string installRoot)
    {
        Assembly assembly = typeof(RuntimeInstaller).Assembly;
        string runtimeRoot = RuntimeRoot(installRoot);
        Directory.CreateDirectory(runtimeRoot);

        foreach (string relativePath in Files)
        {
            byte[] content = ReadResource(assembly, relativePath);

            string destination = DestinationPath(runtimeRoot, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if (File.Exists(destination) && FilesEqual(destination, content))
            {
                continue;
            }

            string temporary = $"{destination}.{Environment.ProcessId}.tmp";
            File.WriteAllBytes(temporary, content);
            File.Move(temporary, destination, true);
        }

        WriteLauncherPath(runtimeRoot);

        AppLog.Information($"Runtime installed at {runtimeRoot}");
    }

    private static string DestinationPath(string runtimeRoot, string relativePath) =>
        Path.Combine(runtimeRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));

    private static byte[] ReadResource(Assembly assembly, string relativePath)
    {
        string resourceName = $"Runtime/{relativePath}";
        using Stream source = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"缺少内置运行时资源：{relativePath}");
        using var memory = new MemoryStream();
        source.CopyTo(memory);
        return memory.ToArray();
    }

    private static void WriteLauncherPath(string runtimeRoot)
    {
        string launcherPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法确定 LeigodClean 可执行文件路径。");
        string destination = Path.Combine(runtimeRoot, "launcher.path");
        string temporary = $"{destination}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, launcherPath);
        File.Move(temporary, destination, true);
    }

    private static bool FilesEqual(string path, byte[] content)
    {
        var file = new FileInfo(path);
        if (file.Length != content.Length)
        {
            return false;
        }

        using Stream stream = File.OpenRead(path);
        byte[] existingHash = SHA256.HashData(stream);
        byte[] contentHash = SHA256.HashData(content);
        return CryptographicOperations.FixedTimeEquals(existingHash, contentHash);
    }
}
