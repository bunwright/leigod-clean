using System.Diagnostics;
using Xunit;

namespace LeigodClean.Tests;

public sealed class OfficialClientLauncherTests
{
    [Fact]
    public void RuntimeInstallerDeploysAndRepairsEveryEmbeddedFile()
    {
        string installRoot = Path.Combine(
            Path.GetTempPath(),
            "LeigodClean.Tests",
            Guid.NewGuid().ToString("N"));

        try
        {
            RuntimeInstaller.Install(installRoot);
            Assert.True(RuntimeInstaller.IsCurrent(installRoot));

            string runtimeRoot = RuntimeInstaller.RuntimeRoot(installRoot);
            string mainPath = Path.Combine(runtimeRoot, "main.cjs");
            Assert.True(File.Exists(mainPath));
            Assert.Equal(Environment.ProcessPath, File.ReadAllText(Path.Combine(runtimeRoot, "launcher.path")));

            File.WriteAllText(mainPath, "modified");
            Assert.False(RuntimeInstaller.IsCurrent(installRoot));

            RuntimeInstaller.Install(installRoot);
            Assert.True(RuntimeInstaller.IsCurrent(installRoot));
            Assert.Empty(Directory.EnumerateFiles(runtimeRoot, "*.tmp", SearchOption.AllDirectories));
        }
        finally
        {
            if (Directory.Exists(installRoot))
            {
                Directory.Delete(installRoot, true);
            }
        }
    }

    [Fact]
    public void RuntimeIsInstalledBesideProtectedOfficialResources()
    {
        string installRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "LeiGod_Acc");

        string runtimeRoot = RuntimeInstaller.RuntimeRoot(installRoot);

        Assert.Equal(
            Path.Combine(Path.GetFullPath(installRoot), "resources", "leigodclean"),
            runtimeRoot);
        Assert.False(runtimeRoot.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(false, "0")]
    [InlineData(true, "1")]
    public void LaunchPlanUsesOnlyTheHiddenOfficialBootstrapper(
        bool startInBackground,
        string expectedBackgroundValue)
    {
        string installRoot = Path.Combine(Path.GetTempPath(), "LeigodClean", "OfficialClient");

        ProcessStartInfo startInfo = OfficialClientLauncher.CreateStartInfo(
            installRoot,
            startInBackground);

        Assert.Equal(
            Path.Combine(Path.GetFullPath(installRoot), "leigod_launcher.exe"),
            startInfo.FileName);
        Assert.NotEqual("leigod.exe", Path.GetFileName(startInfo.FileName));
        Assert.Equal(Path.GetFullPath(installRoot), startInfo.WorkingDirectory);
        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal(ProcessWindowStyle.Hidden, startInfo.WindowStyle);
        Assert.Equal(expectedBackgroundValue, startInfo.Environment["LEIGOD_CLEAN_START_HIDDEN"]);
    }
}
