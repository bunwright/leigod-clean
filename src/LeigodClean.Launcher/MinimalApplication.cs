using System.Globalization;
using System.Text.Json.Nodes;

namespace LeigodClean;

internal static class MinimalApplication
{
    internal static int SmokeTest()
    {
        NativeShell.ApplyApplicationIdentity();
        ApplicationConfiguration.Initialize();
        var client = new NativeBridgeClient(NativeBridgeOptions.Create());
        try
        {
            using var form = new MinimalMainForm(client, false);
            _ = form.Handle;
            return form.IsHandleCreated ? 0 : 1;
        }
        finally
        {
            client.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    internal static void Run(NativeBridgeOptions options, bool startInBackground = false)
    {
        NativeShell.ApplyApplicationIdentity();
        ApplicationConfiguration.Initialize();
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

internal sealed class MinimalMainForm : Form
{
    private readonly NativeBridgeClient client;
    private readonly bool startInBackground;
    private readonly TextBox searchBox = new();
    private readonly ListBox gameList = new();
    private readonly Label gameTitle = new();
    private readonly Label gameSubtitle = new();
    private readonly ComboBox areaBox = CreateComboBox();
    private readonly ComboBox subAreaBox = CreateComboBox();
    private readonly ComboBox lineBox = CreateComboBox();
    private readonly CheckBox autoAcceleration = new() { Text = "自动加速", AutoSize = true };
    private readonly Button accelerationButton = new() { Text = "一键加速", Width = 110, Height = 30 };
    private readonly ToolStripStatusLabel serviceStatus = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly ToolStripStatusLabel accountStatus = new();
    private readonly ToolStripButton timeButton = new() { Text = "暂停时长" };
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
    private bool renderingGameList;
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

    internal MinimalMainForm(NativeBridgeClient client, bool startInBackground)
    {
        this.client = client;
        this.startInBackground = startInBackground;
        idleIcon = NativeShell.LoadApplicationIcon();
        activeIcon = NativeShell.CreateActiveIcon(idleIcon);
        Text = "LeigodClean";
        Icon = idleIcon;
        Font = new Font("Tahoma", 9F);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(720, 470);
        ClientSize = new Size(860, 540);
        FormBorderStyle = FormBorderStyle.Sizable;
        BackColor = SystemColors.Control;

        var menu = new MenuStrip();
        var fileMenu = new ToolStripMenuItem("文件(&F)");
        fileMenu.DropDownItems.Add("退出(&X)", null, async (_, _) => await RequestExitAsync());
        menu.Items.Add(fileMenu);
        menu.Items.Add("设置(&S)", null, async (_, _) => await OpenSettingsAsync());
        menu.Items.Add("关于(&A)", null, (_, _) => ShowAbout());
        MainMenuStrip = menu;

        var searchPanel = new Panel { Dock = DockStyle.Top, Height = 42, Padding = new Padding(8) };
        var searchLabel = new Label { Text = "搜索：", AutoSize = true, Location = new Point(8, 13) };
        searchBox.Location = new Point(58, 9);
        searchBox.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right;
        searchBox.Width = 780;
        searchPanel.Controls.Add(searchLabel);
        searchPanel.Controls.Add(searchBox);

        var split = new SplitContainer
        {
            Dock = DockStyle.Fill,
            FixedPanel = FixedPanel.Panel1,
            Size = new Size(860, 450),
            SplitterDistance = 245,
            Panel1MinSize = 180,
            Panel2MinSize = 390,
        };
        gameList.Dock = DockStyle.Fill;
        gameList.IntegralHeight = false;
        gameList.HorizontalScrollbar = false;
        split.Panel1.Padding = new Padding(8, 0, 4, 8);
        split.Panel1.Controls.Add(gameList);
        split.Panel2.Padding = new Padding(12, 4, 12, 8);
        split.Panel2.Controls.Add(BuildGamePanel());

        var statusStrip = new StatusStrip { SizingGrip = false };
        statusStrip.Items.AddRange([serviceStatus, accountStatus, timeButton]);

        Controls.Add(split);
        Controls.Add(searchPanel);
        Controls.Add(menu);
        Controls.Add(statusStrip);

        trayMenu.Opening += (_, _) => BuildTrayMenu();
        notifyIcon = new NotifyIcon
        {
            Text = "LeigodClean",
            Icon = idleIcon,
            ContextMenuStrip = trayMenu,
            Visible = true,
        };
        notifyIcon.DoubleClick += (_, _) => RestoreWindow();

        client.StateChanged += OnStateChanged;
        client.NotificationReceived += OnNotificationReceived;
        Shown += async (_, _) => await InitializeAsync();
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
        gameList.SelectedIndexChanged += async (_, _) => await SelectGameAsync();
        areaBox.SelectedIndexChanged += async (_, _) => await AreaChangedAsync();
        subAreaBox.SelectedIndexChanged += async (_, _) => await LoadLinesAsync(false);
        lineBox.SelectedIndexChanged += async (_, _) => await RememberSelectionAsync();
        accelerationButton.Click += async (_, _) => await ToggleAccelerationAsync();
        autoAcceleration.CheckedChanged += async (_, _) => await ToggleGameAutoAsync();
        timeButton.Click += async (_, _) => await ToggleTimeAsync();
    }

    private TableLayoutPanel BuildGamePanel()
    {
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 7,
            Padding = new Padding(10),
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        var gameHeading = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Margin = Padding.Empty,
        };
        gameHeading.RowStyles.Add(new RowStyle(SizeType.Percent, 56));
        gameHeading.RowStyles.Add(new RowStyle(SizeType.Percent, 44));
        gameTitle.Text = "选择游戏";
        gameTitle.Font = new Font(Font, FontStyle.Bold);
        gameTitle.AutoEllipsis = true;
        gameTitle.Dock = DockStyle.Fill;
        gameTitle.TextAlign = ContentAlignment.BottomLeft;
        gameSubtitle.AutoEllipsis = true;
        gameSubtitle.Dock = DockStyle.Fill;
        gameSubtitle.ForeColor = SystemColors.GrayText;
        gameSubtitle.TextAlign = ContentAlignment.TopLeft;
        gameHeading.Controls.Add(gameTitle, 0, 0);
        gameHeading.Controls.Add(gameSubtitle, 0, 1);
        table.Controls.Add(gameHeading, 0, 0);
        table.SetColumnSpan(gameHeading, 2);
        AddField(table, "区服：", areaBox, 1);
        AddField(table, "子区服：", subAreaBox, 2);
        AddField(table, "线路：", lineBox, 3);
        table.Controls.Add(autoAcceleration, 1, 4);
        var hint = new Label
        {
            Text = "选择区服和线路后即可开始。",
            ForeColor = SystemColors.GrayText,
            Dock = DockStyle.Fill,
            AutoSize = false,
        };
        table.Controls.Add(hint, 1, 5);
        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
        };
        buttonPanel.Controls.Add(accelerationButton);
        table.Controls.Add(buttonPanel, 0, 6);
        table.SetColumnSpan(buttonPanel, 2);
        SetGameControlsEnabled(false);
        return table;
    }

    private static void AddField(TableLayoutPanel table, string text, Control control, int row)
    {
        table.Controls.Add(new Label
        {
            Text = text,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
        }, 0, row);
        control.Dock = DockStyle.Fill;
        table.Controls.Add(control, 1, row);
    }

    private static ComboBox CreateComboBox() => new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        IntegralHeight = false,
        MaxDropDownItems = 16,
    };

    private async Task InitializeAsync()
    {
        try
        {
            serviceStatus.Text = "正在连接…";
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
            serviceStatus.Text = "连接失败";
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
        serviceStatus.Text = ready ? "就绪" : "正在连接…";
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
                serviceStatus.Text = "正在加载游戏…";
                ScheduleCatalogRetry();
            }
            RenderGameList();
        }
        catch (Exception exception)
        {
            serviceStatus.Text = exception.Message;
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
        int activeId = GetInt(ClientState, "gameId");
        renderingGameList = true;
        gameList.BeginUpdate();
        try
        {
            gameList.Items.Clear();
            foreach (GameChoice game in games.OrderBy(game => game.Id == activeId ? 0 : 1))
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
            serviceStatus.Text = exception.Message;
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
        string clientVersion = GetString(clientState, "clientVersion");

        trayMenu.Items.Add(new ToolStripMenuItem($"LeigodClean{(string.IsNullOrWhiteSpace(version) ? string.Empty : $"  v{version}")}")
        {
            Enabled = false,
        });
        trayMenu.Items.Add(new ToolStripMenuItem(connected
            ? $"{(loggedIn ? "已登录" : "未登录")}{(string.IsNullOrWhiteSpace(clientVersion) ? string.Empty : $" · 雷神 {clientVersion}")}"
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
        string version = GetString(application, "version");
        string clientVersion = GetString(ClientState, "clientVersion");
        MessageBox.Show(
            this,
            $"LeigodClean {version}\n雷神客户端 {clientVersion}\n\n极简原生加速控制界面\nMIT License · bunwright",
            "关于 LeigodClean",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
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
            return;
        }
        if (selectedGame is null)
        {
            accelerationButton.Text = "一键加速";
            accelerationButton.Enabled = false;
            return;
        }
        bool selectedActive = IsAccelerating && GetInt(ClientState, "gameId") == GetInt(selectedGame, "id");
        accelerationButton.Text = selectedActive ? "停止加速" : "一键加速";
        accelerationButton.Enabled = selectedActive || lineBox.SelectedItem is not null;
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

    internal static double GetDouble(JsonObject value, string name) =>
        value[name]?.GetValue<double>() ?? 0;

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
        public override string ToString() => $"{(Active ? "● " : string.Empty)}{Title}";
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
        Text = "设置";
        Font = new Font("Tahoma", 9F);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(650, 480);

        var columns = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(10) };
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        columns.Controls.Add(BuildOptions(), 0, 0);
        columns.Controls.Add(BuildTiming(), 1, 0);
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 58,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(8, 10, 8, 8),
            WrapContents = false,
        };
        var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Width = 82, Height = 32 };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 82, Height = 32 };
        var official = new Button { Text = "官方客户端", Width = 104, Height = 32 };
        official.Click += (_, _) => { OpenOfficialRequested = true; DialogResult = DialogResult.Cancel; Close(); };
        buttons.Controls.AddRange([ok, cancel, official]);
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

    private GroupBox BuildOptions()
    {
        var group = new GroupBox { Text = "常规", Dock = DockStyle.Fill, Padding = new Padding(12) };
        var flow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
        };
        flow.Controls.AddRange([minimalMode, autoAcceleration, autoPause, idlePause, launchAtLogin, minimizeToTray, pauseOnClose, notifications]);
        group.Controls.Add(flow);
        return group;
    }

