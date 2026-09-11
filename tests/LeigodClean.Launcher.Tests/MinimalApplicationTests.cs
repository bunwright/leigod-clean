using System.Text.Json.Nodes;
using Xunit;

namespace LeigodClean.Tests;

public sealed class MinimalApplicationTests
{
    [Fact]
    public void AccelerationCompletesOnlyForTheMatchingSpeedingGame()
    {
        var client = new JsonObject
        {
            ["gameId"] = 42,
            ["accStatus"] = "speeding",
        };

        Assert.True(MinimalMainForm.IsAccelerationConfirmed(client, 42));
        Assert.False(MinimalMainForm.IsAccelerationConfirmed(client, 41));
        client["accStatus"] = "loading";
        Assert.False(MinimalMainForm.IsAccelerationConfirmed(client, 42));
    }

    [Theory]
    [InlineData(39120, 39120D)]
    [InlineData(39120L, 39120D)]
    [InlineData(39120.5D, 39120.5D)]
    public void NumericStateAcceptsIntegerAndFloatingPointValues(object source, double expected)
    {
        var state = new JsonObject { ["totalTimeLeft"] = JsonValue.Create(source) };

        Assert.Equal(expected, MinimalMainForm.GetDouble(state, "totalTimeLeft"));
    }

    [Fact]
    public void ProcessEditorUsesResolvedProcessesUntilAnOverrideExists()
    {
        var resolved = new JsonArray(JsonValue.Create("game.exe"));
        var custom = new JsonArray(JsonValue.Create("custom.exe"));
        var game = new JsonObject
        {
            ["id"] = 42,
            ["processes"] = resolved,
        };
        var settings = new JsonObject { ["processOverrides"] = new JsonObject() };

        Assert.Same(resolved, MinimalSettingsForm.ResolveDisplayedProcesses(settings, game));
        settings["processOverrides"]!["42"] = custom;
        Assert.Same(custom, MinimalSettingsForm.ResolveDisplayedProcesses(settings, game));
    }
}
