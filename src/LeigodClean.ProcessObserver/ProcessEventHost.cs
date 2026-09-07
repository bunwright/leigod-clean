using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LeigodClean;

internal static class ProcessEventHost
{
    private const int ReconciliationMilliseconds = 60000;
    private const string StartQuery = "SELECT * FROM Win32_ProcessStartTrace";
    private const string StopQuery = "SELECT * FROM Win32_ProcessStopTrace";

    public static int Run()
    {
        using (Stream standardOutput = Console.OpenStandardOutput())
        using (Stream standardError = Console.OpenStandardError())
        using (var output = new StreamWriter(standardOutput, new UTF8Encoding(false)))
        using (var errorOutput = new StreamWriter(standardError, new UTF8Encoding(false)))
        {
            output.AutoFlush = true;
            errorOutput.AutoFlush = true;
            Console.SetError(errorOutput);
            try
            {
                return RunObserver(output);
            }
            catch (Exception exception)
            {
                TryWriteError(exception);
                TryWrite(output, ErrorMessage(exception));
                return 2;
            }
        }
    }

    private static int RunObserver(TextWriter output)
    {
        if (!IsAdministrator())
        {
            throw new UnauthorizedAccessException("进程事件服务需要由已提升权限的 LeigodClean 启动。");
        }

        using (var cancellation = new CancellationTokenSource())
        using (var startWatcher = new ManagementEventWatcher(new WqlEventQuery(StartQuery)))
        using (var stopWatcher = new ManagementEventWatcher(new WqlEventQuery(StopQuery)))
        {
            var registry = new ProcessRegistry();
            var gate = new object();
            var pending = new List<PendingProcessEvent>();
            Exception? fatalError = null;
            long sequence = 0;
            bool initializing = true;
            bool stopping = false;
            int reconciling = 0;

            Action<Exception> fail = error =>
            {
                lock (gate)
                {
                    if (stopping || fatalError != null)
                    {
                        return;
                    }
                    fatalError = error;
                    TryWriteError(error);
                    TryWrite(output, ErrorMessage(error));
                }
                cancellation.Cancel();
            };

            Action<bool, EventArrivedEventArgs> processEvent = (started, eventArgs) =>
            {
                try
                {
                    int processId = Convert.ToInt32(
                        eventArgs.NewEvent["ProcessID"],
                        CultureInfo.InvariantCulture);
                    var process = new ObservedProcess(
                        processId,
                        ProcessRegistry.NormalizeName(Convert.ToString(
                            eventArgs.NewEvent["ProcessName"],
                            CultureInfo.InvariantCulture)),
                        started ? TryGetExecutablePath(processId) : null);
                    if (process.ProcessId <= 0 || process.Name.Length == 0)
                    {
                        return;
                    }

                    lock (gate)
                    {
                        if (initializing)
                        {
                            pending.Add(new PendingProcessEvent(started, process));
                            return;
                        }

                        ObservedProcess reported = process;
                        if (!started)
                        {
                            reported = registry.Find(process.ProcessId) ?? process;
                        }
                        bool changed = started
                            ? registry.Start(process)
                            : registry.Stop(process.ProcessId, process.Name);
                        if (!changed)
                        {
                            return;
                        }
                        output.WriteLine(started
                            ? ProcessEventProtocol.Started(++sequence, reported)
                            : ProcessEventProtocol.Stopped(++sequence, reported));
                    }
                }
                catch (Exception exception)
                {
                    fail(exception);
                }
            };

            startWatcher.EventArrived += (_, eventArgs) => processEvent(true, eventArgs);
            stopWatcher.EventArrived += (_, eventArgs) => processEvent(false, eventArgs);
            startWatcher.Stopped += (_, eventArgs) =>
                WatcherStopped("进程启动", eventArgs.Status, gate, () => stopping, fail);
            stopWatcher.Stopped += (_, eventArgs) =>
                WatcherStopped("进程退出", eventArgs.Status, gate, () => stopping, fail);

            Timer? reconciliationTimer = null;
            try
            {
                startWatcher.Start();
                stopWatcher.Start();
                ReplaceWithSnapshot(output, registry, pending, gate, ref sequence, ref initializing);

                reconciliationTimer = new Timer(_ =>
                {
                    if (Interlocked.Exchange(ref reconciling, 1) != 0 || cancellation.IsCancellationRequested)
                    {
                        return;
                    }
                    try
                    {
                        ReplaceWithSnapshot(output, registry, pending, gate, ref sequence, ref initializing);
                    }
                    catch (Exception exception)
                    {
                        fail(exception);
                    }
                    finally
                    {
                        Volatile.Write(ref reconciling, 0);
                    }
                }, null, ReconciliationMilliseconds, ReconciliationMilliseconds);

                Task.Run(() =>
                {
                    try
                    {
                        Console.In.ReadLine();
                    }
                    catch (IOException)
                    {
                        // Closing the parent pipe is a normal shutdown signal.
                    }
                    finally
                    {
                        cancellation.Cancel();
                    }
                });
                cancellation.Token.WaitHandle.WaitOne();
            }
            catch (Exception exception)
            {
                fail(exception);
            }
            finally
            {
                lock (gate)
                {
                    stopping = true;
                }
                if (reconciliationTimer != null)
                {
                    reconciliationTimer.Dispose();
                }
                TryStop(startWatcher);
                TryStop(stopWatcher);
            }

            return fatalError == null ? 0 : 2;
        }
    }

