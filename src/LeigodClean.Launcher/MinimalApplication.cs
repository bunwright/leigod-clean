using System.Drawing.Imaging;
using System.Globalization;
using System.Text.Json.Nodes;

namespace LeigodClean;

internal static class MinimalApplication
{
    internal static int SmokeTest()
    {
        NativeShell.ApplyApplicationIdentity();
        WindowsFormsBootstrap.Initialize();
        var client = new NativeBridgeClient(NativeBridgeOptions.Create());
        try
        {
            using var form = new MinimalMainForm(client, false, previewMode: true);
            form.PreparePreview();
            _ = form.Handle;
            form.PerformLayout();
            using Icon modeIcon = NativeShell.LoadApplicationIcon();
            using var modeForm = new FirstRunModeForm(modeIcon);
            modeForm.PreparePreview();
            _ = modeForm.Handle;
            modeForm.PerformLayout();
            return form.IsHandleCreated && modeForm.IsHandleCreated ? 0 : 1;
        }
        finally
        {
            client.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    internal static int RenderPreview(string outputPath)
    {
        NativeShell.ApplyApplicationIdentity();
        WindowsFormsBootstrap.Initialize();
        var client = new NativeBridgeClient(NativeBridgeOptions.Create());
        try
        {
            string resolved = Path.GetFullPath(outputPath);
            string directory = Path.GetDirectoryName(resolved)
                ?? throw new InvalidOperationException("预览输出路径无效。");
            Directory.CreateDirectory(directory);
            using var form = new MinimalMainForm(client, false, previewMode: true)
            {
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                Location = new Point(-32000, -32000),
            };
            form.PreparePreview();
            SavePreview(form, resolved);

            string stem = Path.GetFileNameWithoutExtension(resolved);
            JsonObject settings = PreviewSettings();
            JsonObject game = PreviewGame();
            using var settingsForm = new MinimalSettingsForm(settings, game);
            SavePreview(settingsForm, Path.Combine(directory, $"{stem}-settings.png"));
            using var aboutForm = new MinimalAboutForm("0.7.0", "2026-09-11", "11.0.23");
            SavePreview(aboutForm, Path.Combine(directory, $"{stem}-about.png"));
            using Icon modeIcon = NativeShell.LoadApplicationIcon();
            using var modeForm = new FirstRunModeForm(modeIcon);
            modeForm.PreparePreview();
            SavePreview(modeForm, Path.Combine(directory, $"{stem}-mode.png"));
            return 0;
        }
        finally
        {
            client.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static void SavePreview(Form form, string outputPath)
    {
        form.ShowInTaskbar = false;
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(-32000, -32000);
        form.Show();
        Application.DoEvents();
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
        bitmap.Save(outputPath, ImageFormat.Png);
        form.Hide();
    }

    private static JsonObject PreviewSettings() => new()
    {
        ["minimalMode"] = true,
        ["autoAccelerationEnabled"] = false,
        ["autoPauseEnabled"] = true,
        ["pauseTimeWhenIdle"] = true,
        ["launchAtLogin"] = false,
        ["minimizeToTray"] = true,
        ["pauseOnClose"] = true,
        ["notificationsEnabled"] = true,
        ["startupTimeoutMinutes"] = 10,
        ["graceMinutes"] = 5,
        ["processOverrides"] = new JsonObject(),
    };

    private static JsonObject PreviewGame() => new()
    {
        ["id"] = 42,
        ["title"] = "最终幻想 XIV",
        ["processes"] = new JsonArray("ffxivboot.exe", "ffxiv_dx11.exe"),
    };

    internal static void Run(NativeBridgeOptions options, bool startInBackground = false)
    {
        NativeShell.ApplyApplicationIdentity();
        WindowsFormsBootstrap.Initialize();
        var client = new NativeBridgeClient(options);
        try
        {
            Application.Run(new MinimalMainForm(client, startInBackground));
        }
        finally
        {
            client.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }
}

internal static class MinimalTheme
{
    internal static readonly Color Canvas = Color.FromArgb(244, 246, 249);
    internal static readonly Color Surface = Color.FromArgb(255, 255, 255);
    internal static readonly Color Border = Color.FromArgb(222, 226, 232);
    internal static readonly Color Text = Color.FromArgb(30, 35, 43);
    internal static readonly Color SecondaryText = Color.FromArgb(103, 111, 123);
    internal static readonly Color Accent = Color.FromArgb(44, 104, 220);
    internal static readonly Color AccentSoft = Color.FromArgb(235, 241, 253);
    internal static readonly Color Success = Color.FromArgb(32, 155, 91);
    internal static readonly Color Danger = Color.FromArgb(190, 55, 64);

    internal static void StyleButton(Button button, bool primary = false, bool danger = false)
    {
        button.AutoSize = false;
        button.Cursor = Cursors.Hand;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.UseVisualStyleBackColor = false;
        if (primary)
        {
            button.BackColor = Accent;
            button.ForeColor = Color.White;
            button.FlatAppearance.BorderColor = Accent;
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(36, 91, 196);
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(30, 78, 170);
            return;
        }
        button.BackColor = Surface;
        button.ForeColor = danger ? Danger : Text;
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(247, 248, 250);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(238, 241, 245);
    }
}

internal sealed class MinimalSurfacePanel : Panel
{
    internal MinimalSurfacePanel()
    {
        BackColor = MinimalTheme.Surface;
        DoubleBuffered = true;
        ResizeRedraw = true;
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        using var pen = new Pen(MinimalTheme.Border);
        Rectangle border = ClientRectangle;
        border.Width = Math.Max(0, border.Width - 1);
        border.Height = Math.Max(0, border.Height - 1);
        eventArgs.Graphics.DrawRectangle(pen, border);
    }
}

internal sealed class BufferedGameListBox : ListBox
{
    internal BufferedGameListBox()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
}

internal enum NativeTrayAction
{
    None,
    Restore,
    ShowMenu,
}

internal sealed class MinimalMainForm : Form
{
    private readonly NativeBridgeClient client;
    private readonly bool startInBackground;
    private readonly TextBox searchBox = new() { PlaceholderText = "搜索游戏" };
    private readonly BufferedGameListBox gameList = new();
    private readonly Label gameTitle = new();
    private readonly Label gameSubtitle = new();
    private readonly Label gameStatus = new();
    private readonly Label selectionHint = new();
    private readonly ComboBox areaBox = CreateComboBox();
    private readonly ComboBox subAreaBox = CreateComboBox();
    private readonly ComboBox lineBox = CreateComboBox();
    private readonly CheckBox autoAcceleration = new() { Text = "检测到游戏后自动加速", AutoSize = true };
    private readonly Button accelerationButton = new() { Text = "一键加速", Width = 126, Height = 38 };
    private readonly Label serviceStatus = new() { TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
    private readonly Label accountStatus = new() { TextAlign = ContentAlignment.MiddleRight, AutoSize = true };
    private readonly Button timeButton = new() { Text = "暂停时长", Width = 112, Height = 30 };
    private readonly System.Windows.Forms.Timer searchTimer = new() { Interval = 220 };
    private readonly System.Windows.Forms.Timer catalogRetryTimer = new() { Interval = 1000 };
    private readonly ContextMenuStrip trayMenu = new();
    private readonly Icon idleIcon;
    private readonly Icon activeIcon;
    private readonly NotifyIcon notifyIcon;
    private readonly List<GameChoice> games = [];
    private JsonObject state = new();
    private JsonObject settings = new();
    private JsonObject? selectedGame;
    private bool loadingSelection;
    private bool suppressControlEvents;
    private bool renderingGameList;
    private string gameListRenderSignature = string.Empty;
    private bool catalogLoading;
    private bool catalogLoaded;
    private bool catalogRefreshPending;
    private int catalogRetryCount;
    private bool timeChanging;
    private bool accelerationChanging;
    private int pendingAccelerationGameId;
    private string accelerationBusyText = "处理中…";
    private TaskCompletionSource<bool>? accelerationCompletion;
    private bool closingConfirmed;

    internal MinimalMainForm(NativeBridgeClient client, bool startInBackground, bool previewMode = false)
    {
        this.client = client;
        this.startInBackground = startInBackground;
        idleIcon = NativeShell.LoadApplicationIcon();
        activeIcon = NativeShell.CreateActiveIcon(idleIcon);
        Text = "LeigodClean";
        Icon = idleIcon;
        Font = new Font("Segoe UI", 9.5F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(820, 580);
        ClientSize = new Size(960, 620);
        FormBorderStyle = FormBorderStyle.Sizable;
        BackColor = MinimalTheme.Canvas;
        ForeColor = MinimalTheme.Text;
        KeyPreview = true;

        var split = new SplitContainer
        {
            Dock = DockStyle.Fill,
            FixedPanel = FixedPanel.Panel1,
            Size = new Size(960, 510),
            SplitterDistance = 280,
            SplitterWidth = 1,
            Panel1MinSize = 240,
            Panel2MinSize = 430,
            BackColor = MinimalTheme.Border,
        };
        split.Panel1.BackColor = MinimalTheme.Surface;
        split.Panel1.Controls.Add(BuildSidebar());
        split.Panel2.BackColor = MinimalTheme.Canvas;
        split.Panel2.Padding = new Padding(18);
        split.Panel2.Controls.Add(BuildGamePanel());

        Controls.Add(split);
        Controls.Add(BuildFooter());
        Controls.Add(BuildHeader());

        trayMenu.Opening += (_, _) => BuildTrayMenu();
        notifyIcon = new NotifyIcon
        {
            Text = "LeigodClean",
            Icon = idleIcon,
            Visible = !previewMode,
        };
        notifyIcon.MouseUp += OnTrayMouseUp;

        client.StateChanged += OnStateChanged;
        client.NotificationReceived += OnNotificationReceived;
        if (!previewMode)
        {
            Shown += async (_, _) => await InitializeAsync();
        }
        Resize += (_, _) => HandleMinimize();
        FormClosing += OnFormClosing;
        FormClosed += (_, _) => DisposeNativeResources();
        searchBox.TextChanged += (_, _) => { searchTimer.Stop(); searchTimer.Start(); };
        searchTimer.Tick += async (_, _) => { searchTimer.Stop(); await SearchAsync(); };
        catalogRetryTimer.Tick += async (_, _) =>
        {
            catalogRetryTimer.Stop();
            await SearchAsync();
        };
        gameList.SelectedIndexChanged += async (_, _) =>
        {
            if (!suppressControlEvents)
            {
                await SelectGameAsync();
            }
        };
        areaBox.SelectedIndexChanged += async (_, _) =>
        {
            if (!suppressControlEvents)
            {
                await AreaChangedAsync();
            }
        };
        subAreaBox.SelectedIndexChanged += async (_, _) =>
        {
            if (!suppressControlEvents)
            {
                await LoadLinesAsync(false);
            }
        };
        lineBox.SelectedIndexChanged += async (_, _) =>
        {
            if (!suppressControlEvents)
            {
                await RememberSelectionAsync();
            }
        };
        accelerationButton.Click += async (_, _) => await ToggleAccelerationAsync();
        autoAcceleration.CheckedChanged += async (_, _) =>
        {
            if (!suppressControlEvents)
            {
                await ToggleGameAutoAsync();
            }
        };
        timeButton.Click += async (_, _) => await ToggleTimeAsync();
        KeyDown += (_, eventArgs) =>
        {
            if (eventArgs.Control && eventArgs.KeyCode == Keys.F)
            {
                searchBox.Focus();
                eventArgs.SuppressKeyPress = true;
            }
        };
    }

    private Panel BuildHeader()
    {
        var header = new Panel
        {
            Dock = DockStyle.Top,
            Height = 64,
            BackColor = MinimalTheme.Surface,
            Padding = new Padding(16, 12, 16, 11),
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 184));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        var brand = new Label
        {
            Text = "LeigodClean",
            Dock = DockStyle.Fill,
            Font = new Font(Font.FontFamily, 12F, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
        };
        searchBox.Dock = DockStyle.Fill;
        searchBox.BorderStyle = BorderStyle.FixedSingle;
        searchBox.Margin = new Padding(0, 5, 14, 4);
        var settingsButton = new Button { Text = "设置", Dock = DockStyle.Fill, Margin = new Padding(4, 3, 4, 3) };
        var aboutButton = new Button { Text = "关于", Dock = DockStyle.Fill, Margin = new Padding(4, 3, 0, 3) };
        MinimalTheme.StyleButton(settingsButton);
        MinimalTheme.StyleButton(aboutButton);
        settingsButton.Click += async (_, _) => await OpenSettingsAsync();
        aboutButton.Click += (_, _) => ShowAbout();
        layout.Controls.Add(brand, 0, 0);
        layout.Controls.Add(searchBox, 1, 0);
        layout.Controls.Add(settingsButton, 2, 0);
        layout.Controls.Add(aboutButton, 3, 0);
        header.Controls.Add(layout);
        return header;
    }

    private Panel BuildSidebar()
    {
        var sidebar = new Panel { Dock = DockStyle.Fill, BackColor = MinimalTheme.Surface, Padding = new Padding(14, 12, 10, 14) };
        var caption = new Label
        {
            Text = "游戏",
            Dock = DockStyle.Top,
            Height = 34,
            Font = new Font(Font, FontStyle.Bold),
            ForeColor = MinimalTheme.SecondaryText,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        gameList.Dock = DockStyle.Fill;
        gameList.BorderStyle = BorderStyle.None;
        gameList.IntegralHeight = false;
        gameList.HorizontalScrollbar = false;
        gameList.DrawMode = DrawMode.OwnerDrawFixed;
        gameList.ItemHeight = 42;
        gameList.BackColor = MinimalTheme.Surface;
        gameList.ForeColor = MinimalTheme.Text;
        gameList.DrawItem += DrawGameItem;
        sidebar.Controls.Add(gameList);
        sidebar.Controls.Add(caption);
        return sidebar;
    }

    private Panel BuildFooter()
    {
        var footer = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 48,
            BackColor = MinimalTheme.Surface,
            Padding = new Padding(16, 8, 16, 8),
        };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
        serviceStatus.Dock = DockStyle.Fill;
        serviceStatus.ForeColor = MinimalTheme.SecondaryText;
        accountStatus.Dock = DockStyle.Fill;
        accountStatus.ForeColor = MinimalTheme.SecondaryText;
        accountStatus.Margin = new Padding(12, 0, 12, 0);
        MinimalTheme.StyleButton(timeButton);
        timeButton.Dock = DockStyle.Fill;
        timeButton.Margin = new Padding(8, 0, 0, 0);
        layout.Controls.Add(serviceStatus, 0, 0);
        layout.Controls.Add(accountStatus, 1, 0);
        layout.Controls.Add(timeButton, 2, 0);
        footer.Controls.Add(layout);
        return footer;
    }

    private MinimalSurfacePanel BuildGamePanel()
    {
        var card = new MinimalSurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(24) };
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 7,
            Margin = Padding.Empty,
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 86));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 94));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        var gameHeading = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        gameHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        gameHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 84));
        var titles = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        titles.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        titles.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        gameTitle.Text = "选择游戏";
        gameTitle.Font = new Font(Font.FontFamily, 14F, FontStyle.Bold);
        gameTitle.AutoEllipsis = true;
        gameTitle.Dock = DockStyle.Fill;
        gameTitle.Margin = Padding.Empty;
        gameTitle.TextAlign = ContentAlignment.MiddleLeft;
        gameSubtitle.AutoEllipsis = true;
        gameSubtitle.Dock = DockStyle.Fill;
        gameSubtitle.Margin = Padding.Empty;
        gameSubtitle.Padding = new Padding(0, 2, 0, 0);
        gameSubtitle.ForeColor = MinimalTheme.SecondaryText;
        gameSubtitle.TextAlign = ContentAlignment.TopLeft;
        titles.Controls.Add(gameTitle, 0, 0);
        titles.Controls.Add(gameSubtitle, 0, 1);
        gameStatus.Text = "未选择";
        gameStatus.Dock = DockStyle.Fill;
        gameStatus.Margin = new Padding(8, 22, 0, 28);
        gameStatus.TextAlign = ContentAlignment.MiddleCenter;
        gameStatus.BackColor = MinimalTheme.Canvas;
        gameStatus.ForeColor = MinimalTheme.SecondaryText;
        gameHeading.Controls.Add(titles, 0, 0);
        gameHeading.Controls.Add(gameStatus, 1, 0);
        table.Controls.Add(gameHeading, 0, 0);
        table.SetColumnSpan(gameHeading, 2);
        AddField(table, "区服", areaBox, 1);
        AddField(table, "子区服", subAreaBox, 2);
        AddField(table, "线路", lineBox, 3);
        table.Controls.Add(autoAcceleration, 1, 4);
        autoAcceleration.Margin = new Padding(0, 14, 0, 8);
        autoAcceleration.ForeColor = MinimalTheme.Text;
        selectionHint.Text = "选择区服和线路后即可开始";
        selectionHint.ForeColor = MinimalTheme.SecondaryText;
        selectionHint.Dock = DockStyle.Fill;
        selectionHint.AutoSize = false;
        selectionHint.AutoEllipsis = false;
        selectionHint.Margin = Padding.Empty;
        selectionHint.TextAlign = ContentAlignment.TopLeft;
        selectionHint.Padding = new Padding(0, 10, 0, 0);
        table.Controls.Add(selectionHint, 1, 5);
        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
        };
        MinimalTheme.StyleButton(accelerationButton, primary: true);
        buttonPanel.Controls.Add(accelerationButton);
        table.Controls.Add(buttonPanel, 0, 6);
        table.SetColumnSpan(buttonPanel, 2);
        card.Controls.Add(table);
        SetGameControlsEnabled(false);
        return card;
    }

    private void DrawGameItem(object? sender, DrawItemEventArgs eventArgs)
    {
        if (eventArgs.Index < 0 || eventArgs.Index >= gameList.Items.Count ||
            gameList.Items[eventArgs.Index] is not GameChoice game)
        {
            return;
        }
        bool selected = (eventArgs.State & DrawItemState.Selected) != 0;
        Color background = selected ? MinimalTheme.AccentSoft : MinimalTheme.Surface;
        using var backgroundBrush = new SolidBrush(background);
        eventArgs.Graphics.FillRectangle(backgroundBrush, eventArgs.Bounds);
        if (selected)
        {
            using var accentBrush = new SolidBrush(MinimalTheme.Accent);
            eventArgs.Graphics.FillRectangle(
                accentBrush,
                new Rectangle(eventArgs.Bounds.Left, eventArgs.Bounds.Top + 5, 3, eventArgs.Bounds.Height - 10));
        }
        int textLeft = eventArgs.Bounds.Left + 14;
        if (game.Active)
        {
            using var activeBrush = new SolidBrush(MinimalTheme.Success);
            eventArgs.Graphics.FillEllipse(
                activeBrush,
                new Rectangle(eventArgs.Bounds.Left + 13, eventArgs.Bounds.Top + 17, 8, 8));
            textLeft += 16;
        }
        var textBounds = new Rectangle(
            textLeft,
            eventArgs.Bounds.Top,
            Math.Max(0, eventArgs.Bounds.Right - textLeft - 8),
            eventArgs.Bounds.Height);
        TextRenderer.DrawText(
            eventArgs.Graphics,
            game.Title,
            Font,
            textBounds,
            MinimalTheme.Text,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis |
                TextFormatFlags.NoPrefix);
        if ((eventArgs.State & DrawItemState.Focus) != 0)
        {
            eventArgs.DrawFocusRectangle();
        }
    }

    internal void PreparePreview()
    {
        catalogLoaded = true;
        loadingSelection = true;
        suppressControlEvents = true;
        try
        {
            settings = new JsonObject
            {
                ["autoAccelerateGames"] = new JsonObject { ["42"] = true },
                ["gameSelections"] = new JsonObject(),
            };
            state = new JsonObject
            {
                ["application"] = new JsonObject { ["version"] = "0.7.0" },
                ["client"] = new JsonObject
                {
                    ["ready"] = true,
                    ["isLogin"] = true,
                    ["totalTimeLeft"] = 39120,
                    ["timeStatus"] = "normal",
                    ["accStatus"] = "normal",
                    ["gameId"] = 0,
                },
                ["settings"] = settings.DeepClone(),
            };
            games.Clear();
            games.AddRange([
                new GameChoice(42, "最终幻想 XIV", "国际服"),
                new GameChoice(43, "Counter-Strike 2", "Steam"),
                new GameChoice(44, "Apex Legends", "Steam / EA"),
                new GameChoice(45, "英雄联盟", "国服"),
            ]);
            selectedGame = new JsonObject
            {
                ["id"] = 42,
                ["title"] = "最终幻想 XIV",
                ["subtitle"] = "国际服",
            };
            gameTitle.Text = "最终幻想 XIV";
            gameSubtitle.Text = "国际服";
            areaBox.Items.Add(new JsonChoice("日本", new JsonObject { ["id"] = 1 }));
            areaBox.SelectedIndex = 0;
            subAreaBox.Items.Add(new JsonChoice("Elemental", new JsonObject { ["id"] = 2 }));
            subAreaBox.SelectedIndex = 0;
            lineBox.Items.Add(new JsonChoice("智能线路", new JsonObject
            {
                ["lineId"] = 3,
                ["assignId"] = 4,
                ["key"] = "preview",
            }));
            lineBox.SelectedIndex = 0;
            autoAcceleration.Checked = true;
            RenderGameList();
            renderingGameList = true;
            gameList.SelectedIndex = 0;
            renderingGameList = false;
            SetGameControlsEnabled(true);
        }
        finally
        {
            suppressControlEvents = false;
            loadingSelection = false;
        }
        SetServiceState("就绪", connected: true);
        accountStatus.Text = $"剩余 {FormatRemaining(GetDouble(ClientState, "totalTimeLeft"))}";
        timeButton.Text = "暂停时长";
        UpdateAccelerationButton();
    }

    private static void AddField(TableLayoutPanel table, string text, Control control, int row)
    {
        table.Controls.Add(new Label
        {
            Text = text,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = MinimalTheme.SecondaryText,
        }, 0, row);
        control.Margin = new Padding(0, 10, 0, 10);
        control.Dock = DockStyle.Fill;
        table.Controls.Add(control, 1, row);
    }

    private static ComboBox CreateComboBox() => new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        FlatStyle = FlatStyle.Flat,
        IntegralHeight = false,
        MaxDropDownItems = 16,
    };

    private async Task InitializeAsync()
    {
        try
        {
            SetServiceState("正在连接…");
            await client.ConnectAsync(TimeSpan.FromSeconds(35));
            JsonObject initial = (await client.InvokeAsync("initialize"))?.AsObject() ?? new JsonObject();
            ApplyState(initial);
            if (startInBackground && GetBool(settings, "minimizeToTray", true))
            {
                BeginInvoke(Hide);
            }
        }
        catch (Exception exception)
        {
            SetServiceState("连接失败", error: true);
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnStateChanged(object? sender, JsonObject next)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }
        BeginInvoke(() => ApplyState(next));
    }

    private void OnNotificationReceived(object? sender, NativeNotificationEventArgs notification)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }
        BeginInvoke(() =>
        {
            if (IsDisposed)
            {
                return;
            }
            notifyIcon.BalloonTipTitle = notification.Title;
            notifyIcon.BalloonTipText = notification.Body;
            notifyIcon.BalloonTipIcon = notification.Title.Contains("失败", StringComparison.Ordinal)
                ? ToolTipIcon.Error
                : ToolTipIcon.Info;
            notifyIcon.ShowBalloonTip(notification.Silent ? 3000 : 5000);
        });
    }

    private void ApplyState(JsonObject next)
    {
        bool wasReady = GetBool(ClientState, "ready");
        state = next;
        settings = next["settings"] as JsonObject ?? settings;
        JsonObject clientState = ClientState;
        bool ready = GetBool(clientState, "ready");
        SetServiceState(ready ? "就绪" : "正在连接…", connected: ready);
        string remaining = FormatRemaining(GetDouble(clientState, "totalTimeLeft"));
        accountStatus.Text = GetBool(clientState, "isLogin") ? $"剩余 {remaining}" : "未登录";
        bool paused = GetString(clientState, "timeStatus") == "pause";
        timeButton.Text = paused ? "恢复时长" : "暂停时长";
        timeButton.Enabled = GetBool(clientState, "isLogin") && !timeChanging;
        if (IsAccelerationConfirmed(clientState, pendingAccelerationGameId))
        {
            accelerationCompletion?.TrySetResult(true);
        }
        else if (pendingAccelerationGameId > 0 && GetBool(clientState, "needsAttention"))
        {
            string message = GetString(clientState, "message");
            accelerationCompletion?.TrySetException(new InvalidOperationException(
                string.IsNullOrWhiteSpace(message) ? "需要在官方客户端中完成操作。" : message));
        }
        notifyIcon.Icon = IsAccelerating ? activeIcon : idleIcon;
        UpdateAccelerationButton();
        RenderGameList();
        if (ready && (!wasReady || !catalogLoaded) && !catalogLoading)
        {
            BeginInvoke(new Action(() => _ = SearchAsync()));
        }
    }

    private JsonObject ClientState => state["client"] as JsonObject ?? new JsonObject();

    private void SetServiceState(string text, bool connected = false, bool error = false)
    {
        serviceStatus.Text = $"{(connected ? "●" : "○")}  {text}";
        serviceStatus.ForeColor = error
            ? MinimalTheme.Danger
            : connected ? MinimalTheme.Success : MinimalTheme.SecondaryText;
    }

    private async Task SearchAsync()
    {
        if (!client.IsConnected || !GetBool(ClientState, "ready"))
        {
            return;
        }
        if (catalogLoading)
        {
            catalogRefreshPending = true;
            return;
        }
        catalogLoading = true;
        try
        {
            string query = searchBox.Text;
            JsonNode? result = await client.InvokeAsync("searchGames", new JsonObject
            {
                ["query"] = query,
                ["limit"] = 100,
            });
            games.Clear();
            foreach (JsonNode? node in result?.AsArray() ?? [])
            {
                if (node is JsonObject game)
                {
                    games.Add(new GameChoice(GetInt(game, "id"), GetString(game, "title"), GetString(game, "subtitle")));
                }
            }
            catalogLoaded = games.Count > 0 || !string.IsNullOrWhiteSpace(query);
            if (catalogLoaded)
            {
                catalogRetryCount = 0;
                catalogRetryTimer.Stop();
            }
            else
            {
                selectionHint.Text = "正在加载游戏…";
                ScheduleCatalogRetry();
            }
            RenderGameList();
        }
        catch (Exception exception)
        {
            SetServiceState(exception.Message, error: true);
            catalogLoaded = false;
            ScheduleCatalogRetry();
        }
        finally
        {
            catalogLoading = false;
            if (catalogRefreshPending && !IsDisposed)
            {
                catalogRefreshPending = false;
                BeginInvoke(new Action(() => _ = SearchAsync()));
            }
        }
    }

    private void ScheduleCatalogRetry()
    {
        if (catalogRetryCount >= 30 || IsDisposed)
        {
            return;
        }
        catalogRetryCount++;
        catalogRetryTimer.Stop();
        catalogRetryTimer.Start();
    }

    private void RenderGameList()
    {
        int selectedId = gameList.SelectedItem is GameChoice current ? current.Id : 0;
        int activeId = IsAccelerating ? GetInt(ClientState, "gameId") : 0;
        GameChoice[] orderedGames = [.. games.OrderBy(game => game.Id == activeId ? 0 : 1)];
        string signature = $"{activeId}|{string.Join('|', orderedGames.Select(game =>
            $"{game.Id}:{game.Title}:{game.Subtitle}"))}";
        if (string.Equals(signature, gameListRenderSignature, StringComparison.Ordinal))
        {
            return;
        }
        gameListRenderSignature = signature;
        renderingGameList = true;
        gameList.BeginUpdate();
        try
        {
            gameList.Items.Clear();
            foreach (GameChoice game in orderedGames)
            {
                game.Active = game.Id == activeId && IsAccelerating;
                gameList.Items.Add(game);
                if (game.Id == selectedId)
                {
                    gameList.SelectedItem = game;
                }
            }
        }
        finally
        {
            gameList.EndUpdate();
            renderingGameList = false;
        }
    }

    private async Task SelectGameAsync()
    {
        if (gameList.SelectedItem is not GameChoice choice || loadingSelection || renderingGameList)
        {
            return;
        }
        loadingSelection = true;
        try
        {
            selectedGame = (await client.InvokeAsync("getGame", new JsonObject { ["gameId"] = choice.Id }))?.AsObject();
            if (selectedGame is null)
            {
                return;
            }
            gameTitle.Text = GetString(selectedGame, "title");
            gameSubtitle.Text = GetString(selectedGame, "subtitle");
            FillAreas();
            autoAcceleration.Checked = GetBool(
                settings["autoAccelerateGames"] as JsonObject ?? new JsonObject(),
                choice.Id.ToString(CultureInfo.InvariantCulture));
            SetGameControlsEnabled(true);
            loadingSelection = false;
            await AreaChangedAsync();
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            loadingSelection = false;
        }
    }

    private void FillAreas()
    {
        areaBox.Items.Clear();
        int preferred = PreferredInt("areaId");
        foreach (JsonNode? node in selectedGame?["areas"]?.AsArray() ?? [])
        {
            if (node is JsonObject area)
            {
                var choice = new JsonChoice(GetString(area, "title"), area);
                areaBox.Items.Add(choice);
                if (GetInt(area, "id") == preferred)
                {
                    areaBox.SelectedItem = choice;
                }
            }
        }
        if (areaBox.SelectedIndex < 0 && areaBox.Items.Count > 0)
        {
            areaBox.SelectedIndex = 0;
        }
    }

    private async Task AreaChangedAsync()
    {
        if (loadingSelection || areaBox.SelectedItem is not JsonChoice area)
        {
            return;
        }
        loadingSelection = true;
        try
        {
            subAreaBox.Items.Clear();
            int preferred = PreferredInt("subAreaId");
            foreach (JsonNode? node in area.Data["subAreas"]?.AsArray() ?? [])
            {
                if (node is JsonObject subArea)
                {
                    var choice = new JsonChoice(GetString(subArea, "title"), subArea);
                    subAreaBox.Items.Add(choice);
                    if (GetInt(subArea, "id") == preferred)
                    {
                        subAreaBox.SelectedItem = choice;
                    }
                }
            }
            subAreaBox.Enabled = subAreaBox.Items.Count > 0;
            if (subAreaBox.SelectedIndex < 0 && subAreaBox.Items.Count > 0)
            {
                subAreaBox.SelectedIndex = 0;
            }
        }
        finally
        {
            loadingSelection = false;
        }
        await LoadLinesAsync(false);
    }

    private async Task LoadLinesAsync(bool refresh)
    {
        if (loadingSelection || selectedGame is null || areaBox.SelectedItem is not JsonChoice area ||
            !GetBool(ClientState, "isLogin"))
        {
            lineBox.Items.Clear();
            return;
        }
        try
        {
            lineBox.Enabled = false;
            JsonNode? result = await client.InvokeAsync("getLines", new JsonObject
            {
                ["gameId"] = GetInt(selectedGame, "id"),
                ["areaId"] = GetInt(area.Data, "id"),
                ["subAreaId"] = subAreaBox.SelectedItem is JsonChoice sub ? GetInt(sub.Data, "id") : -1,
                ["refresh"] = refresh,
            });
            lineBox.Items.Clear();
            int preferredLine = PreferredInt("lineId");
            int preferredAssign = PreferredInt("assignId");
            foreach (JsonNode? node in result?.AsArray() ?? [])
            {
                if (node is JsonObject line)
                {
                    string text = $"{GetString(line, "title")} — {GetString(line, "region")} / {GetString(line, "mode")}";
                    var choice = new JsonChoice(text, line);
                    lineBox.Items.Add(choice);
                    if (GetInt(line, "lineId") == preferredLine &&
                        (preferredAssign <= 0 || GetInt(line, "assignId") == preferredAssign))
                    {
                        lineBox.SelectedItem = choice;
                    }
                }
            }
            if (lineBox.SelectedIndex < 0 && lineBox.Items.Count > 0)
            {
                lineBox.SelectedIndex = 0;
            }
            lineBox.Enabled = lineBox.Items.Count > 0;
        }
        catch (Exception exception)
        {
            SetServiceState(exception.Message, error: true);
        }
        UpdateAccelerationButton();
    }

    private async Task RememberSelectionAsync()
    {
        if (loadingSelection || selectedGame is null || areaBox.SelectedItem is not JsonChoice area ||
            lineBox.SelectedItem is not JsonChoice line)
        {
            return;
        }
        await client.InvokeAsync("rememberSelection", new JsonObject
        {
            ["gameId"] = GetInt(selectedGame, "id"),
            ["areaId"] = GetInt(area.Data, "id"),
            ["subAreaId"] = subAreaBox.SelectedItem is JsonChoice sub ? GetInt(sub.Data, "id") : -1,
            ["lineId"] = GetInt(line.Data, "lineId"),
            ["assignId"] = GetInt(line.Data, "assignId"),
            ["lineTitle"] = GetString(line.Data, "title"),
            ["lineMode"] = GetString(line.Data, "mode"),
        });
    }

    private async Task ToggleAccelerationAsync()
    {
        if (selectedGame is null || accelerationChanging)
        {
            return;
        }
        int gameId = GetInt(selectedGame, "id");
        bool stopping = IsAccelerating && GetInt(ClientState, "gameId") == gameId;
        if (!stopping)
        {
            pendingAccelerationGameId = gameId;
            accelerationCompletion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        SetBusy(true, stopping ? "正在停止…" : "正在启动…");
        try
        {
            if (stopping)
            {
                ApplyState((await client.InvokeAsync("stopAcceleration"))?.AsObject() ?? state);
            }
            else if (areaBox.SelectedItem is JsonChoice area && lineBox.SelectedItem is JsonChoice line)
            {
                ApplyState((await client.InvokeAsync("start", new JsonObject
                {
                    ["gameId"] = gameId,
                    ["areaId"] = GetInt(area.Data, "id"),
                    ["subAreaId"] = subAreaBox.SelectedItem is JsonChoice sub ? GetInt(sub.Data, "id") : -1,
                    ["lineKey"] = GetString(line.Data, "key"),
                }))?.AsObject() ?? state);
                await accelerationCompletion!.Task.WaitAsync(TimeSpan.FromSeconds(60));
                await SearchAsync();
            }
        }
        catch (TimeoutException)
        {
            MessageBox.Show(this, "等待官方加速状态超时，请稍后重试。", "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            accelerationCompletion = null;
            pendingAccelerationGameId = 0;
            SetBusy(false);
        }
    }

    private async Task ToggleGameAutoAsync()
    {
        if (loadingSelection || selectedGame is null)
        {
            return;
        }
        try
        {
            JsonObject updated = (await client.InvokeAsync("setGameAutoAcceleration", new JsonObject
            {
                ["gameId"] = GetInt(selectedGame, "id"),
                ["enabled"] = autoAcceleration.Checked,
            }))?.AsObject() ?? settings;
            settings = updated;
        }
        catch (Exception exception)
        {
            loadingSelection = true;
            autoAcceleration.Checked = !autoAcceleration.Checked;
            loadingSelection = false;
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ToggleTimeAsync()
    {
        if (timeChanging)
        {
            return;
        }
        timeChanging = true;
        timeButton.Enabled = false;
        try
        {
            ApplyState((await client.InvokeAsync("toggleTime"))?.AsObject() ?? state);
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            timeChanging = false;
            timeButton.Enabled = GetBool(ClientState, "isLogin");
        }
    }

    private async Task OpenSettingsAsync()
    {
        using var dialog = new MinimalSettingsForm(settings, selectedGame);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            if (dialog.OpenOfficialRequested)
            {
                await client.InvokeAsync("showOfficial");
            }
            return;
        }
        try
        {
            settings = (await client.InvokeAsync("updateSettings", dialog.Result))?.AsObject() ?? settings;
            state["settings"] = settings.DeepClone();
            if (dialog.ModeChanged)
            {
                await RestartApplicationAsync();
            }
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task RestartApplicationAsync()
    {
        JsonObject application = state["application"] as JsonObject ?? new JsonObject();
        int servicePid = GetInt(application, "servicePid");
        string executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法确定 LeigodClean 程序路径。");
        if (servicePid <= 0)
        {
            throw new InvalidOperationException("后台服务尚未就绪，无法自动重启。");
        }

        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
        };
        startInfo.ArgumentList.Add("--restart-wait");
        startInfo.ArgumentList.Add(servicePid.ToString(CultureInfo.InvariantCulture));
        _ = System.Diagnostics.Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法重新启动 LeigodClean。");

        closingConfirmed = true;
        try
        {
            await client.InvokeAsync("quit");
        }
        catch
        {
            // Shutdown normally closes the pipe before a response arrives.
        }
        Close();
    }

    private void BuildTrayMenu()
    {
        trayMenu.Items.Clear();
        JsonObject application = state["application"] as JsonObject ?? new JsonObject();
        JsonObject clientState = ClientState;
        bool connected = GetBool(clientState, "connected") && GetBool(clientState, "ready");
        bool loggedIn = connected && GetBool(clientState, "isLogin");
        bool paused = GetString(clientState, "timeStatus") == "pause";
        int activeGameId = IsAccelerating ? GetInt(clientState, "gameId") : 0;
        string version = GetString(application, "version");

        trayMenu.Items.Add(new ToolStripMenuItem($"LeigodClean{(string.IsNullOrWhiteSpace(version) ? string.Empty : $"  v{version}")}")
        {
            Enabled = false,
        });
        trayMenu.Items.Add(new ToolStripMenuItem(connected
            ? (loggedIn ? "已登录" : "未登录")
            : "客户端未连接")
        {
            Enabled = false,
        });
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(new ToolStripMenuItem(activeGameId > 0
            ? $"{GameTitle(activeGameId)} · 加速中"
            : "当前未加速")
        {
            Enabled = false,
        });
        if (loggedIn)
        {
            trayMenu.Items.Add(new ToolStripMenuItem($"剩余 {FormatRemaining(GetDouble(clientState, "totalTimeLeft"))}")
            {
                Enabled = false,
            });
        }
        var toggleTime = new ToolStripMenuItem(paused ? "恢复时长" : "停止并暂停")
        {
            Enabled = loggedIn && !timeChanging,
        };
        toggleTime.Click += async (_, _) => await ToggleTimeAsync();
        trayMenu.Items.Add(toggleTime);
        trayMenu.Items.Add(new ToolStripSeparator());

        var recent = new ToolStripMenuItem("最近游戏");
        int recentCount = 0;
        foreach (int gameId in RecentGameIds().Take(3))
        {
            var game = new ToolStripMenuItem($"{GameTitle(gameId)}{(gameId == activeGameId ? " · 当前" : string.Empty)}")
            {
                Enabled = loggedIn && gameId != activeGameId,
            };
            game.Click += async (_, _) => await StartRecentGameAsync(gameId);
            recent.DropDownItems.Add(game);
            recentCount++;
        }
        if (recentCount == 0)
        {
            recent.DropDownItems.Add(new ToolStripMenuItem("暂无最近游戏") { Enabled = false });
        }
        trayMenu.Items.Add(recent);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("打开 LeigodClean", null, (_, _) => RestoreWindow());
        trayMenu.Items.Add("偏好设置…", null, async (_, _) =>
        {
            RestoreWindow();
            await OpenSettingsAsync();
        });
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("退出", null, async (_, _) => await RequestExitAsync());
    }

    private void OnTrayMouseUp(object? sender, MouseEventArgs eventArgs)
    {
        NativeTrayAction action = ResolveTrayAction(eventArgs.Button);
        if (action == NativeTrayAction.Restore)
        {
            RestoreWindow();
            return;
        }
        if (action == NativeTrayAction.ShowMenu)
        {
            trayMenu.Show(Cursor.Position);
        }
    }

    internal static NativeTrayAction ResolveTrayAction(MouseButtons button) => button switch
    {
        MouseButtons.Left => NativeTrayAction.Restore,
        MouseButtons.Right => NativeTrayAction.ShowMenu,
        _ => NativeTrayAction.None,
    };

    private IEnumerable<int> RecentGameIds()
    {
        foreach (JsonNode? node in settings["recentGameIds"]?.AsArray() ?? [])
        {
            string value = node?.GetValue<string>() ?? string.Empty;
            if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int gameId) && gameId > 0)
            {
                yield return gameId;
            }
        }
    }

    private string GameTitle(int gameId)
    {
        GameChoice? choice = games.FirstOrDefault(game => game.Id == gameId);
        if (choice is not null)
        {
            return choice.Title;
        }
        if (selectedGame is not null && GetInt(selectedGame, "id") == gameId)
        {
            return GetString(selectedGame, "title");
        }
        return $"游戏 {gameId}";
    }

    private async Task StartRecentGameAsync(int gameId)
    {
        try
        {
            ApplyState((await client.InvokeAsync("startSavedGame", new JsonObject { ["gameId"] = gameId }))?.AsObject() ?? state);
            await SearchAsync();
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "LeigodClean", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ShowAbout()
    {
        JsonObject application = state["application"] as JsonObject ?? new JsonObject();
        using var dialog = new MinimalAboutForm(
            GetString(application, "version"),
            GetString(application, "versionDate"),
            GetString(ClientState, "clientVersion"));
        dialog.ShowDialog(this);
    }

    private void HandleMinimize()
    {
        if (WindowState == FormWindowState.Minimized && GetBool(settings, "minimizeToTray", true))
        {
            Hide();
        }
    }

    private void RestoreWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private async Task RequestExitAsync()
    {
        if (MessageBox.Show(this, "要退出 LeigodClean 吗？", "退出", MessageBoxButtons.YesNo,
            MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            return;
        }
        closingConfirmed = true;
        try
        {
            await client.InvokeAsync("quit");
        }
        catch
        {
            // The background process may close the pipe before acknowledging shutdown.
        }
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (closingConfirmed)
        {
            return;
        }
        eventArgs.Cancel = true;
        _ = RequestExitAsync();
    }

    private void DisposeNativeResources()
    {
        client.StateChanged -= OnStateChanged;
        client.NotificationReceived -= OnNotificationReceived;
        searchTimer.Dispose();
        catalogRetryTimer.Dispose();
        notifyIcon.Dispose();
        trayMenu.Dispose();
        activeIcon.Dispose();
        idleIcon.Dispose();
    }

    private void SetGameControlsEnabled(bool enabled)
    {
        areaBox.Enabled = enabled;
        subAreaBox.Enabled = enabled;
        lineBox.Enabled = enabled;
        autoAcceleration.Enabled = enabled;
        accelerationButton.Enabled = enabled;
    }

    private void SetBusy(bool busy, string text = "处理中…")
    {
        accelerationChanging = busy;
        if (busy)
        {
            accelerationBusyText = text;
        }
        UpdateAccelerationButton();
    }

    private void UpdateAccelerationButton()
    {
        if (accelerationChanging)
        {
            accelerationButton.Text = accelerationBusyText;
            accelerationButton.Enabled = false;
            gameStatus.Text = "处理中";
            gameStatus.BackColor = MinimalTheme.AccentSoft;
            gameStatus.ForeColor = MinimalTheme.Accent;
            return;
        }
        if (selectedGame is null)
        {
            accelerationButton.Text = "一键加速";
            accelerationButton.Enabled = false;
            gameStatus.Text = "未选择";
            gameStatus.BackColor = MinimalTheme.Canvas;
            gameStatus.ForeColor = MinimalTheme.SecondaryText;
            selectionHint.Text = "从左侧选择游戏";
            return;
        }
        bool selectedActive = IsAccelerating && GetInt(ClientState, "gameId") == GetInt(selectedGame, "id");
        accelerationButton.Text = selectedActive ? "停止加速" : "一键加速";
        accelerationButton.Enabled = selectedActive || lineBox.SelectedItem is not null;
        MinimalTheme.StyleButton(accelerationButton, primary: !selectedActive, danger: selectedActive);
        if (selectedActive)
        {
            gameStatus.Text = "加速中";
            gameStatus.BackColor = Color.FromArgb(231, 247, 238);
            gameStatus.ForeColor = MinimalTheme.Success;
            selectionHint.Text = "当前游戏正在加速";
        }
        else if (IsAccelerating)
        {
            gameStatus.Text = "可切换";
            gameStatus.BackColor = MinimalTheme.AccentSoft;
            gameStatus.ForeColor = MinimalTheme.Accent;
            selectionHint.Text = "开始后将切换到当前游戏";
        }
        else
        {
            gameStatus.Text = "未加速";
            gameStatus.BackColor = MinimalTheme.Canvas;
            gameStatus.ForeColor = MinimalTheme.SecondaryText;
            selectionHint.Text = "使用当前区服与线路";
        }
    }

    private bool IsAccelerating => GetString(ClientState, "accStatus") != "normal" &&
        GetInt(ClientState, "gameId") > 0;

    private int PreferredInt(string name)
    {
        int gameId = selectedGame is null ? 0 : GetInt(selectedGame, "id");
        JsonObject? selections = settings["gameSelections"] as JsonObject;
        return selections?[gameId.ToString(CultureInfo.InvariantCulture)] is JsonObject selection
            ? GetInt(selection, name)
            : -1;
    }

    private static string FormatRemaining(double seconds)
    {
        int minutes = Math.Max(0, (int)Math.Floor(seconds / 60));
        return $"{minutes / 60} 小时 {minutes % 60} 分";
    }

    internal static string GetString(JsonObject value, string name) =>
        value[name]?.GetValue<string>() ?? string.Empty;

    internal static int GetInt(JsonObject value, string name) =>
        value[name]?.GetValue<int>() ?? 0;

    internal static double GetDouble(JsonObject value, string name)
    {
        if (value[name] is not JsonValue number)
        {
            return 0;
        }
        if (number.TryGetValue<double>(out double doubleValue))
        {
            return doubleValue;
        }
        if (number.TryGetValue<int>(out int intValue))
        {
            return intValue;
        }
        if (number.TryGetValue<long>(out long longValue))
        {
            return longValue;
        }
        return 0;
    }

    internal static bool GetBool(JsonObject value, string name, bool fallback = false) =>
        value[name] is null ? fallback : value[name]!.GetValue<bool>();

    internal static bool IsAccelerationConfirmed(JsonObject clientState, int gameId) =>
        gameId > 0 && GetInt(clientState, "gameId") == gameId &&
        GetString(clientState, "accStatus") == "speeding";

    private sealed class GameChoice(int id, string title, string subtitle)
    {
        internal int Id { get; } = id;
        internal string Title { get; } = title;
        internal string Subtitle { get; } = subtitle;
        internal bool Active { get; set; }
        public override string ToString() => Title;
    }

    private sealed class JsonChoice(string text, JsonObject data)
    {
        internal JsonObject Data { get; } = data;
        public override string ToString() => text;
    }
}

internal sealed class MinimalSettingsForm : Form
{
    private readonly JsonObject source;
    private readonly JsonObject? selectedGame;
    private readonly CheckBox minimalMode = Box("极简模式");
    private readonly CheckBox autoAcceleration = Box("所有游戏自动加速");
    private readonly CheckBox autoPause = Box("自动暂停");
    private readonly CheckBox idlePause = Box("空闲时暂停时长");
    private readonly CheckBox launchAtLogin = Box("开机启动");
    private readonly CheckBox minimizeToTray = Box("最小化到托盘");
    private readonly CheckBox pauseOnClose = Box("退出时暂停");
    private readonly CheckBox notifications = Box("系统通知");
    private readonly NumericUpDown startup = NumberBox(1, 60);
    private readonly NumericUpDown grace = NumberBox(0.25M, 60);
    private readonly TextBox processes = new() { Multiline = true, ScrollBars = ScrollBars.Vertical, Height = 62 };

    internal MinimalSettingsForm(JsonObject settings, JsonObject? selectedGame)
    {
        source = settings.DeepClone().AsObject();
        this.selectedGame = selectedGame;
        Text = "偏好设置";
        Font = new Font("Segoe UI", 9.5F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = MinimalTheme.Canvas;
        ForeColor = MinimalTheme.Text;
        ClientSize = new Size(700, 500);

        var columns = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Padding = new Padding(18, 18, 18, 14),
        };
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        MinimalSurfacePanel options = BuildOptions();
        MinimalSurfacePanel timing = BuildTiming();
        options.Margin = new Padding(0, 0, 8, 0);
        timing.Margin = new Padding(8, 0, 0, 0);
        columns.Controls.Add(options, 0, 0);
        columns.Controls.Add(timing, 1, 0);
        var buttons = new TableLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 62,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = MinimalTheme.Surface,
            Padding = new Padding(18, 12, 18, 12),
        };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92));
        var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Dock = DockStyle.Fill, Margin = new Padding(8, 0, 0, 0) };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Dock = DockStyle.Fill, Margin = new Padding(8, 0, 0, 0) };
        var official = new Button { Text = "打开官方客户端", Width = 174, Dock = DockStyle.Left, Margin = Padding.Empty };
        MinimalTheme.StyleButton(ok, primary: true);
        MinimalTheme.StyleButton(cancel);
        MinimalTheme.StyleButton(official);
        official.Click += (_, _) => { OpenOfficialRequested = true; DialogResult = DialogResult.Cancel; Close(); };
        buttons.Controls.Add(official, 0, 0);
        buttons.Controls.Add(cancel, 1, 0);
        buttons.Controls.Add(ok, 2, 0);
        Controls.Add(columns);
        Controls.Add(buttons);
        AcceptButton = ok;
        CancelButton = cancel;
        LoadValues();
    }

    internal bool OpenOfficialRequested { get; private set; }
    internal bool ModeChanged => minimalMode.Checked != MinimalMainForm.GetBool(source, "minimalMode");

    internal JsonObject Result
    {
        get
        {
            JsonObject result = source.DeepClone().AsObject();
            result["minimalMode"] = minimalMode.Checked;
            result["autoAccelerationEnabled"] = autoAcceleration.Checked;
            result["autoPauseEnabled"] = autoPause.Checked;
            result["pauseTimeWhenIdle"] = idlePause.Checked;
            result["launchAtLogin"] = launchAtLogin.Checked;
            result["minimizeToTray"] = minimizeToTray.Checked;
            result["pauseOnClose"] = pauseOnClose.Checked;
            result["notificationsEnabled"] = notifications.Checked;
            result["startupTimeoutMinutes"] = decimal.ToDouble(startup.Value);
            result["graceMinutes"] = decimal.ToDouble(grace.Value);
            if (selectedGame is not null)
            {
                string gameId = MinimalMainForm.GetInt(selectedGame, "id").ToString(CultureInfo.InvariantCulture);
                JsonObject overrides = result["processOverrides"] as JsonObject ?? new JsonObject();
                JsonArray values = new(processes.Text.Split([',', '，', ';', '；', '\r', '\n'],
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(value => JsonValue.Create(value)).ToArray());
                if (values.Count > 0)
                {
                    overrides[gameId] = values;
                }
                else
                {
                    overrides.Remove(gameId);
                }
                result["processOverrides"] = overrides;
            }
            return result;
        }
    }

    private MinimalSurfacePanel BuildOptions()
    {
        var panel = new MinimalSurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(18) };
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 9,
        };
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        for (int index = 0; index < 8; index++)
        {
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 12.5F));
        }
        table.Controls.Add(new Label
        {
            Text = "常规",
            Dock = DockStyle.Fill,
            Font = new Font(Font, FontStyle.Bold),
            TextAlign = ContentAlignment.TopLeft,
        }, 0, 0);
        CheckBox[] options = [minimalMode, autoAcceleration, autoPause, idlePause, launchAtLogin, minimizeToTray, pauseOnClose, notifications];
        for (int index = 0; index < options.Length; index++)
        {
            options[index].Dock = DockStyle.Fill;
            table.Controls.Add(options[index], 0, index + 1);
        }
        panel.Controls.Add(table);
        return panel;
    }

    private MinimalSurfacePanel BuildTiming()
    {
        var panel = new MinimalSurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(18) };
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 18));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var title = new Label
        {
            Text = "时间与进程",
            Dock = DockStyle.Fill,
            Font = new Font(Font, FontStyle.Bold),
            TextAlign = ContentAlignment.TopLeft,
        };
        table.Controls.Add(title, 0, 0);
        table.SetColumnSpan(title, 2);
        table.Controls.Add(SettingLabel("启动等待（分钟）"), 0, 1);
        startup.Anchor = AnchorStyles.Right;
        table.Controls.Add(startup, 1, 1);
        table.Controls.Add(SettingLabel("退出宽限（分钟）"), 0, 2);
        grace.Anchor = AnchorStyles.Right;
        table.Controls.Add(grace, 1, 2);
        var processTitle = new Label
        {
            Text = selectedGame is null ? "游戏进程" : MinimalMainForm.GetString(selectedGame, "title"),
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.SecondaryText,
            TextAlign = ContentAlignment.BottomLeft,
        };
        table.Controls.Add(processTitle, 0, 4);
        table.SetColumnSpan(processTitle, 2);
        table.SetColumnSpan(processes, 2);
        processes.Dock = DockStyle.Fill;
        processes.BorderStyle = BorderStyle.FixedSingle;
        table.Controls.Add(processes, 0, 5);
        panel.Controls.Add(table);
        return panel;
    }

    private static Label SettingLabel(string text) => new()
    {
        Text = text,
        Dock = DockStyle.Fill,
        ForeColor = MinimalTheme.SecondaryText,
        TextAlign = ContentAlignment.MiddleLeft,
    };

    private void LoadValues()
    {
        minimalMode.Checked = MinimalMainForm.GetBool(source, "minimalMode");
        autoAcceleration.Checked = MinimalMainForm.GetBool(source, "autoAccelerationEnabled");
        autoPause.Checked = MinimalMainForm.GetBool(source, "autoPauseEnabled", true);
        idlePause.Checked = MinimalMainForm.GetBool(source, "pauseTimeWhenIdle", true);
        launchAtLogin.Checked = MinimalMainForm.GetBool(source, "launchAtLogin");
        minimizeToTray.Checked = MinimalMainForm.GetBool(source, "minimizeToTray", true);
        pauseOnClose.Checked = MinimalMainForm.GetBool(source, "pauseOnClose", true);
        notifications.Checked = MinimalMainForm.GetBool(source, "notificationsEnabled", true);
        startup.Value = Math.Clamp((decimal)MinimalMainForm.GetDouble(source, "startupTimeoutMinutes"), startup.Minimum, startup.Maximum);
        grace.Value = Math.Clamp((decimal)MinimalMainForm.GetDouble(source, "graceMinutes"), grace.Minimum, grace.Maximum);
        JsonArray? values = ResolveDisplayedProcesses(source, selectedGame);
        if (values is not null)
        {
            processes.Text = string.Join(", ", values.Select(value => value?.GetValue<string>() ?? string.Empty));
        }
        processes.Enabled = selectedGame is not null;
    }

    internal static JsonArray? ResolveDisplayedProcesses(JsonObject settings, JsonObject? game)
    {
        if (game is null)
        {
            return null;
        }
        string gameId = MinimalMainForm.GetInt(game, "id").ToString(CultureInfo.InvariantCulture);
        return settings["processOverrides"] is JsonObject overrides && overrides[gameId] is JsonArray custom
            ? custom
            : game["processes"] as JsonArray;
    }

    private static CheckBox Box(string text) => new()
    {
        Text = text,
        AutoSize = false,
        Margin = Padding.Empty,
        ForeColor = MinimalTheme.Text,
    };

    private static NumericUpDown NumberBox(decimal minimum, decimal maximum) => new()
    {
        Minimum = minimum,
        Maximum = maximum,
        DecimalPlaces = minimum < 1 ? 2 : 0,
        Increment = minimum < 1 ? 0.25M : 1,
        Width = 85,
    };
}

