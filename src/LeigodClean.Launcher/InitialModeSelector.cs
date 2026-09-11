using System.ComponentModel;
using System.Drawing.Drawing2D;

namespace LeigodClean;

internal static class WindowsFormsBootstrap
{
    private static int initialized;

    internal static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) == 0)
        {
            ApplicationConfiguration.Initialize();
        }
    }
}

internal static class InitialModeSelector
{
    internal static void EnsureSelected()
    {
        if (MinimalModeSettings.HasExplicitMode())
        {
            return;
        }

        WindowsFormsBootstrap.Initialize();
        using Icon icon = NativeShell.LoadApplicationIcon();
        using var dialog = new FirstRunModeForm(icon);
        if (dialog.ShowDialog() != DialogResult.OK)
        {
            throw new OperationCanceledException("尚未选择界面模式。");
        }
        MinimalModeSettings.WriteMode(dialog.UseMinimalMode);
    }
}

internal sealed class FirstRunModeForm : Form
{
    private readonly ModeChoiceButton regularChoice;
    private readonly ModeChoiceButton minimalChoice;
    private readonly Button continueButton = new()
    {
        Text = "继续",
        Width = 116,
        Height = 38,
        Enabled = false,
    };

    internal FirstRunModeForm(Icon icon)
    {
        Text = "欢迎使用 LeigodClean";
        Icon = icon;
        Font = new Font("Segoe UI", 9.5F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        BackColor = MinimalTheme.Canvas;
        ForeColor = MinimalTheme.Text;
        ClientSize = new Size(720, 454);

        regularChoice = new ModeChoiceButton(
            "常规模式",
            "完整界面",
            "展示游戏封面、会话状态、延迟、丢包与流量。",
            ["信息更完整", "适合日常操作", "可查看运行图表"]);
        minimalChoice = new ModeChoiceButton(
            "极简模式",
            "原生低占用",
            "使用 Windows 原生控件，只保留加速所需功能。",
            ["不绘制网页界面", "不采集会话指标", "更少内存与 CPU 占用"]);
        regularChoice.Click += (_, _) => SelectMode(useMinimalMode: false);
        minimalChoice.Click += (_, _) => SelectMode(useMinimalMode: true);
        regularChoice.DoubleClick += (_, _) => AcceptMode(useMinimalMode: false);
        minimalChoice.DoubleClick += (_, _) => AcceptMode(useMinimalMode: true);
        continueButton.Click += (_, _) =>
        {
            DialogResult = DialogResult.OK;
            Close();
        };
        MinimalTheme.StyleButton(continueButton, primary: true);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(28, 22, 28, 0),
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        root.Controls.Add(BuildHeading(), 0, 0);
        root.Controls.Add(BuildChoices(), 0, 1);
        root.Controls.Add(BuildFooter(), 0, 2);
        Controls.Add(root);
        Shown += (_, _) => regularChoice.Focus();
    }

    internal bool UseMinimalMode { get; private set; }

    internal void PreparePreview() => SelectMode(useMinimalMode: false);

    private Panel BuildHeading()
    {
        var panel = new Panel { Dock = DockStyle.Fill };
        panel.Controls.Add(new Label
        {
            Text = "选择界面模式",
            Dock = DockStyle.Top,
            Height = 42,
            Font = new Font(Font.FontFamily, 20F, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
        });
        panel.Controls.Add(new Label
        {
            Text = "选择适合你的使用方式，之后可以随时在偏好设置中切换。",
            Dock = DockStyle.Bottom,
            Height = 48,
            ForeColor = MinimalTheme.SecondaryText,
            TextAlign = ContentAlignment.TopLeft,
        });
        return panel;
    }

    private TableLayoutPanel BuildChoices()
    {
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = Padding.Empty,
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        regularChoice.Dock = DockStyle.Fill;
        regularChoice.Margin = new Padding(0, 4, 9, 12);
        minimalChoice.Dock = DockStyle.Fill;
        minimalChoice.Margin = new Padding(9, 4, 0, 12);
        table.Controls.Add(regularChoice, 0, 0);
        table.Controls.Add(minimalChoice, 1, 0);
        return table;
    }

    private Panel BuildFooter()
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = MinimalTheme.Surface,
            Margin = Padding.Empty,
            Padding = new Padding(28, 15, 28, 15),
        };
        panel.Controls.Add(new Label
        {
            Text = "首次选择只会询问一次",
            Dock = DockStyle.Fill,
            ForeColor = MinimalTheme.SecondaryText,
            TextAlign = ContentAlignment.MiddleLeft,
        });
        continueButton.Dock = DockStyle.Right;
        panel.Controls.Add(continueButton);
        return panel;
    }

