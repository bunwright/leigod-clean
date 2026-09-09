using System.Text.Json;

namespace LeigodClean;

internal static class MinimalModeSettings
{
    internal static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LeigodClean",
        "settings.json");

    internal static bool IsEnabled()
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(SettingsPath));
            return document.RootElement.TryGetProperty("minimalMode", out JsonElement value) &&
                value.ValueKind == JsonValueKind.True;
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
}
