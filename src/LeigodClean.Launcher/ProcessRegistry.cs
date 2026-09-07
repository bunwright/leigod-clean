using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace LeigodClean;

internal sealed class ObservedProcess
{
    public ObservedProcess(int processId, string name, string? executablePath = null)
    {
        ProcessId = processId;
        Name = ProcessRegistry.NormalizeName(name);
        ExecutablePath = ProcessRegistry.NormalizeExecutablePath(executablePath);
    }

    public int ProcessId { get; }

    public string Name { get; }

    public string ExecutablePath { get; }
}

internal sealed class ProcessRegistry
{
    private readonly Dictionary<int, ObservedProcess> _processes = new();

    public int Count => _processes.Count;

    public bool Start(int processId, string? processName)
        => Start(new ObservedProcess(processId, processName ?? string.Empty));

    public bool Start(ObservedProcess process)
    {
        if (process.ProcessId <= 0 || process.Name.Length == 0)
        {
            return false;
        }

        if (_processes.TryGetValue(process.ProcessId, out ObservedProcess? current) &&
            string.Equals(current.Name, process.Name, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(
                current.ExecutablePath,
                process.ExecutablePath,
                StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        _processes[process.ProcessId] = process;
        return true;
    }

    public bool Stop(int processId, string? reportedName = null)
    {
        if (!_processes.TryGetValue(processId, out ObservedProcess? current))
        {
            return false;
        }

        string normalizedReportedName = NormalizeName(reportedName);
        if (normalizedReportedName.Length > 0 &&
            !string.Equals(current.Name, normalizedReportedName, StringComparison.OrdinalIgnoreCase))
        {
            // A delayed stop event must not remove a newer process that reused the same PID.
            return false;
        }

        return _processes.Remove(processId);
    }

    public void Replace(IEnumerable<ObservedProcess> processes)
    {
#if NET8_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(processes);
#else
        if (processes is null)
        {
            throw new ArgumentNullException(nameof(processes));
        }
#endif
        _processes.Clear();
        foreach (ObservedProcess process in processes)
        {
            Start(process);
        }
    }

    public ObservedProcess? Find(int processId) =>
        _processes.TryGetValue(processId, out ObservedProcess? process) ? process : null;

    public IReadOnlyList<ObservedProcess> Snapshot() =>
        _processes
            .OrderBy(entry => entry.Key)
            .Select(entry => entry.Value)
            .ToList();

    public static string NormalizeName(string? processName)
    {
        string value = Path.GetFileName(processName?.Trim() ?? string.Empty);
        if (value.Length == 0 || value.Length > 260 || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            return string.Empty;
        }

        return value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? value
            : $"{value}.exe";
    }

    public static string NormalizeExecutablePath(string? executablePath)
    {
        string value = (executablePath ?? string.Empty).Trim().Trim('"');
        if (value.Length == 0 || value.Length > 32767 || value.Any(character => character == '\0'))
        {
            return string.Empty;
        }

        return value;
    }
}
