using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LeigodClean;

public sealed class AsarArchive
{
    private const int OuterHeaderSize = 8;
    private const int HeaderPrefixSize = 8;

    private readonly byte[] _archive;
    private readonly JsonObject _header;
    private readonly int _dataOffset;

    private AsarArchive(byte[] archive, JsonObject header, int dataOffset)
    {
        _archive = archive;
        _header = header;
        _dataOffset = dataOffset;
    }

    public static AsarArchive Open(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        return Parse(File.ReadAllBytes(path));
    }

    public static AsarArchive Parse(byte[] archive)
    {
        ArgumentNullException.ThrowIfNull(archive);
        if (archive.Length < 16)
        {
            throw new InvalidDataException("ASAR 文件头不完整。");
        }

        int outerPayloadSize = BinaryPrimitives.ReadInt32LittleEndian(archive.AsSpan(0, 4));
        int headerPickleSize = BinaryPrimitives.ReadInt32LittleEndian(archive.AsSpan(4, 4));
        int headerPayloadSize = BinaryPrimitives.ReadInt32LittleEndian(archive.AsSpan(8, 4));
        int jsonLength = BinaryPrimitives.ReadInt32LittleEndian(archive.AsSpan(12, 4));
        int dataOffset = checked(OuterHeaderSize + headerPickleSize);

        if (outerPayloadSize != 4 ||
            headerPickleSize < HeaderPrefixSize ||
            headerPayloadSize != headerPickleSize - sizeof(int) ||
            jsonLength < 2 ||
            16L + jsonLength > archive.Length ||
            dataOffset > archive.Length)
        {
            throw new InvalidDataException("ASAR 文件头格式无效。");
        }

        JsonNode? parsed = JsonNode.Parse(archive.AsSpan(16, jsonLength));
        if (parsed is not JsonObject header || header["files"] is not JsonObject)
        {
            throw new InvalidDataException("ASAR 目录结构无效。");
        }

        return new AsarArchive(archive, header, dataOffset);
    }

    public string ReadText(string archivePath) =>
        Encoding.UTF8.GetString(ReadBytes(archivePath));

    public byte[] ReadBytes(string archivePath)
    {
        AsarEntry entry = GetEntry(archivePath);
        return _archive.AsSpan(checked(_dataOffset + entry.Offset), entry.Size).ToArray();
    }

    public byte[] PatchEntry(string archivePath, ReadOnlySpan<byte> replacement)
    {
        AsarEntry entry = GetEntry(archivePath);
        if (replacement.Length > entry.Size)
        {
            throw new InvalidOperationException(
                $"补丁入口为 {replacement.Length} 字节，超过原入口的 {entry.Size} 字节。");
        }

        byte[] padded = new byte[entry.Size];
        padded.AsSpan().Fill((byte)' ');
        replacement.CopyTo(padded);

        byte[] data = _archive.AsSpan(_dataOffset).ToArray();
        padded.CopyTo(data.AsSpan(entry.Offset, entry.Size));

        JsonObject header = (JsonObject)_header.DeepClone();
        JsonObject entryNode = GetEntryNode(header, archivePath);
        UpdateIntegrity(entryNode, padded);
        return Compose(header, data);
    }

    private static byte[] Compose(JsonObject header, byte[] data)
    {
        var options = new JsonSerializerOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            WriteIndented = false,
        };
        byte[] json = Encoding.UTF8.GetBytes(header.ToJsonString(options));
        int alignedStringLength = AlignToFour(checked(json.Length + 1));
        int headerPayloadSize = checked(sizeof(int) + alignedStringLength);
        int headerPickleSize = checked(sizeof(int) + headerPayloadSize);
        byte[] output = new byte[checked(OuterHeaderSize + headerPickleSize + data.Length)];

        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(0, 4), 4);
        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(4, 4), headerPickleSize);
        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(8, 4), headerPayloadSize);
        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(12, 4), json.Length);
        json.CopyTo(output.AsSpan(16));
        data.CopyTo(output.AsSpan(OuterHeaderSize + headerPickleSize));
        return output;
    }

    private static int AlignToFour(int value) => checked((value + 3) & ~3);

    private static void UpdateIntegrity(JsonObject entry, byte[] content)
    {
        string hash = Convert.ToHexStringLower(SHA256.HashData(content));
        int blockSize = entry["integrity"]?["blockSize"]?.GetValue<int>() ?? 4 * 1024 * 1024;
        var blocks = new JsonArray();
        for (int offset = 0; offset < content.Length; offset += blockSize)
        {
            int length = Math.Min(blockSize, content.Length - offset);
            blocks.Add((JsonNode?)JsonValue.Create(
                Convert.ToHexStringLower(SHA256.HashData(content.AsSpan(offset, length)))));
        }

        entry["integrity"] = new JsonObject
        {
            ["algorithm"] = "SHA256",
            ["hash"] = hash,
            ["blockSize"] = blockSize,
            ["blocks"] = blocks,
        };
    }

    private AsarEntry GetEntry(string archivePath)
    {
        JsonObject node = GetEntryNode(_header, archivePath);
        if (node["unpacked"]?.GetValue<bool>() == true)
        {
            throw new NotSupportedException($"ASAR 外置条目不受支持：{archivePath}");
        }

        int size = node["size"]?.GetValue<int>()
            ?? throw new InvalidDataException($"ASAR 条目缺少大小：{archivePath}");
        string offsetText = node["offset"]?.ToString()
            ?? throw new InvalidDataException($"ASAR 条目缺少偏移：{archivePath}");
        if (!int.TryParse(offsetText, out int offset) || size < 0 || offset < 0)
        {
            throw new InvalidDataException($"ASAR 条目范围无效：{archivePath}");
        }

        if ((long)_dataOffset + offset + size > _archive.Length)
        {
            throw new InvalidDataException($"ASAR 条目超出文件范围：{archivePath}");
        }

        return new AsarEntry(offset, size);
    }

    private static JsonObject GetEntryNode(JsonObject header, string archivePath)
    {
        JsonObject current = header;
        foreach (string segment in archivePath.Split(
                     ['/', '\\'],
                     StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (current["files"] is not JsonObject files || files[segment] is not JsonObject next)
            {
                throw new FileNotFoundException($"ASAR 中不存在条目：{archivePath}");
            }

            current = next;
        }

        return current;
    }

    private readonly record struct AsarEntry(int Offset, int Size);
}
