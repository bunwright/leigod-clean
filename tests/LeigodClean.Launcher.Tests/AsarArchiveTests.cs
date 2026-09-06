using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace LeigodClean.Tests;

public sealed class AsarArchiveTests
{
    [Fact]
    public void PatchEntryReplacesOnlyTargetAndUpdatesIntegrity()
    {
        byte[] originalMain = Encoding.UTF8.GetBytes(new string('x', 206));
        byte[] other = Encoding.UTF8.GetBytes("untouched-data");
        byte[] source = CreateArchive(new Dictionary<string, byte[]>
        {
            ["dist/main/main.js"] = originalMain,
            ["package.json"] = Encoding.UTF8.GetBytes("{\"version\":\"11.0.23\"}"),
            ["assets/value.txt"] = other,
        });
        byte[] replacement = Encoding.UTF8.GetBytes("require('local-runtime')");

        byte[] patched = AsarArchive.Parse(source).PatchEntry("dist/main/main.js", replacement);
        AsarArchive result = AsarArchive.Parse(patched);

        Assert.Equal("require('local-runtime')", result.ReadText("dist/main/main.js").TrimEnd());
        Assert.Equal(other, result.ReadBytes("assets/value.txt"));

        JsonObject header = ReadHeader(patched);
        JsonObject entry = (JsonObject)header["files"]!["dist"]!["files"]!["main"]!["files"]!["main.js"]!;
        byte[] padded = new byte[206];
        padded.AsSpan().Fill((byte)' ');
        replacement.CopyTo(padded, 0);
        string expectedHash = Convert.ToHexStringLower(SHA256.HashData(padded));
        Assert.Equal(expectedHash, entry["integrity"]!["hash"]!.GetValue<string>());
    }

    [Fact]
    public void PatchEntryRejectsReplacementLargerThanOriginalEntry()
    {
        byte[] source = CreateArchive(new Dictionary<string, byte[]>
        {
            ["dist/main/main.js"] = Encoding.UTF8.GetBytes("small"),
        });

        AsarArchive archive = AsarArchive.Parse(source);
        Assert.Throws<InvalidOperationException>(() =>
            archive.PatchEntry("dist/main/main.js", Encoding.UTF8.GetBytes("too large")));
    }