    private GroupBox BuildTiming()
    {
        var group = new GroupBox { Text = "时间与进程", Dock = DockStyle.Fill, Padding = new Padding(12) };
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        table.Controls.Add(new Label { Text = "启动等待（分钟）", AutoSize = true }, 0, 0);
        table.Controls.Add(startup, 1, 0);
        table.Controls.Add(new Label { Text = "退出宽限（分钟）", AutoSize = true }, 0, 1);
        table.Controls.Add(grace, 1, 1);
        table.Controls.Add(new Label { Text = selectedGame is null ? "游戏进程" : MinimalMainForm.GetString(selectedGame, "title"), AutoSize = true }, 0, 3);
        table.SetColumnSpan(processes, 2);
        processes.Dock = DockStyle.Fill;
        table.Controls.Add(processes, 0, 4);
        group.Controls.Add(table);
        return group;
    }

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

    private static CheckBox Box(string text) => new() { Text = text, AutoSize = true, Margin = new Padding(4, 5, 4, 5) };

    private static NumericUpDown NumberBox(decimal minimum, decimal maximum) => new()
    {
        Minimum = minimum,
        Maximum = maximum,
        DecimalPlaces = minimum < 1 ? 2 : 0,
        Increment = minimum < 1 ? 0.25M : 1,
        Width = 85,
    };
}
