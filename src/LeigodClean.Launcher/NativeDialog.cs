using System.Runtime.InteropServices;

namespace LeigodClean;

internal static partial class NativeDialog
{
    private const uint ErrorIcon = 0x00000010;
    private const uint InformationIcon = 0x00000040;

    public static void Error(string title, string message) =>
        MessageBox(nint.Zero, message, title, ErrorIcon);

    public static void Information(string title, string message) =>
        MessageBox(nint.Zero, message, title, InformationIcon);

    [LibraryImport("user32.dll", EntryPoint = "MessageBoxW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBox(nint window, string text, string caption, uint type);
}