    [Fact]
    public void LoaderScriptFitsOfficialMainEntryAndUsesLocalRuntime()
    {
        int byteCount = Encoding.UTF8.GetByteCount(LeigodPatcher.LoaderScript);

        Assert.InRange(byteCount, 1, 206);
        Assert.Contains("process.resourcesPath", LeigodPatcher.LoaderScript, StringComparison.Ordinal);
        Assert.Contains("/leigodclean/main.cjs", LeigodPatcher.LoaderScript, StringComparison.Ordinal);
        Assert.DoesNotContain("LOCALAPPDATA", LeigodPatcher.LoaderScript, StringComparison.Ordinal);
        Assert.Contains("require(\"./main.jsc\")", LeigodPatcher.LoaderScript, StringComparison.Ordinal);
        Assert.DoesNotContain("remote-debugging", LeigodPatcher.LoaderScript, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ws://", LeigodPatcher.LoaderScript, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LegacyPatchMigrationUsesAndPreservesAVerifiedStockBackup()
    {
        string installRoot = CreateTemporaryInstall();
        string resources = Path.Combine(installRoot, "resources");
        string archivePath = Path.Combine(resources, "app.asar");
        string backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
        byte[] stock = CreateClientArchive(
            "require(\"bytenode\");require(\"./main.jsc\")".PadRight(206),
            "11.3.2.5");
        byte[] legacy = CreateClientArchive(
            "/* MonitoringManager legacy patch */".PadRight(206),
            "11.3.2.5");

        try
        {
            File.WriteAllBytes(archivePath, legacy);
            File.WriteAllBytes(backupPath, stock);

            var patcher = new LeigodPatcher(installRoot);
            patcher.Apply();

            Assert.Equal(PatchState.Current, patcher.Inspect().State);
            Assert.Equal(stock, File.ReadAllBytes(backupPath));
        }
        finally
        {
            Directory.Delete(installRoot, true);
        }
    }

    [Fact]
    public void LegacyPatchWithoutVerifiedStockBackupIsNotRecordedAsOriginal()
    {
        string installRoot = CreateTemporaryInstall();
        string resources = Path.Combine(installRoot, "resources");
        string archivePath = Path.Combine(resources, "app.asar");
        string backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
        byte[] legacy = CreateClientArchive(
            "/* MonitoringManager legacy patch */".PadRight(206),
            "11.3.2.5");

        try
        {
            File.WriteAllBytes(archivePath, legacy);

            var patcher = new LeigodPatcher(installRoot);
            Assert.Throws<InvalidOperationException>(() => patcher.Apply());

            Assert.False(File.Exists(backupPath));
            Assert.Equal(legacy, File.ReadAllBytes(archivePath));
        }
        finally
        {
            Directory.Delete(installRoot, true);
        }
    }

    [Fact]
    public void RestoreRejectsAStockBackupFromAnotherClientVersion()
    {
        string installRoot = CreateTemporaryInstall();
        string resources = Path.Combine(installRoot, "resources");
        string archivePath = Path.Combine(resources, "app.asar");
        string backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
        byte[] stock = CreateClientArchive(
            "require(\"bytenode\");require(\"./main.jsc\")".PadRight(206),
            "11.3.2.4");
        byte[] current = CreateClientArchive(LeigodPatcher.LoaderScript.PadRight(206), "11.3.2.5");

        try
        {
            File.WriteAllBytes(archivePath, current);
            File.WriteAllBytes(backupPath, stock);

            var patcher = new LeigodPatcher(installRoot);
            Assert.Throws<InvalidOperationException>(() => patcher.Restore());

            Assert.Equal(current, File.ReadAllBytes(archivePath));
        }
        finally
        {
            Directory.Delete(installRoot, true);
        }
    }

    [Fact]
    public void RestoreLeavesAnAlreadyStockClientUntouched()
    {
        string installRoot = CreateTemporaryInstall();
        string resources = Path.Combine(installRoot, "resources");
        string archivePath = Path.Combine(resources, "app.asar");
        string backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
        byte[] stock = CreateClientArchive(
            "require(\"bytenode\");require(\"./main.jsc\")".PadRight(206),
            "11.3.2.5");
        byte[] staleBackup = CreateClientArchive(
            "require(\"bytenode\");require(\"./main.jsc\")".PadRight(206),
            "11.3.2.4");

        try
        {
            File.WriteAllBytes(archivePath, stock);
            File.WriteAllBytes(backupPath, staleBackup);

            new LeigodPatcher(installRoot).Restore();

            Assert.Equal(stock, File.ReadAllBytes(archivePath));
        }
        finally
        {
            Directory.Delete(installRoot, true);
        }
    }

    [Fact]
    public void RestoreUsesTheVerifiedStockBackupForTheSameClientVersion()
    {
        string installRoot = CreateTemporaryInstall();
        string resources = Path.Combine(installRoot, "resources");
        string archivePath = Path.Combine(resources, "app.asar");
        string backupPath = Path.Combine(resources, "app.asar.leigodclean.original");
        byte[] stock = CreateClientArchive(
            "require(\"bytenode\");require(\"./main.jsc\")".PadRight(206),
            "11.3.2.5");
        byte[] current = CreateClientArchive(LeigodPatcher.LoaderScript.PadRight(206), "11.3.2.5");

        try
        {
            File.WriteAllBytes(archivePath, current);
            File.WriteAllBytes(backupPath, stock);

            var patcher = new LeigodPatcher(installRoot);
            patcher.Restore();

            Assert.Equal(PatchState.Stock, patcher.Inspect().State);
            Assert.Equal(stock, File.ReadAllBytes(archivePath));
        }
        finally
        {
            Directory.Delete(installRoot, true);
        }
    }

    private static string CreateTemporaryInstall()
    {
        string installRoot = Path.Combine(
            Path.GetTempPath(),
            "LeigodClean.Tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(installRoot, "resources"));
        return installRoot;
    }

    private static byte[] CreateClientArchive(string mainEntry, string version) =>
        CreateArchive(new Dictionary<string, byte[]>
        {
            ["dist/main/main.js"] = Encoding.UTF8.GetBytes(mainEntry),
            ["package.json"] = Encoding.UTF8.GetBytes($"{{\"version\":\"{version}\"}}"),
        });

    private static byte[] CreateArchive(IReadOnlyDictionary<string, byte[]> entries)
    {
        var header = new JsonObject { ["files"] = new JsonObject() };
        using var data = new MemoryStream();
        foreach ((string path, byte[] content) in entries)
        {
            JsonObject files = (JsonObject)header["files"]!;
            string[] segments = path.Split('/');
            for (int index = 0; index < segments.Length - 1; index++)
            {
                if (files[segments[index]] is not JsonObject directory)
                {
                    directory = new JsonObject { ["files"] = new JsonObject() };
                    files[segments[index]] = directory;
                }
                files = (JsonObject)directory["files"]!;
            }

            long offset = data.Position;
            data.Write(content);
            files[segments[^1]] = new JsonObject
            {
                ["size"] = content.Length,
                ["offset"] = offset.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["integrity"] = new JsonObject
                {
                    ["algorithm"] = "SHA256",
                    ["hash"] = Convert.ToHexStringLower(SHA256.HashData(content)),
                    ["blockSize"] = 4 * 1024 * 1024,
                    ["blocks"] = new JsonArray(Convert.ToHexStringLower(SHA256.HashData(content))),
                },
            };
        }

        byte[] json = Encoding.UTF8.GetBytes(header.ToJsonString());
        int alignedStringLength = (json.Length + 4) & ~3;
        int headerPayloadSize = sizeof(int) + alignedStringLength;
        int headerPickleSize = sizeof(int) + headerPayloadSize;
        byte[] dataBytes = data.ToArray();
        byte[] archive = new byte[8 + headerPickleSize + dataBytes.Length];
        BinaryPrimitives.WriteInt32LittleEndian(archive.AsSpan(0, 4), 4);
        BinaryPrimitives.WriteInt32LittleEndian(archive.AsSpan(4, 4), headerPickleSize);
        BinaryPrimitives.WriteInt32LittleEndian(archive.AsSpan(8, 4), headerPayloadSize);
        BinaryPrimitives.WriteInt32LittleEndian(archive.AsSpan(12, 4), json.Length);
        json.CopyTo(archive.AsSpan(16));
        dataBytes.CopyTo(archive.AsSpan(8 + headerPickleSize));
        return archive;
    }

    private static JsonObject ReadHeader(byte[] archive)
    {
        int jsonLength = BinaryPrimitives.ReadInt32LittleEndian(archive.AsSpan(12, 4));
        return (JsonObject)JsonNode.Parse(archive.AsSpan(16, jsonLength))!;
    }
}
