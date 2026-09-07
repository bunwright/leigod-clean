using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Security.Principal;
using System.Text;

namespace LeigodClean;

internal static class ProcessEventHost
{
    private const int ReconciliationSeconds = 60;
    private const string StartQuery =
        "SELECT * FROM Win32_ProcessStartTrace";
    private const string StopQuery =
        "SELECT * FROM Win32_ProcessStopTrace";

    public static int Run()
    {
        using Stream standardOutput = Console.OpenStandardOutput();
        using Stream standardError = Console.OpenStandardError();
        using var output = new StreamWriter(standardOutput, new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        using var errorOutput = new StreamWriter(standardError, new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        Console.SetError(errorOutput);
        try
        {
            return RunAsync(output).GetAwaiter().GetResult();
        }
        catch (Exception exception)
        {
            TryWriteError(exception);
            TryWrite(output, ErrorMessage(exception));
            return 2;
        }
    }

    private static async Task<int> RunAsync(TextWriter output)
    {
        if (!IsAdministrator())
        {
            throw new UnauthorizedAccessException("进程事件服务需要由已提升权限的 LeigodClean 启动。");
        }

        using var cancellation = new CancellationTokenSource();
        using var startWatcher = new ManagementEventWatcher(new WqlEventQuery(StartQuery));
        using var stopWatcher = new ManagementEventWatcher(new WqlEventQuery(StopQuery));
        var registry = new ProcessRegistry();
        var gate = new object();
        var pending = new List<(bool Started, ObservedProcess Process)>();
        Exception? fatalError = null;
        long sequence = 0;
        bool initializing = true;
        bool stopping = false;

        void Fail(Exception error)
        {
            lock (gate)
            {
                if (stopping || fatalError is not null)
                {
                    return;
                }
                fatalError = error;
                TryWriteError(error);
                TryWrite(output, ErrorMessage(error));
            }
            cancellation.Cancel();
        }

        void ProcessEvent(bool started, EventArrivedEventArgs eventArgs)
        {
            try
            {
                var process = new ObservedProcess(
                    Convert.ToInt32(eventArgs.NewEvent["ProcessID"], CultureInfo.InvariantCulture),
                    ProcessRegistry.NormalizeName(Convert.ToString(
                        eventArgs.NewEvent["ProcessName"],
                        CultureInfo.InvariantCulture)));
                if (process.ProcessId <= 0 || process.Name.Length == 0)
                {
                    return;
                }

                lock (gate)
                {
                    if (initializing)
                    {
                        pending.Add((started, process));
                        return;
                    }

                    bool changed = started
                        ? registry.Start(process.ProcessId, process.Name)
                        : registry.Stop(process.ProcessId, process.Name);
                    if (!changed)
                    {
                        return;
                    }

                    string message = started
                        ? ProcessEventProtocol.Started(++sequence, process)
                        : ProcessEventProtocol.Stopped(++sequence, process);
                    output.WriteLine(message);
                }
            }
            catch (Exception exception)
            {
                Fail(exception);
            }
        }

        void WatcherStopped(string label, ManagementStatus status)
        {
            lock (gate)
            {
                if (stopping)
                {
                    return;
                }
            }
            Fail(new ManagementException($"{label}事件订阅已停止：{status}"));
        }

        startWatcher.EventArrived += (_, eventArgs) => ProcessEvent(true, eventArgs);
        stopWatcher.EventArrived += (_, eventArgs) => ProcessEvent(false, eventArgs);
        startWatcher.Stopped += (_, eventArgs) => WatcherStopped("进程启动", eventArgs.Status);
        stopWatcher.Stopped += (_, eventArgs) => WatcherStopped("进程退出", eventArgs.Status);

        try
        {
            startWatcher.Start();
            stopWatcher.Start();
            List<ObservedProcess> initial = EnumerateProcesses();
            lock (gate)
            {
                registry.Replace(initial);
                ApplyPendingEvents(registry, pending);
                output.WriteLine(ProcessEventProtocol.Snapshot(++sequence, registry.Snapshot()));
                initializing = false;
            }

            Task reconcileTask = ReconcileAsync();
            await WaitForParentAsync(cancellation.Token).ConfigureAwait(false);
            cancellation.Cancel();
            await IgnoreCancellationAsync(reconcileTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            // Parent exit, a requested stop, or a previously reported watcher failure.
        }
        catch (Exception exception)
        {
            Fail(exception);
        }
        finally
        {
            lock (gate)
            {
                stopping = true;
            }
            TryStop(startWatcher);
            TryStop(stopWatcher);
        }

        return fatalError is null ? 0 : 2;

        async Task ReconcileAsync()
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(ReconciliationSeconds));
            try
            {
                while (await timer.WaitForNextTickAsync(cancellation.Token).ConfigureAwait(false))
                {
                    lock (gate)
                    {
                        initializing = true;
                    }
                    List<ObservedProcess> current = EnumerateProcesses();
                    lock (gate)
                    {
                        registry.Replace(current);
                        ApplyPendingEvents(registry, pending);
                        output.WriteLine(ProcessEventProtocol.Snapshot(++sequence, registry.Snapshot()));
                        initializing = false;
                    }
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                // Normal shutdown.
            }
            catch (Exception exception)
            {
                Fail(exception);
            }
        }
    }

    private static async Task WaitForParentAsync(CancellationToken cancellationToken)
    {
        using Stream input = Console.OpenStandardInput();
        using var reader = new StreamReader(input, Encoding.UTF8, false, leaveOpen: false);
        while (true)
        {
            string? command = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            if (command is null || string.Equals(command.Trim(), "stop", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }
    }

    private static List<ObservedProcess> EnumerateProcesses()
    {
        var result = new List<ObservedProcess>();
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    string name = ProcessRegistry.NormalizeName(process.ProcessName);
                    if (name.Length > 0)
                    {
                        result.Add(new ObservedProcess(process.Id, name));
                    }
                }
                catch (Exception exception) when (
                    exception is InvalidOperationException or NotSupportedException or Win32Exception)
                {
                    // Processes can exit or become inaccessible while the snapshot is collected.
                }
            }
        }
        return result;
    }

    private static void ApplyPendingEvents(
        ProcessRegistry registry,
        List<(bool Started, ObservedProcess Process)> pending)
    {
        foreach ((bool started, ObservedProcess process) in pending)
        {
            if (started)
            {
                registry.Start(process.ProcessId, process.Name);
            }
            else
            {
                registry.Stop(process.ProcessId, process.Name);
            }
        }
        pending.Clear();
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    private static void TryStop(ManagementEventWatcher watcher)
    {
        try
        {
            watcher.Stop();
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or ManagementException or ObjectDisposedException)
        {
            // The watcher may already be stopped after an infrastructure failure.
        }
    }

    private static void TryWrite(TextWriter output, string message)
    {
        try
        {
            output.WriteLine(message);
        }
        catch (IOException)
        {
            // The parent process has already closed its pipe.
        }
    }

    private static void TryWriteError(Exception exception)
    {
        try
        {
            Console.Error.WriteLine(exception);
        }
        catch (IOException)
        {
            // The parent process has already closed its diagnostic pipe.
        }
    }

    private static string SafeMessage(Exception exception)
    {
        string message = exception.Message.Trim();
        return message.Length == 0 ? exception.GetType().Name : message[..Math.Min(message.Length, 500)];
    }

    private static string ErrorMessage(Exception exception)
    {
        bool accessDenied = exception is UnauthorizedAccessException ||
            exception is ManagementException { ErrorCode: ManagementStatus.AccessDenied };
        bool platformUnsupported = exception is PlatformNotSupportedException;
        string code = accessDenied
            ? "ACCESS_DENIED"
            : platformUnsupported ? "PLATFORM_UNSUPPORTED" : "OBSERVER_ERROR";
        return ProcessEventProtocol.Error(
            SafeMessage(exception),
            code,
            !accessDenied && !platformUnsupported);
    }

    private static bool IsAdministrator()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
}
