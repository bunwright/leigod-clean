using System.Text;
using System.Text.Json;

namespace LeigodClean;

internal static class ProcessEventProtocol
{
    public static string Snapshot(long sequence, IReadOnlyList<ObservedProcess> processes) =>
        WriteJson(writer =>
        {
            WriteHeader(writer, "snapshot", sequence);
            writer.WriteStartArray("processes");
            foreach (ObservedProcess process in processes)
            {
                writer.WriteStartObject();
                writer.WriteNumber("pid", process.ProcessId);
                writer.WriteString("name", process.Name);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        });

    public static string Started(long sequence, ObservedProcess process) =>
        ProcessChange("started", sequence, process);

    public static string Stopped(long sequence, ObservedProcess process) =>
        ProcessChange("stopped", sequence, process);

    public static string Error(string message, string code, bool retryable) => WriteJson(writer =>
    {
        writer.WriteStartObject();
        writer.WriteString("type", "error");
        writer.WriteBoolean("fatal", true);
        writer.WriteString("code", code);
        writer.WriteBoolean("retryable", retryable);
        writer.WriteString("message", message);
        writer.WriteEndObject();
    });

    private static string ProcessChange(string type, long sequence, ObservedProcess process) =>
        WriteJson(writer =>
        {
            WriteHeader(writer, type, sequence);
            writer.WriteNumber("pid", process.ProcessId);
            writer.WriteString("name", process.Name);
            writer.WriteEndObject();
        });

    private static void WriteHeader(Utf8JsonWriter writer, string type, long sequence)
    {
        writer.WriteStartObject();
        writer.WriteString("type", type);
        writer.WriteNumber("sequence", sequence);
    }

    private static string WriteJson(Action<Utf8JsonWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            write(writer);
        }
        return Encoding.UTF8.GetString(stream.GetBuffer(), 0, checked((int)stream.Length));
    }
}
