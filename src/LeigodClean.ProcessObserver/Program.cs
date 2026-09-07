using System;

namespace LeigodClean;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length > 0 && !string.Equals(
            args[0],
            "--process-events",
            StringComparison.OrdinalIgnoreCase))
        {
            return 2;
        }

        return ProcessEventHost.Run();
    }
}
