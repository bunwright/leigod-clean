using System.Text.Json;
using Xunit;

namespace LeigodClean.Tests;

public sealed class MinimalModeSettingsTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ModeChoiceRoundTrips(bool enabled)
    {
        string path = Path.GetTempFileName();
        try
        {
            MinimalModeSettings.WriteMode(path, enabled);

            Assert.True(MinimalModeSettings.TryReadMode(path, out bool actual));
            Assert.Equal(enabled, actual);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ModeChoicePreservesExistingPreferences()
    {
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, """{"graceMinutes":5,"notificationsEnabled":false}""");

            MinimalModeSettings.WriteMode(path, true);

            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            Assert.Equal(5, document.RootElement.GetProperty("graceMinutes").GetInt32());
            Assert.False(document.RootElement.GetProperty("notificationsEnabled").GetBoolean());
            Assert.True(document.RootElement.GetProperty("minimalMode").GetBoolean());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("{\"minimalMode\":null}")]
    [InlineData("{\"minimalMode\":\"true\"}")]
    public void MissingOrInvalidModeRequiresAChoice(string content)
    {
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, content);

            Assert.False(MinimalModeSettings.TryReadMode(path, out _));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
