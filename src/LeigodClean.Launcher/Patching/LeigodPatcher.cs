using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LeigodClean;

public enum PatchState
{
    Current,
    Stock,
    LegacyPatch,
    Unknown,
}

public sealed record PatchInspection(PatchState State, string Version, string MainEntry);

public sealed class LeigodPatcher
{
    public const string LoaderScript =
        "try{require(process.resourcesPath+\"/leigodclean/main.cjs\")(require)}catch(e){require(\"electron\").dialog.showErrorBox(\"LeigodClean\",e.stack||\"\"+e);require(\"bytenode\");require(\"./main.jsc\")}";

    private readonly string _archivePath;
    private readonly string _legacyBackupPath;
    private readonly string _backupPath;

    public LeigodPatcher(string installRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installRoot);
        string resources = Path.Combine(Path.GetFullPath(installRoot), "resources");
        _archivePath = Path.Combine(resources, "app.asar");
        _legacyBackupPath = Path.Combine(resources, "app.asar.bak");
        _backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
    }

    public PatchInspection Inspect() => InspectArchive(_archivePath);

    public void Apply()
    {
        PatchInspection current = Inspect();
        if (current.State == PatchState.Current)
        {
            return;
        }

        string sourcePath = SelectSource(current);
        PatchInspection source = InspectArchive(sourcePath);
        if (source.State != PatchState.Stock)
        {
            throw new InvalidOperationException(
                "无法识别雷神客户端入口。请先通过官方安装程序修复客户端后重试。");
        }

        PreserveOriginal(sourcePath, source.Version);
        AsarArchive archive = AsarArchive.Open(sourcePath);
        byte[] patched = archive.PatchEntry("dist/main/main.js", Encoding.UTF8.GetBytes(LoaderScript));
        ReplaceArchive(patched);

        PatchInspection result = Inspect();
        if (result.State != PatchState.Current)
        {
            throw new InvalidOperationException("客户端入口补丁校验失败。");
        }

        AppLog.Information($"Patched Leigod {result.Version}; sha256={HashFile(_archivePath)}");
    }

    public void Restore()
    {
        PatchInspection current = Inspect();
        if (current.State == PatchState.Stock)
        {
            AppLog.Information("Official Leigod archive is already restored");
            return;
        }

        if (current.State != PatchState.Current)
        {
            throw new InvalidOperationException(
                "当前客户端入口不是可安全恢复的 LeigodClean 补丁。请使用官方安装程序修复客户端。");
        }

        if (!File.Exists(_backupPath))
        {
            throw new FileNotFoundException("未找到 LeigodClean 创建的原始入口备份。", _backupPath);
        }

        PatchInspection backup = InspectArchive(_backupPath);
        if (backup.State != PatchState.Stock || backup.Version != current.Version)
        {
            throw new InvalidOperationException(
                "原始入口备份与当前客户端版本不匹配。请使用官方安装程序修复客户端。");
        }

        string temporary = $"{_archivePath}.{Environment.ProcessId}.restore";
        File.Copy(_backupPath, temporary, true);
        try
        {
            File.Move(temporary, _archivePath, true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }

        PatchInspection restored = Inspect();
        if (restored.State != PatchState.Stock || restored.Version != current.Version)
        {
            throw new InvalidOperationException("客户端原始入口恢复校验失败。");
        }
        AppLog.Information("Restored original Leigod archive");
    }

    private string SelectSource(PatchInspection current)
    {
        if (current.State == PatchState.Stock)
        {
            return _archivePath;
        }

        if (current.State == PatchState.LegacyPatch)
        {
            foreach (string candidate in new[] { _backupPath, _legacyBackupPath })
            {
                if (IsCompatibleStockArchive(candidate, current.Version))
                {
                    return candidate;
                }
            }
        }

        return _archivePath;
    }

    private void PreserveOriginal(string sourcePath, string sourceVersion)
    {
        if (File.Exists(_backupPath))
        {
            try
            {
                PatchInspection backup = InspectArchive(_backupPath);
                if (backup.Version == sourceVersion && backup.State == PatchState.Stock &&
                    string.Equals(HashFile(_backupPath), HashFile(sourcePath), StringComparison.Ordinal))
                {
                    return;
                }
            }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException)
            {
                AppLog.Information("Existing original archive backup is unreadable and will be refreshed");
            }
        }

        File.Copy(sourcePath, _backupPath, true);
    }

    private static bool IsCompatibleStockArchive(string path, string expectedVersion)
    {
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            PatchInspection inspection = InspectArchive(path);
            return inspection.State == PatchState.Stock && inspection.Version == expectedVersion;
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException)
        {
            AppLog.Information($"Ignored unreadable archive backup: {Path.GetFileName(path)}");
            return false;
        }
    }

    private void ReplaceArchive(byte[] content)
    {
        string temporary = $"{_archivePath}.{Environment.ProcessId}.tmp";
        File.WriteAllBytes(temporary, content);
        try
        {
            File.Move(temporary, _archivePath, true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private static PatchInspection InspectArchive(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("未找到雷神客户端 app.asar。", path);
        }

        AsarArchive archive = AsarArchive.Open(path);
        string main = archive.ReadText("dist/main/main.js").TrimEnd();
        string packageJson = archive.ReadText("package.json");
        string version = JsonDocument.Parse(packageJson).RootElement
            .GetProperty("version")
            .GetString() ?? "unknown";

        PatchState state;
        if (string.Equals(main, LoaderScript, StringComparison.Ordinal))
        {
            state = PatchState.Current;
        }
        else if (main.Contains("require(\"./main.jsc\")", StringComparison.Ordinal) && main.Length < 4096)
        {
            state = PatchState.Stock;
        }
        else if (main.Contains("MonitoringManager", StringComparison.Ordinal) ||
                 main.Contains("leigod-auto-pause", StringComparison.OrdinalIgnoreCase) ||
                 main.Contains("Leigod Smart Monitor", StringComparison.Ordinal) ||
                 (main.Contains("LeigodClean", StringComparison.Ordinal) &&
                  main.Contains("runtime", StringComparison.Ordinal)))
        {
            state = PatchState.LegacyPatch;
        }
        else
        {
            state = PatchState.Unknown;
        }

        return new PatchInspection(state, version, main);
    }

    private static string HashFile(string path)
    {
        using Stream stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }
}