    private static void ReplaceWithSnapshot(
        TextWriter output,
        ProcessRegistry registry,
        List<PendingProcessEvent> pending,
        object gate,
        ref long sequence,
        ref bool initializing)
    {
        lock (gate)
        {
            initializing = true;
        }
        List<ObservedProcess> current = EnumerateProcesses();
        lock (gate)
        {
            registry.Replace(current);
            foreach (PendingProcessEvent item in pending)
            {
                if (item.Started)
                {
                    registry.Start(item.Process);
                }
                else
                {
                    registry.Stop(item.Process.ProcessId, item.Process.Name);
                }
            }
            pending.Clear();
            output.WriteLine(ProcessEventProtocol.Snapshot(++sequence, registry.Snapshot()));
            initializing = false;
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
                        result.Add(new ObservedProcess(process.Id, name, TryGetExecutablePath(process)));
                    }
                }
                catch (Exception exception) when (
                    exception is InvalidOperationException ||
                    exception is NotSupportedException ||
                    exception is Win32Exception)
                {
                    // Processes can exit or become inaccessible during enumeration.
                }
            }
        }
        return result;
    }

    private static string TryGetExecutablePath(int processId)
    {
        for (int attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    string executablePath = TryGetExecutablePath(process);
                    if (executablePath.Length > 0)
                    {
                        return executablePath;
                    }
                }
            }
            catch (Exception exception) when (
                exception is ArgumentException ||
                exception is InvalidOperationException ||
                exception is NotSupportedException ||
                exception is Win32Exception)
            {
                // The process may still be initializing or may already have exited.
            }
            if (attempt < 3)
            {
                Thread.Sleep(10);
            }
        }
        return string.Empty;
    }

    private static string TryGetExecutablePath(Process process)
    {
        try
        {
            return ProcessRegistry.NormalizeExecutablePath(process.MainModule?.FileName);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException ||
            exception is NotSupportedException ||
            exception is Win32Exception)
        {
            return string.Empty;
        }
    }

    private static void WatcherStopped(
        string label,
        ManagementStatus status,
        object gate,
        Func<bool> isStopping,
        Action<Exception> fail)
    {
        lock (gate)
        {
            if (isStopping())
            {
                return;
            }
        }
        fail(new ManagementException(label + "事件订阅已停止：" + status));
    }

    private static void TryStop(ManagementEventWatcher watcher)
    {
        try
        {
            watcher.Stop();
        }
        catch (Exception exception) when (
            exception is InvalidOperationException ||
            exception is ManagementException ||
            exception is ObjectDisposedException)
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
            // The parent process has already closed its output pipe.
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

    private static string ErrorMessage(Exception exception)
    {
        bool accessDenied = exception is UnauthorizedAccessException ||
            exception is ManagementException &&
            ((ManagementException)exception).ErrorCode == ManagementStatus.AccessDenied;
        string code = accessDenied ? "ACCESS_DENIED" : "OBSERVER_ERROR";
        string message = (exception.Message ?? string.Empty).Trim();
        if (message.Length == 0)
        {
            message = exception.GetType().Name;
        }
        if (message.Length > 500)
        {
            message = message.Substring(0, 500);
        }
        return ProcessEventProtocol.Error(message, code, !accessDenied);
    }

    private static bool IsAdministrator()
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    private sealed class PendingProcessEvent
    {
        public PendingProcessEvent(bool started, ObservedProcess process)
        {
            Started = started;
            Process = process;
        }

        public bool Started { get; }

        public ObservedProcess Process { get; }
    }
}
