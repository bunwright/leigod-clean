using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace LeigodClean;

internal static partial class LauncherWindowSuppressor
{
    private const uint EventSystemForeground = 0x0003;
    private const uint EventObjectShow = 0x8002;
    private const int ObjectIdWindow = 0;
    private const int HideWindow = 0;
    private const uint PeekMessageRemove = 0x0001;
    private const uint QueueAllInput = 0x04FF;
    private const uint WinEventOutOfContext = 0x0000;
    private const uint WinEventSkipOwnProcess = 0x0002;
    private const uint WaitSliceMilliseconds = 8;

    private static readonly ConcurrentDictionary<uint, SuppressionContext> Contexts = new();

    internal static unsafe void HideUntilExit(Process process, TimeSpan timeout)
    {
        ArgumentNullException.ThrowIfNull(process);

        uint processId = checked((uint)process.Id);
        var context = new SuppressionContext(Stopwatch.StartNew());
        Contexts[processId] = context;

        IntPtr showHook = SetWinEventHook(
            EventObjectShow,
            EventObjectShow,
            IntPtr.Zero,
            &OnWindowEvent,
            processId,
            0,
            WinEventOutOfContext | WinEventSkipOwnProcess);
        IntPtr foregroundHook = SetWinEventHook(
            EventSystemForeground,
            EventSystemForeground,
            IntPtr.Zero,
            &OnWindowEvent,
            processId,
            0,
            WinEventOutOfContext | WinEventSkipOwnProcess);

        if (showHook == IntPtr.Zero || foregroundHook == IntPtr.Zero)
        {
            AppLog.Information("Could not install every launcher window event hook; polling remains active");
        }

        try
        {
            while (context.Stopwatch.Elapsed < timeout)
            {
                context.RecordIfHidden(HideTopLevelWindows(process.Id));
                PumpWindowEvents();
                context.RecordIfHidden(HideTopLevelWindows(process.Id));

                if (process.WaitForExit(0))
                {
                    return;
                }

                _ = MsgWaitForMultipleObjectsEx(
                    0,
                    IntPtr.Zero,
                    WaitSliceMilliseconds,
                    QueueAllInput,
                    0);
            }

            AppLog.Information("Official launcher window suppression timed out; launcher continues in background");
        }
        finally
        {
            Contexts.TryRemove(processId, out _);
            Unhook(showHook);
            Unhook(foregroundHook);
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    private static void OnWindowEvent(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime)
    {
        _ = hook;
        _ = eventType;
        _ = childId;
        _ = eventThread;
        _ = eventTime;

        try
        {
            if (window == IntPtr.Zero || objectId != ObjectIdWindow)
            {
                return;
            }

            _ = GetWindowThreadProcessId(window, out uint processId);
            if (Contexts.TryGetValue(processId, out SuppressionContext? context))
            {
                context.RecordIfHidden(HideOwnedWindow(window));
            }
        }
        catch
        {
            // Exceptions cannot cross the unmanaged callback boundary.
        }
    }

    private static void PumpWindowEvents()
    {
        while (PeekMessage(out WindowMessage message, IntPtr.Zero, 0, 0, PeekMessageRemove))
        {
            _ = TranslateMessage(in message);
            _ = DispatchMessage(in message);
        }
    }

    private static bool HideTopLevelWindows(int processId)
    {
        bool hidden = false;
        _ = EnumWindows(
            (window, _parameter) =>
            {
                _ = GetWindowThreadProcessId(window, out uint windowProcessId);
                if (windowProcessId == processId)
                {
                    hidden |= HideOwnedWindow(window);
                }

                return true;
            },
            IntPtr.Zero);
        return hidden;
    }

    private static bool HideOwnedWindow(IntPtr window)
    {
        if (!IsWindowVisible(window))
        {
            return false;
        }

        _ = ShowWindow(window, HideWindow);
        return true;
    }

    private static void Unhook(IntPtr hook)
    {
        if (hook != IntPtr.Zero)
        {
            _ = UnhookWinEvent(hook);
        }
    }

    private sealed class SuppressionContext(Stopwatch stopwatch)
    {
        private int _logged;

        public Stopwatch Stopwatch { get; } = stopwatch;

        public void RecordIfHidden(bool hidden)
        {
            if (hidden && Interlocked.Exchange(ref _logged, 1) == 0)
            {
                AppLog.Information(
                    $"Suppressed official launcher startup window after {Stopwatch.Elapsed.TotalMilliseconds:F0} ms");
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct NativePoint
    {
        public readonly int X;
        public readonly int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct WindowMessage
    {
        public readonly IntPtr Window;
        public readonly uint Message;
        public readonly UIntPtr WParam;
        public readonly IntPtr LParam;
        public readonly uint Time;
        public readonly NativePoint Point;
        public readonly uint Private;
    }

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(IntPtr window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(IntPtr window, int command);

    [LibraryImport("user32.dll", SetLastError = true)]
    private static unsafe partial IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr module,
        delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int, int, uint, uint, void> callback,
        uint processId,
        uint threadId,
        uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UnhookWinEvent(IntPtr hook);

    [LibraryImport("user32.dll", EntryPoint = "PeekMessageW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool PeekMessage(
        out WindowMessage message,
        IntPtr window,
        uint minimum,
        uint maximum,
        uint remove);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TranslateMessage(in WindowMessage message);

    [LibraryImport("user32.dll", EntryPoint = "DispatchMessageW")]
    private static partial IntPtr DispatchMessage(in WindowMessage message);

    [LibraryImport("user32.dll")]
    private static partial uint MsgWaitForMultipleObjectsEx(
        uint count,
        IntPtr handles,
        uint milliseconds,
        uint wakeMask,
        uint flags);
}
