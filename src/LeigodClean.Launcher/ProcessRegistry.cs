namespace LeigodClean;

internal sealed record ObservedProcess(int ProcessId, string Name);

internal sealed class ProcessRegistry
{
    private readonly Dictionary<int, string> _processes = [];

    public int Count => _processes.Count;

    public bool Start(int processId, string? processName)
    {
        string name = NormalizeName(processName);
        if (processId <= 0 || name.Length == 0)
        {
            return false;
        }

        if (_processes.TryGetValue(processId, out string? current) &&
            string.Equals(current, name, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        _processes[processId] = name;
        return true;
    }

    public bool Stop(int processId, string? reportedName = null)
    {
        if (!_processes.TryGetValue(processId, out string? current))
        {
            return false;
        }

        string normalizedReportedName = NormalizeName(reportedName);
        if (normalizedReportedName.Length > 0 &&
            !string.Equals(current, normalizedReportedName, StringComparison.OrdinalIgnoreCase))
        {
            // A delayed stop event must not remove a newer process that reused the same PID.
            return false;
        }

        return _processes.Remove(processId);
    }

    public void Replace(IEnumerable<ObservedProcess> processes)
    {
        ArgumentNullException.ThrowIfNull(processes);
        _processes.Clear();
        foreach (ObservedProcess process in processes)
        {
            Start(process.ProcessId, process.Name);
        }
    }

    public IReadOnlyList<ObservedProcess> Snapshot() =>
        [.. _processes
            .OrderBy(entry => entry.Key)
            .Select(entry => new ObservedProcess(entry.Key, entry.Value))];

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
}
