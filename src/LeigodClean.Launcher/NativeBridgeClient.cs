using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LeigodClean;

internal sealed class NativeBridgeClient : IAsyncDisposable
{
    private readonly NativeBridgeOptions options;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> pending = new();
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private NamedPipeClientStream? pipe;
    private StreamWriter? writer;
    private int nextRequestId;

    internal NativeBridgeClient(NativeBridgeOptions options)
    {
        this.options = options;
    }

    internal event EventHandler<JsonObject>? StateChanged;

    internal event EventHandler<NativeNotificationEventArgs>? NotificationReceived;

    internal bool IsConnected => pipe?.IsConnected == true;

    internal async Task ConnectAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = new NamedPipeClientStream(
                ".",
                options.PipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);
            try
            {
                await candidate.ConnectAsync(1000, cancellationToken).ConfigureAwait(false);
                pipe = candidate;
                writer = new StreamWriter(candidate, new UTF8Encoding(false), leaveOpen: true)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };
                _ = ReadLoopAsync(candidate, lifetime.Token);
                return;
            }
            catch (Exception exception) when (exception is IOException or TimeoutException)
            {
                lastError = exception;
                candidate.Dispose();
                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
            }
        }
        throw new TimeoutException("未能连接后台服务。", lastError);
    }

    internal async Task<JsonNode?> InvokeAsync(
        string method,
        JsonObject? payload = null,
        CancellationToken cancellationToken = default)
    {
        if (writer is null || !IsConnected)
        {
            throw new InvalidOperationException("后台服务尚未连接。");
        }

        int id = Interlocked.Increment(ref nextRequestId);
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(id, completion))
        {
            throw new InvalidOperationException("无法创建后台请求。");
        }
        using CancellationTokenRegistration registration = cancellationToken.Register(() =>
            completion.TrySetCanceled(cancellationToken));
        var request = new JsonObject
        {
            ["id"] = id,
            ["token"] = options.Token,
            ["method"] = method,
            ["payload"] = payload ?? new JsonObject(),
        };
        try
        {
            await writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await writer.WriteLineAsync(request.ToJsonString()).ConfigureAwait(false);
            }
            finally
            {
                writeLock.Release();
            }
            return await completion.Task.ConfigureAwait(false);
        }
        finally
        {
            pending.TryRemove(id, out _);
        }
    }

    private async Task ReadLoopAsync(Stream stream, CancellationToken cancellationToken)
    {
        try
        {
            using var reader = new StreamReader(stream, Encoding.UTF8, false, leaveOpen: true);
            while (!cancellationToken.IsCancellationRequested)
            {
                string? line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }
                JsonObject? message = JsonNode.Parse(line)?.AsObject();
                if (message?["type"]?.GetValue<string>() == "state" &&
                    message["data"] is JsonObject state)
                {
                    StateChanged?.Invoke(this, state);
                    continue;
                }
                if (message?["type"]?.GetValue<string>() == "notification" &&
                    message["data"] is JsonObject notification)
                {
                    NotificationReceived?.Invoke(this, new NativeNotificationEventArgs(
                        notification["title"]?.GetValue<string>() ?? "LeigodClean",
                        notification["body"]?.GetValue<string>() ?? string.Empty,
                        notification["silent"]?.GetValue<bool>() != false));
                    continue;
                }
                int id = message?["id"]?.GetValue<int>() ?? 0;
                if (id <= 0 || !pending.TryGetValue(id, out TaskCompletionSource<JsonNode?>? completion))
                {
                    continue;
                }
                if (message?["ok"]?.GetValue<bool>() == true)
                {
                    completion.TrySetResult(message["data"]?.DeepClone());
                }
                else
                {
                    string error = message?["error"]?["message"]?.GetValue<string>() ?? "操作失败。";
                    completion.TrySetException(new NativeBridgeException(error));
                }
            }
            FailPending(new IOException("后台服务连接已关闭。"));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            FailPending(new OperationCanceledException());
        }
        catch (Exception exception)
        {
            FailPending(exception);
        }
    }

    private void FailPending(Exception exception)
    {
        foreach (TaskCompletionSource<JsonNode?> completion in pending.Values)
        {
            completion.TrySetException(exception);
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (writer is not null)
        {
            await writer.DisposeAsync().ConfigureAwait(false);
        }
        pipe?.Dispose();
        writeLock.Dispose();
        lifetime.Dispose();
    }
}

internal sealed class NativeBridgeException(string message) : Exception(message);

internal sealed class NativeNotificationEventArgs(string title, string body, bool silent) : EventArgs
{
    internal string Title { get; } = title;

    internal string Body { get; } = body;

    internal bool Silent { get; } = silent;
}
