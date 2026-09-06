namespace LeigodClean;

internal static class AppLog
{
    private static readonly object Sync = new();
    private static string? _path;

    public static void Initialize()
    {
        string directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LeigodClean");
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "launcher.log");
    }

    public static void Information(string message) => Write("INFO", message);

    public static void Error(string message, Exception exception) =>
        Write("ERROR", $"{message}: {exception}");

    private static void Write(string level, string message)
    {
        if (_path is null)
        {
            return;
        }

        lock (Sync)
        {
            File.AppendAllText(
                _path,
                $"{DateTimeOffset.Now:O} [{level}] {message}{Environment.NewLine}");
        }
    }
}