    private void SelectMode(bool useMinimalMode)
    {
        UseMinimalMode = useMinimalMode;
        regularChoice.Selected = !useMinimalMode;
        minimalChoice.Selected = useMinimalMode;
        continueButton.Enabled = true;
        AcceptButton = continueButton;
    }

    private void AcceptMode(bool useMinimalMode)
    {
        SelectMode(useMinimalMode);
        DialogResult = DialogResult.OK;
        Close();
    }
}

internal sealed class ModeChoiceButton : Button
{
    private readonly string title;
    private readonly string badge;
    private readonly string description;
    private readonly string[] details;
    private bool selected;

    internal ModeChoiceButton(string title, string badge, string description, string[] details)
    {
        this.title = title;
        this.badge = badge;
        this.description = description;
        this.details = details;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        BackColor = MinimalTheme.Surface;
        ForeColor = MinimalTheme.Text;
        Cursor = Cursors.Hand;
        TabStop = true;
        AccessibleName = title;
        AccessibleDescription = description;
    }

    [Browsable(false)]
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool Selected
    {
        get => selected;
        set
        {
            if (selected == value)
            {
                return;
            }
            selected = value;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle card = Rectangle.Inflate(ClientRectangle, -2, -2);
        using GraphicsPath cardPath = RoundedRectangle(card, 16);
        using var surface = new SolidBrush(selected ? MinimalTheme.AccentSoft : MinimalTheme.Surface);
        using var border = new Pen(selected ? MinimalTheme.Accent : MinimalTheme.Border, selected ? 2F : 1F);
        eventArgs.Graphics.FillPath(surface, cardPath);
        eventArgs.Graphics.DrawPath(border, cardPath);

        Rectangle badgeBounds = new(card.Left + 20, card.Top + 20, 98, 28);
        using GraphicsPath badgePath = RoundedRectangle(badgeBounds, 8);
        using var badgeBrush = new SolidBrush(selected ? Color.White : MinimalTheme.Canvas);
        using var badgeFont = new Font(Font, FontStyle.Bold);
        eventArgs.Graphics.FillPath(badgeBrush, badgePath);
        TextRenderer.DrawText(eventArgs.Graphics, badge, badgeFont, badgeBounds,
            selected ? MinimalTheme.Accent : MinimalTheme.SecondaryText,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

        Rectangle indicator = new(card.Right - 42, card.Top + 25, 18, 18);
        using var indicatorPen = new Pen(selected ? MinimalTheme.Accent : MinimalTheme.Border, 2F);
        eventArgs.Graphics.DrawEllipse(indicatorPen, indicator);
        if (selected)
        {
            Rectangle dot = Rectangle.Inflate(indicator, -5, -5);
            using var dotBrush = new SolidBrush(MinimalTheme.Accent);
            eventArgs.Graphics.FillEllipse(dotBrush, dot);
        }

        Rectangle titleBounds = new(card.Left + 20, card.Top + 64, card.Width - 40, 34);
        using var titleFont = new Font(Font.FontFamily, 15F, FontStyle.Bold);
        TextRenderer.DrawText(eventArgs.Graphics, title, titleFont,
            titleBounds, MinimalTheme.Text, TextFormatFlags.Left | TextFormatFlags.VerticalCenter |
            TextFormatFlags.NoPrefix);
        Rectangle descriptionBounds = new(card.Left + 20, card.Top + 102, card.Width - 40, 44);
        TextRenderer.DrawText(eventArgs.Graphics, description, Font, descriptionBounds,
            MinimalTheme.SecondaryText, TextFormatFlags.Left | TextFormatFlags.Top |
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
        int detailTop = card.Top + 158;
        foreach (string detail in details.Take(3))
        {
            Rectangle marker = new(card.Left + 21, detailTop + 6, 5, 5);
            using var markerBrush = new SolidBrush(selected ? MinimalTheme.Accent : MinimalTheme.SecondaryText);
            eventArgs.Graphics.FillEllipse(markerBrush, marker);
            Rectangle detailBounds = new(card.Left + 34, detailTop, card.Width - 54, 22);
            TextRenderer.DrawText(eventArgs.Graphics, detail, Font, detailBounds, MinimalTheme.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis |
                TextFormatFlags.NoPrefix);
            detailTop += 25;
        }
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(eventArgs.Graphics, Rectangle.Inflate(card, -6, -6));
        }
    }

    protected override void OnEnabledChanged(EventArgs eventArgs)
    {
        base.OnEnabledChanged(eventArgs);
        Invalidate();
    }

    private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        int diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
