using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace LeigodClean.Tests;

public sealed class NativeBridgeClientTests
{
    [Fact]
    public async Task ConnectsReceivesStateAndMatchesResponses()
    {
        var options = new NativeBridgeOptions(
            $"LeigodClean-test-{Guid.NewGuid():N}",
            new string('a', 64));
        using var server = new NamedPipeServerStream(
            options.PipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
        Task serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync();
            using var reader = new StreamReader(server, Encoding.UTF8, false, 1024, true);
            await using var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true)
            {
                AutoFlush = true,
                NewLine = "\n",
            };
            await writer.WriteLineAsync("{\"type\":\"state\",\"data\":{\"client\":{\"ready\":true}}}");
            string requestText = await reader.ReadLineAsync() ?? throw new IOException("Missing request.");
            using JsonDocument request = JsonDocument.Parse(requestText);
            Assert.Equal(options.Token, request.RootElement.GetProperty("token").GetString());
            Assert.Equal("ping", request.RootElement.GetProperty("method").GetString());
            int id = request.RootElement.GetProperty("id").GetInt32();
            await writer.WriteLineAsync($"{{\"id\":{id},\"ok\":true,\"data\":{{\"pong\":true}}}}");
        });

        var stateReceived = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var client = new NativeBridgeClient(options);
        client.StateChanged += (_, state) => stateReceived.TrySetResult(state);
        await client.ConnectAsync(TimeSpan.FromSeconds(5));
        JsonNode? response = await client.InvokeAsync("ping");

        Assert.True(response?["pong"]?.GetValue<bool>());
        Assert.True((await stateReceived.Task.WaitAsync(TimeSpan.FromSeconds(5)))["client"]?["ready"]?.GetValue<bool>());
        await serverTask;
    }
}