internal sealed class MinimalAboutForm : Form
{
    internal MinimalAboutForm(string version, string versionDate, string clientVersion)
    {
        Text = "关于 LeigodClean";
        Font = new Font("Segoe UI", 9.5F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        BackColor = MinimalTheme.Canvas;
        ForeColor = MinimalTheme.Text;
        ClientSize = new Size(440, 300);

        var card = new MinimalSurfacePanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(28, 24, 28, 20),
            Margin = Padding.Empty,
        };
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        table.Controls.Add(new Label
        {
            Text = "LeigodClean",
            Dock = DockStyle.Fill,
            Font = new Font(Font.FontFamily, 16F, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
        }, 0, 0);
        table.Controls.Add(new Label
        {
            Text = string.IsNullOrWhiteSpace(version) ? "" : $"版本 {version}",
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.SecondaryText,
            TextAlign = ContentAlignment.TopLeft,
        }, 0, 1);
        table.Controls.Add(new Label
        {
            Text = "简洁的 Windows 加速控制界面",
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.Text,
            TextAlign = ContentAlignment.MiddleLeft,
        }, 0, 2);
        table.Controls.Add(new Label
        {
            Text = string.IsNullOrWhiteSpace(clientVersion) ? "雷神客户端版本未知" : $"雷神客户端 {clientVersion}",
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.SecondaryText,
        }, 0, 3);
        table.Controls.Add(new Label
        {
            Text = string.IsNullOrWhiteSpace(versionDate) ? "MIT License · bunwright" : $"{versionDate} · MIT License · bunwright",
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.SecondaryText,
        }, 0, 4);
        var close = new Button { Text = "关闭", Width = 88, Height = 34, Dock = DockStyle.Right, DialogResult = DialogResult.OK };
        MinimalTheme.StyleButton(close, primary: true);
        table.Controls.Add(close, 0, 5);
        card.Controls.Add(table);
        var outer = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18), BackColor = MinimalTheme.Canvas };
        outer.Controls.Add(card);
        Controls.Add(outer);
        AcceptButton = close;
        CancelButton = close;
    }
}
