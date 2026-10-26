// clawd-native: a small helper process for Windows features Electron does not expose.
// Protocol: one JSON object per line on stdin ({"id":1,"m":"method","a":{...}}), one JSON reply per
// line on stdout ({"id":1,"ok":true,"v":...}). Events are pushed as {"event":"name","data":{...}}.
// Compiled with the C# 5 compiler that ships with .NET Framework 4.x (no newer syntax).
// All coordinates are physical pixels (the process is per-monitor DPI aware).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace ClawdNative
{
    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        static readonly object OutLock = new object();
        static Stream StdOut;

        [STAThread]
        static int Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
            StdOut = Console.OpenStandardOutput();
            var hookThread = new Thread(HookLoop);
            hookThread.IsBackground = true;
            hookThread.SetApartmentState(ApartmentState.STA);
            hookThread.Start();

            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                var req = line;
                // Requests run on worker threads (MTA) so a slow UI Automation query never blocks others.
                ThreadPool.QueueUserWorkItem(delegate { Handle(req); });
            }
            return 0;
        }

        static void Send(object obj)
        {
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(obj) + "\n");
            lock (OutLock) { StdOut.Write(bytes, 0, bytes.Length); StdOut.Flush(); }
        }

        static void Handle(string line)
        {
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                var m = (string)req["m"];
                var a = req.ContainsKey("a") && req["a"] is Dictionary<string, object> ? (Dictionary<string, object>)req["a"] : new Dictionary<string, object>();
                object v = Dispatch(m, a);
                Send(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "v", v } });
            }
            catch (Exception ex)
            {
                Send(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "e", ex.GetType().Name + ": " + ex.Message } });
            }
        }

        static string Str(Dictionary<string, object> a, string k, string def) { return a.ContainsKey(k) && a[k] != null ? Convert.ToString(a[k]) : def; }
        static int Int(Dictionary<string, object> a, string k, int def) { return a.ContainsKey(k) && a[k] != null ? Convert.ToInt32(a[k]) : def; }
        static bool Bool(Dictionary<string, object> a, string k, bool def) { return a.ContainsKey(k) && a[k] != null ? Convert.ToBoolean(a[k]) : def; }
        static double Dbl(Dictionary<string, object> a, string k, double def) { return a.ContainsKey(k) && a[k] != null ? Convert.ToDouble(a[k]) : def; }

        /** Window to inspect: the given hwnd (the app the user was in), else the foreground window. */
        static IntPtr Target(Dictionary<string, object> a)
        {
            if (a.ContainsKey("hwnd") && a["hwnd"] != null)
            {
                var h = new IntPtr(Convert.ToInt64(a["hwnd"]));
                if (IsWindow(h)) return h;
            }
            return GetForegroundWindow();
        }

        static object Dispatch(string m, Dictionary<string, object> a)
        {
            switch (m)
            {
                case "ping": return "pong";
                case "foreground": return Foreground();
                case "selection": return Selection();
                case "windowText": return WindowText(Target(a), Int(a, "maxChars", 20000));
                case "elements": return Elements(Target(a), Str(a, "query", ""), Int(a, "max", 60));
                case "window": return WindowInfo(Target(a));
                case "elementAt": return ElementAt(Int(a, "x", 0), Int(a, "y", 0));
                case "screenshot": CurrentArgs = a; return Screenshot(Target(a), Str(a, "target", "window"), Int(a, "maxWidth", 1568), Str(a, "file", ""));
                case "sendText": return SendText(Str(a, "text", ""));
                case "sendKeys": return SendKeys(Str(a, "keys", ""));
                case "click": return Click(Int(a, "x", 0), Int(a, "y", 0), Str(a, "button", "left"), Bool(a, "double", false));
                case "focusWindow": return FocusWindow(new IntPtr(Convert.ToInt64(a["hwnd"])));
                case "clipSeq": return (long)GetClipboardSequenceNumber();
                case "altGr": return AltGrChar(Int(a, "vk", 0), Bool(a, "shift", false));
                case "notificationState": { int s; SHQueryUserNotificationState(out s); return s; }
                case "idleMs": return IdleMs();
                case "edgeBars": return EdgeBars();
                default: throw new ArgumentException("Unknown method " + m);
            }
        }

        // ---------- foreground window ----------

        static Dictionary<string, object> WindowInfo(IntPtr hwnd)
        {
            var info = new Dictionary<string, object>();
            info["hwnd"] = hwnd.ToInt64();
            var sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, sb.Capacity);
            info["title"] = sb.ToString();
            var cls = new StringBuilder(256);
            GetClassName(hwnd, cls, cls.Capacity);
            info["className"] = cls.ToString();
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            info["pid"] = (long)pid;
            string exe = "", path = "";
            try
            {
                var p = Process.GetProcessById((int)pid);
                exe = p.ProcessName + ".exe";
                try { path = p.MainModule.FileName; } catch { path = QueryPath(pid); }
            }
            catch { }
            info["process"] = exe;
            info["path"] = path;
            RECT r;
            if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hwnd, out r);
            info["bounds"] = new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } };
            return info;
        }

        static string QueryPath(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(h); }
        }

        static object Foreground()
        {
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return null;
            return WindowInfo(h);
        }

        // ---------- UI Automation ----------

        static object Selection()
        {
            var result = new Dictionary<string, object>();
            result["text"] = "";
            result["method"] = "none";
            AutomationElement el = null;
            try { el = AutomationElement.FocusedElement; } catch (Exception ex) { result["note"] = "No focused element: " + ex.Message; return result; }
            if (el == null) { result["note"] = "No focused element."; return result; }
            result["control"] = SafeType(el);
            object pat;
            // The focused element or one of its ancestors may implement TextPattern.
            var walker = TreeWalker.ControlViewWalker;
            var cur = el;
            for (int depth = 0; cur != null && depth < 6; depth++)
            {
                if (cur.TryGetCurrentPattern(TextPattern.Pattern, out pat))
                {
                    try
                    {
                        var tp = (TextPattern)pat;
                        if (tp.SupportedTextSelection != SupportedTextSelection.None)
                        {
                            var sb = new StringBuilder();
                            foreach (TextPatternRange r in tp.GetSelection()) sb.Append(r.GetText(200000));
                            result["text"] = sb.ToString();
                            result["method"] = "uia";
                            return result;
                        }
                    }
                    catch (Exception ex) { result["note"] = "TextPattern failed: " + ex.Message; }
                }
                try { cur = walker.GetParent(cur); } catch { break; }
            }
            if (!result.ContainsKey("note")) result["note"] = "This application does not expose its selection through UI Automation.";
            return result;
        }

        static string SafeType(AutomationElement e)
        {
            try { return e.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { return "Unknown"; }
        }

        static object WindowText(IntPtr h, int maxChars)
        {
            var info = WindowInfo(h);
            var sb = new StringBuilder();
            bool truncated = false;
            try
            {
                var root = AutomationElement.FromHandle(h);
                // Documents and editors expose their whole text through TextPattern.
                var docs = root.FindAll(TreeScope.Descendants, new OrCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
                foreach (AutomationElement d in docs)
                {
                    if (sb.Length >= maxChars) { truncated = true; break; }
                    object pat;
                    if (d.TryGetCurrentPattern(TextPattern.Pattern, out pat))
                    {
                        try
                        {
                            var t = ((TextPattern)pat).DocumentRange.GetText(maxChars - sb.Length + 1);
                            if (t.Length > maxChars - sb.Length) { t = t.Substring(0, maxChars - sb.Length); truncated = true; }
                            if (t.Trim().Length > 0) sb.AppendLine(t.Trim()).AppendLine();
                        }
                        catch { }
                    }
                    else if (d.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
                    {
                        try { var v = ((ValuePattern)pat).Current.Value; if (!string.IsNullOrEmpty(v)) sb.AppendLine(v); } catch { }
                    }
                }
                // Otherwise collect the names of visible text elements (dialogs, labels, lists).
                if (sb.Length < 40)
                {
                    int visited = 0;
                    var start = DateTime.UtcNow;
                    Walk(root, 0, ref visited, start, delegate (AutomationElement e)
                    {
                        if (sb.Length >= maxChars) { truncated = true; return false; }
                        string name = "";
                        try { name = e.Current.Name; } catch { }
                        var type = SafeType(e);
                        if (!string.IsNullOrEmpty(name) && name.Length > 1 && (type == "Text" || type == "Edit" || type == "Document" || type == "ListItem" || type == "Hyperlink" || type == "Button" || type == "TreeItem" || type == "DataItem" || type == "Pane" && name.Length > 30))
                            sb.AppendLine(name);
                        return true;
                    });
                }
            }
            catch (Exception ex) { info["note"] = "UI Automation failed: " + ex.Message; }
            info["text"] = sb.Length > maxChars ? sb.ToString(0, maxChars) : sb.ToString();
            info["truncated"] = truncated;
            return info;
        }

        delegate bool Visit(AutomationElement e);

        static void Walk(AutomationElement el, int depth, ref int visited, DateTime start, Visit visit)
        {
            if (depth > 40 || visited > 4000 || (DateTime.UtcNow - start).TotalMilliseconds > 5000) return;
            AutomationElement child = null;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { return; }
            while (child != null)
            {
                visited++;
                bool offscreen = false;
                try { offscreen = child.Current.IsOffscreen; } catch { }
                if (!offscreen && !visit(child)) return;
                Walk(child, depth + 1, ref visited, start, visit);
                if (visited > 4000) return;
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { return; }
            }
        }

        static Dictionary<string, object> ElementInfo(AutomationElement e)
        {
            var r = e.Current.BoundingRectangle;
            var d = new Dictionary<string, object>();
            d["name"] = e.Current.Name ?? "";
            d["type"] = SafeType(e);
            d["rect"] = new Dictionary<string, object> { { "x", r.X }, { "y", r.Y }, { "w", r.Width }, { "h", r.Height } };
            d["enabled"] = e.Current.IsEnabled;
            object pat;
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { try { var v = ((ValuePattern)pat).Current.Value; if (v != null && v.Length <= 200) d["value"] = v; } catch { } }
            if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { try { d["value"] = ((TogglePattern)pat).Current.ToggleState.ToString(); } catch { } }
            return d;
        }

        static object Elements(IntPtr h, string query, int max)
        {
            var info = WindowInfo(h);
            var list = new List<object>();
            var words = new List<string>();
            foreach (var w in query.ToLowerInvariant().Split(new[] { ' ', ',', '>' }, StringSplitOptions.RemoveEmptyEntries)) if (w.Length > 1) words.Add(w);
            var scored = new List<KeyValuePair<double, AutomationElement>>();
            try
            {
                var root = AutomationElement.FromHandle(h);
                int visited = 0;
                Walk(root, 0, ref visited, DateTime.UtcNow, delegate (AutomationElement e)
                {
                    string name = "";
                    try { name = e.Current.Name ?? ""; } catch { }
                    if (name.Length == 0) return true;
                    var type = SafeType(e);
                    if (type == "Pane" || type == "Group" || type == "Custom") return true;
                    double score = words.Count == 0 ? 1 : 0;
                    var lower = name.ToLowerInvariant();
                    foreach (var w in words) if (lower.Contains(w)) score += 1;
                    if (words.Count > 0 && lower == query.ToLowerInvariant()) score += 3;
                    if (score > 0) scored.Add(new KeyValuePair<double, AutomationElement>(score, e));
                    return scored.Count < 2000;
                });
            }
            catch (Exception ex) { info["note"] = "UI Automation failed: " + ex.Message; }
            scored.Sort(delegate (KeyValuePair<double, AutomationElement> x, KeyValuePair<double, AutomationElement> y) { return y.Key.CompareTo(x.Key); });
            foreach (var kv in scored)
            {
                if (list.Count >= max) break;
                try
                {
                    var r = kv.Value.Current.BoundingRectangle;
                    if (r.IsEmpty || r.Width < 1 || double.IsInfinity(r.X)) continue;
                    list.Add(ElementInfo(kv.Value));
                }
                catch { }
            }
            info["elements"] = list;
            return info;
        }

        static object ElementAt(int x, int y)
        {
            try
            {
                var e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                return e == null ? null : ElementInfo(e);
            }
            catch { return null; }
        }

        // ---------- screenshot ----------

        [ThreadStatic] static Dictionary<string, object> CurrentArgs;
        static int RectArg(string k) { return Int(CurrentArgs, k, 0); }

        static object Screenshot(IntPtr h, string target, int maxWidth, string file)
        {
            Rectangle rect;
            if (target == "rect")
            {
                rect = new Rectangle(RectArg("x"), RectArg("y"), Math.Max(1, RectArg("w")), Math.Max(1, RectArg("h")));
            }
            else if (target == "window")
            {
                RECT r;
                if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
                rect = new Rectangle(r.Left, r.Top, Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top));
            }
            else
            {
                var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
                rect = vs;
            }
            using (var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb))
            {
                // BitBlt with CAPTUREBLT so layered (transparent) windows are included.
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr src = GetDC(IntPtr.Zero);
                    BitBlt(dst, 0, 0, rect.Width, rect.Height, src, rect.Left, rect.Top, 0x40CC0020);
                    ReleaseDC(IntPtr.Zero, src);
                    g.ReleaseHdc(dst);
                }
                Bitmap outBmp = bmp;
                if (maxWidth > 0 && rect.Width > maxWidth)
                {
                    int h2 = (int)Math.Round(rect.Height * (maxWidth / (double)rect.Width));
                    outBmp = new Bitmap(maxWidth, Math.Max(1, h2));
                    using (var g = Graphics.FromImage(outBmp))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(bmp, 0, 0, outBmp.Width, outBmp.Height);
                    }
                }
                using (var ms = new MemoryStream())
                {
                    outBmp.Save(ms, ImageFormat.Png);
                    if (!string.IsNullOrEmpty(file)) File.WriteAllBytes(file, ms.ToArray());
                    var res = new Dictionary<string, object> { { "mime", "image/png" }, { "width", outBmp.Width }, { "height", outBmp.Height } };
                    res["data"] = string.IsNullOrEmpty(file) ? Convert.ToBase64String(ms.ToArray()) : "";
                    if (!ReferenceEquals(outBmp, bmp)) outBmp.Dispose();
                    return res;
                }
            }
        }

        // ---------- input ----------

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion u; }
        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4, KEYEVENTF_EXTENDED = 0x1;

        static INPUT Key(ushort vk, bool up)
        {
            var i = new INPUT { type = INPUT_KEYBOARD };
            i.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (IsExtended(vk) ? KEYEVENTF_EXTENDED : 0) };
            return i;
        }

        static bool IsExtended(ushort vk) { return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E; }

        static object SendText(string text)
        {
            var inputs = new List<INPUT>();
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n') { inputs.Add(Key(0x0D, false)); inputs.Add(Key(0x0D, true)); continue; }
                var down = new INPUT { type = INPUT_KEYBOARD };
                down.u.ki = new KEYBDINPUT { wScan = c, dwFlags = KEYEVENTF_UNICODE };
                var up = new INPUT { type = INPUT_KEYBOARD };
                up.u.ki = new KEYBDINPUT { wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
                inputs.Add(down); inputs.Add(up);
            }
            // Send in chunks so long texts are not dropped by the input queue.
            for (int i = 0; i < inputs.Count; i += 64)
            {
                var chunk = inputs.GetRange(i, Math.Min(64, inputs.Count - i)).ToArray();
                SendInput((uint)chunk.Length, chunk, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(8);
            }
            return true;
        }

        static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort> {
            {"ctrl",0x11},{"control",0x11},{"alt",0x12},{"shift",0x10},{"win",0x5B},{"enter",0x0D},{"return",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},
            {"space",0x20},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},
            {"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{",",0xBC},{".",0xBE},{"-",0xBD},{"=",0xBB},{";",0xBA},{"/",0xBF},{"\\",0xDC},{"[",0xDB},{"]",0xDD},{"'",0xDE},{"`",0xC0}
        };

        static ushort VkFor(string k)
        {
            k = k.Trim().ToLowerInvariant();
            if (Vk.ContainsKey(k)) return Vk[k];
            if (k.Length == 1 && char.IsLetterOrDigit(k[0])) return (ushort)char.ToUpperInvariant(k[0]);
            if (k.StartsWith("f") && k.Length <= 3) { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1); }
            throw new ArgumentException("Unknown key: " + k);
        }

        static object SendKeys(string combo)
        {
            var parts = combo.Split('+');
            var vks = new List<ushort>();
            foreach (var p in parts) if (p.Trim().Length > 0) vks.Add(VkFor(p));
            var inputs = new List<INPUT>();
            foreach (var v in vks) inputs.Add(Key(v, false));
            for (int i = vks.Count - 1; i >= 0; i--) inputs.Add(Key(vks[i], true));
            var arr = inputs.ToArray();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
            return true;
        }

        static object Click(int x, int y, string button, bool dbl)
        {
            SetCursorPos(x, y);
            Thread.Sleep(30);
            uint down = button == "right" ? 0x0008u : 0x0002u;
            uint up = button == "right" ? 0x0010u : 0x0004u;
            int times = dbl ? 2 : 1;
            for (int t = 0; t < times; t++)
            {
                var a = new INPUT { type = INPUT_MOUSE }; a.u.mi = new MOUSEINPUT { dwFlags = down };
                var b = new INPUT { type = INPUT_MOUSE }; b.u.mi = new MOUSEINPUT { dwFlags = up };
                SendInput(2, new[] { a, b }, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(40);
            }
            return true;
        }

        static object FocusWindow(IntPtr hwnd)
        {
            if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
            // A no-op Alt press lets this process hand over the foreground (Windows foreground lock rules).
            var alt = new[] { Key(0x12, false), Key(0x12, true) };
            SendInput(2, alt, Marshal.SizeOf(typeof(INPUT)));
            bool ok = SetForegroundWindow(hwnd);
            Thread.Sleep(60);
            return ok && GetForegroundWindow() == hwnd;
        }

        /** The character Ctrl+Alt(+Shift)+vk types on the current keyboard layout, or "" if none. */
        static object AltGrChar(int vk, bool shift)
        {
            var hwnd = GetForegroundWindow();
            uint pid;
            uint tid = GetWindowThreadProcessId(hwnd, out pid);
            IntPtr layout = GetKeyboardLayout(tid);
            var state = new byte[256];
            state[0x11] = 0x80; state[0x12] = 0x80; state[0xA2] = 0x80; state[0xA5] = 0x80;
            if (shift) state[0x10] = 0x80;
            var sb = new StringBuilder(8);
            uint scan = MapVirtualKeyEx((uint)vk, 0, layout);
            int n = ToUnicodeEx((uint)vk, scan, state, sb, sb.Capacity, 4, layout);
            if (n < 0) ToUnicodeEx((uint)vk, scan, state, sb, sb.Capacity, 4, layout); // clear dead key
            return n > 0 ? sb.ToString(0, n) : "";
        }

        /**
         * Always-on-top bars docked to a screen edge that do not reserve space in the work area
         * (YASB, docks, custom taskbars). Clawd stands on top of them instead of under them.
         */
        static object EdgeBars()
        {
            var list = new List<object>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h) || IsIconic(h)) return true;
                long ex = GetWindowLongPtr(h, -20).ToInt64();
                if ((ex & 0x8) == 0) return true; // WS_EX_TOPMOST
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                RECT r;
                if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
                int w = r.Right - r.Left, hh = r.Bottom - r.Top;
                if (w < 400 || hh < 12 || hh > 140) return true;
                var cls = new StringBuilder(256);
                GetClassName(h, cls, cls.Capacity);
                string c = cls.ToString();
                if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return true; // the real taskbar already reserves space
                string exe = "";
                try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }
                list.Add(new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", w }, { "h", hh }, { "className", c }, { "process", exe } });
                return true;
            }, IntPtr.Zero);
            return list;
        }

        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr l);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);

        static object IdleMs()
        {
            var li = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            GetLastInputInfo(ref li);
            return (long)((uint)Environment.TickCount - li.dwTime);
        }

        // ---------- WinEvent hooks (foreground and dialog changes) ----------

        delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        static WinEventProc HookProc;

        static void HookLoop()
        {
            HookProc = OnWinEvent;
            SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, HookProc, 0, 0, 0x0002); // EVENT_SYSTEM_FOREGROUND, OUTOFCONTEXT|SKIPOWNPROCESS
            SetWinEventHook(0x0010, 0x0010, IntPtr.Zero, HookProc, 0, 0, 0x0002); // EVENT_SYSTEM_DIALOGSTART
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
        }

        static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            if (idObject != 0 || hwnd == IntPtr.Zero) return;
            try
            {
                var info = WindowInfo(hwnd);
                Send(new Dictionary<string, object> { { "event", ev == 0x0003 ? "foreground" : "dialog" }, { "data", info } });
            }
            catch { }
        }

        // ---------- interop ----------

        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint tid);
        [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint type, IntPtr layout);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ToUnicodeEx(uint vk, uint scan, byte[] state, StringBuilder buf, int n, uint flags, IntPtr layout);
        [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    }
}
