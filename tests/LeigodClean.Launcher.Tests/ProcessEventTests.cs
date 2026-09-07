using System.Text.Json;
using Xunit;

namespace LeigodClean.Launcher.Tests;

public sealed class ProcessEventTests
{
    [Theory]
    [InlineData("Game", "Game.exe")]
    [InlineData("Launcher.EXE", "Launcher.EXE")]
    [InlineData(@"C:\Games\Client.exe", "Client.exe")]
    [InlineData("", "")]
    [InlineData("bad:name", "")]
    public void NormalizesProcessNames(string input, string expected)
    {
        Assert.Equal(expected, ProcessRegistry.NormalizeName(input));
    }

    [Fact]
    public void TracksDuplicateNamesByPid()
    {
        var registry = new ProcessRegistry();

        Assert.True(registry.Start(10, "Game.exe"));
        Assert.True(registry.Start(11, "game.exe"));
        Assert.True(registry.Stop(10, "Game.exe"));
        Assert.Single(registry.Snapshot());
        Assert.True(registry.Stop(11, "GAME.EXE"));
        Assert.Empty(registry.Snapshot());
    }

    [Fact]
    public void IgnoresDelayedStopAfterPidReuse()
    {
        var registry = new ProcessRegistry();
        registry.Start(42, "Old.exe");
        registry.Start(42, "New.exe");

        Assert.False(registry.Stop(42, "Old.exe"));
        ObservedProcess remaining = Assert.Single(registry.Snapshot());
        Assert.Equal("New.exe", remaining.Name);
    }

    [Fact]
    public void ReconciliationReplacesStaleState()
    {
        var registry = new ProcessRegistry();
        registry.Start(1, "Stale.exe");

        registry.Replace([
            new ObservedProcess(2, "Current.exe"),
            new ObservedProcess(3, "Current.exe"),
        ]);

        Assert.Equal(2, registry.Count);
        Assert.DoesNotContain(registry.Snapshot(), process => process.Name == "Stale.exe");
    }

    [Fact]
    public void SerializesBoundedNdjsonMessages()
    {
        string json = ProcessEventProtocol.Snapshot(7, [
            new ObservedProcess(42, "Game.exe"),
        ]);

        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        Assert.Equal("snapshot", root.GetProperty("type").GetString());
        Assert.Equal(7, root.GetProperty("sequence").GetInt64());
        JsonElement process = Assert.Single(root.GetProperty("processes").EnumerateArray());
        Assert.Equal(42, process.GetProperty("pid").GetInt32());
        Assert.Equal("Game.exe", process.GetProperty("name").GetString());
        Assert.DoesNotContain('\n', json);
    }
}
