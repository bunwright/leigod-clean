using System.Text.Json;
using System.Text.Json.Nodes;

namespace LeigodClean;

internal static class MinimalModeSettings
{
    internal static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LeigodClean",
        "settings.json");

    internal static bool IsEnabled()
    {
        return TryReadMode(SettingsPath, out bool enabled) && enabled;
    }

    internal static bool HasExplicitMode() => TryReadMode(SettingsPath, out _);

    internal static void WriteMode(bool enabled) => WriteMode(SettingsPath, enabled);

    internal static bool TryReadMode(string path, out bool enabled)
    {
        enabled = false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("minimalMode", out JsonElement value) ||
                value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return false;
            }
            enabled = value.GetBoolean();
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static void WriteMode(string path, bool enabled)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string resolved = Path.GetFullPath(path);
        string? directory = Path.GetDirectoryName(resolved);
        if (directory is null)
        {
            throw new InvalidOperationException("设置文件路径无效。");
        }
        Directory.CreateDirectory(directory);
        JsonObject root = ReadObject(resolved);
        root["minimalMode"] = enabled;
        string temporary = $"{resolved}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporary, root.ToJsonString(new JsonSerializerOptions
            {
                WriteIndented = true,
            }));
            File.Move(temporary, resolved, true);
        }
        finally
        {
            try
            {
                File.Delete(temporary);
            }
            catch (IOException)
            {
                // The destination was written successfully or another process holds the temporary file.
            }
            catch (UnauthorizedAccessException)
            {
                // Preserve the original write error if cleanup is not permitted.
            }
        }
    }

    private static JsonObject ReadObject(string path)
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject();
        }
        catch (IOException)
        {
            return new JsonObject();
        }
        catch (UnauthorizedAccessException)
        {
            return new JsonObject();
        }
        catch (JsonException)
        {
            return new JsonObject();
        }
    }
}
