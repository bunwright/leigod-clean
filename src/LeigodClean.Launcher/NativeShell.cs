using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace LeigodClean;

internal static partial class NativeShell
{
    private const string AppUserModelId = "io.github.bunwright.leigodclean";

    internal static void ApplyApplicationIdentity()
    {
        try
        {
            _ = SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
        }
        catch (Exception exception)
        {
            AppLog.Error("Could not apply the LeigodClean shell identity", exception);
        }
    }

    internal static Icon LoadApplicationIcon()
    {
        string? executable = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(executable))
        {
            using Icon? associated = Icon.ExtractAssociatedIcon(executable);
            if (associated is not null)
            {
                return (Icon)associated.Clone();
            }
        }
        return (Icon)SystemIcons.Application.Clone();
    }

    internal static Icon CreateActiveIcon(Icon source)
    {
        ArgumentNullException.ThrowIfNull(source);
        using Bitmap bitmap = source.ToBitmap();
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float scale = Math.Min(bitmap.Width, bitmap.Height);
            float center = scale * 0.77F;
            float outerRadius = Math.Max(3F, scale * 0.18F);
            float innerRadius = outerRadius * 0.72F;
            graphics.FillEllipse(
                Brushes.White,
                center - outerRadius,
                center - outerRadius,
                outerRadius * 2,
                outerRadius * 2);
            using var activeBrush = new SolidBrush(Color.FromArgb(40, 199, 111));
            graphics.FillEllipse(
                activeBrush,
                center - innerRadius,
                center - innerRadius,
                innerRadius * 2,
                innerRadius * 2);
        }

        IntPtr handle = bitmap.GetHicon();
        try
        {
            using Icon temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            _ = DestroyIcon(handle);
        }
    }

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int SetCurrentProcessExplicitAppUserModelID(string appId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyIcon(IntPtr icon);
}
