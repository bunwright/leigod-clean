using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace LeigodClean;

internal static class ProcessEventProtocol
{
    public static string Snapshot(long sequence, IReadOnlyList<ObservedProcess> processes)
    {
        var json = new StringBuilder(64 + (processes.Count * 48));
        json.Append("{\"type\":\"snapshot\",\"sequence\":")
            .Append(sequence.ToString(CultureInfo.InvariantCulture))
            .Append(",\"processes\":[");
        for (int index = 0; index < processes.Count; index++)
        {
            if (index > 0)
            {
                json.Append(',');
            }
            AppendProcess(json, processes[index]);
        }
        return json.Append("]}").ToString();
    }

    public static string Started(long sequence, ObservedProcess process) =>
        ProcessChange("started", sequence, process);

    public static string Stopped(long sequence, ObservedProcess process) =>
        ProcessChange("stopped", sequence, process);

    public static string Error(string message, string code, bool retryable)
    {
        var json = new StringBuilder(160);
        json.Append("{\"type\":\"error\",\"fatal\":true,\"code\":");
        AppendString(json, code);
        json.Append(",\"retryable\":")
            .Append(retryable ? "true" : "false")
            .Append(",\"message\":");
        AppendString(json, message);
        return json.Append('}').ToString();
    }

    private static string ProcessChange(string type, long sequence, ObservedProcess process)
    {
        var json = new StringBuilder(96);
        json.Append("{\"type\":");
        AppendString(json, type);
        json.Append(",\"sequence\":")
            .Append(sequence.ToString(CultureInfo.InvariantCulture))
            .Append(',');
        AppendProcessMembers(json, process);
        return json.Append('}').ToString();
    }

    private static void AppendProcess(StringBuilder json, ObservedProcess process)
    {
        json.Append('{');
        AppendProcessMembers(json, process);
        json.Append('}');
    }

    private static void AppendProcessMembers(StringBuilder json, ObservedProcess process)
    {
        json.Append("\"pid\":")
            .Append(process.ProcessId.ToString(CultureInfo.InvariantCulture))
            .Append(",\"name\":");
        AppendString(json, process.Name);
        json.Append(",\"path\":");
        AppendString(json, process.ExecutablePath);
    }

    private static void AppendString(StringBuilder json, string value)
    {
        json.Append('"');
        foreach (char character in value ?? string.Empty)
        {
            switch (character)
            {
                case '"': json.Append("\\\""); break;
                case '\\': json.Append("\\\\"); break;
                case '\b': json.Append("\\b"); break;
                case '\f': json.Append("\\f"); break;
                case '\n': json.Append("\\n"); break;
                case '\r': json.Append("\\r"); break;
                case '\t': json.Append("\\t"); break;
                default:
                    if (character < ' ')
                    {
                        json.Append("\\u")
                            .Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        json.Append(character);
                    }
                    break;
            }
        }
        json.Append('"');
    }
}
