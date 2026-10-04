// PlanetaryClimateSim.exe - standalone launcher for the Planetary Climate Simulator.
//
// A tiny .NET Framework program that embeds its own static HTTP server and serves
// the app (index.html + the src/ ES modules) straight from the folder the exe
// lives in. The executable + project folder together form a portable, offline
// package: no Node, no npm, no network.
//
// Why a launcher at all: the simulator is an ES-module web app, and browsers
// refuse to load ES modules from file:// URLs. Serving over loopback is the
// correct fix, and this exe makes that a single double-click.
//
// Build: see build/build-exe.ps1 (uses the in-box csc.exe, no SDK required).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PlanetaryClimateSim
{
    internal static class Program
    {
        // ASCII-only strings keep this source encoding-independent (csc reads it
        // as ANSI unless a BOM is present). All real UI text comes from the web app.
        internal const string AppTitle = "Planetary Climate Simulator";

        [STAThread]
        private static void Main(string[] args)
        {
            Options opts = ParseArgs(args);

            string root = ResolveRoot(opts.RootDir);
            if (root == null || !File.Exists(Path.Combine(root, "index.html")))
            {
                MessageBox.Show(
                    "Could not find the application files (index.html).\n\n" +
                    "Put PlanetaryClimateSim.exe in the project folder (next to index.html),\n" +
                    "or point it there explicitly:\n" +
                    "    PlanetaryClimateSim.exe --root \"D:\\path\\to\\project\"",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            StaticServer server = new StaticServer(root);
            int port;
            try
            {
                port = server.Start(opts.Port > 0 ? opts.Port : 8770);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start the local server: " + ex.Message, AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string url = "http://localhost:" + port + "/";
            Console.WriteLine(AppTitle);
            Console.WriteLine("  root  : " + root);
            Console.WriteLine("  url   : " + url);
            Console.WriteLine("  stop  : close this window or press Ctrl+C");
            Console.WriteLine();

            if (!opts.NoBrowser) OpenBrowser(url);

            if (opts.Window)
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new HostForm(url, root, server));
            }
            else
            {
                ManualResetEvent quit = new ManualResetEvent(false);
                Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
                {
                    e.Cancel = true;
                    quit.Set();
                };
                AppDomain.CurrentDomain.ProcessExit += delegate { quit.Set(); };
                quit.WaitOne();
            }
            server.Stop();
        }

        private sealed class Options
        {
            public int Port;
            public bool NoBrowser;
            public bool Window = true;
            public string RootDir;
        }

        private static Options ParseArgs(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--port" && i + 1 < args.Length) o.Port = int.Parse(args[++i]);
                else if (a == "--no-browser") o.NoBrowser = true;
                else if (a == "--console") o.Window = false;
                else if (a == "--root" && i + 1 < args.Length) o.RootDir = args[++i];
            }
            return o;
        }

        /// <summary>
        /// Locate the folder holding index.html: an explicit --root, the exe's own
        /// directory, a bundled "app" subfolder, or one/two levels up.
        /// </summary>
        private static string ResolveRoot(string explicitDir)
        {
            List<string> candidates = new List<string>();
            if (!string.IsNullOrEmpty(explicitDir)) candidates.Add(explicitDir);
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            candidates.Add(baseDir);
            candidates.Add(Path.Combine(baseDir, "app"));
            try { candidates.Add(Path.GetFullPath(Path.Combine(baseDir, ".."))); } catch { }
            try { candidates.Add(Path.GetFullPath(Path.Combine(baseDir, "..", ".."))); } catch { }
            foreach (string c in candidates)
            {
                try
                {
                    if (File.Exists(Path.Combine(c, "index.html")) &&
                        Directory.Exists(Path.Combine(c, "src")))
                        return Path.GetFullPath(c);
                }
                catch { /* keep looking */ }
            }
            return null;
        }

        internal static void OpenBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { try { Process.Start(url); } catch { /* ignored */ } }
        }
    }

    /// <summary>
    /// Minimal static file server built directly on TcpListener.
    ///
    /// Deliberately not HttpListener: that class needs the http.sys kernel driver
    /// and a URL ACL reservation, and it throws PlatformNotSupportedException in
    /// restricted environments. Plain sockets work everywhere and need no admin
    /// rights, which is exactly what a double-click launcher requires.
    /// </summary>
    internal sealed class StaticServer
    {
        private static readonly Dictionary<string, string> Mime =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { ".html", "text/html; charset=utf-8" },
                { ".js", "text/javascript; charset=utf-8" },
                { ".mjs", "text/javascript; charset=utf-8" },
                { ".css", "text/css; charset=utf-8" },
                { ".json", "application/json; charset=utf-8" },
                { ".png", "image/png" },
                { ".jpg", "image/jpeg" },
                { ".svg", "image/svg+xml" },
                { ".ico", "image/x-icon" },
                { ".txt", "text/plain; charset=utf-8" },
                { ".md", "text/markdown; charset=utf-8" },
                { ".map", "application/json; charset=utf-8" },
            };

        private readonly string _root;
        private TcpListener _listener;
        private Thread _accept;
        private volatile bool _running;

        public string Root { get { return _root; } }
        public int Port { get; private set; }
        public long Requests;

        public StaticServer(string root) { _root = root; }

        public int Start(int preferredPort)
        {
            for (int p = preferredPort; p < preferredPort + 40; p++)
            {
                TcpListener l = null;
                try
                {
                    l = new TcpListener(IPAddress.Loopback, p);
                    l.Start();
                }
                catch
                {
                    try { if (l != null) l.Stop(); } catch { }
                    continue;
                }
                _listener = l;
                Port = p;
                _running = true;
                _accept = new Thread(AcceptLoop) { IsBackground = true, Name = "pcs-http" };
                _accept.Start();
                return p;
            }
            throw new IOException("None of the 40 ports starting at " + preferredPort + " could be used.");
        }

        public void Stop()
        {
            _running = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client = null;
                try { client = _listener.AcceptTcpClient(); }
                catch { if (!_running) return; continue; }
                TcpClient c = client;
                Thread t = new Thread(delegate() { Serve(c); });
                t.IsBackground = true;
                t.Start();
            }
        }

        /* ---------------- HTTP/1.1 ---------------- */

        private void Serve(TcpClient client)
        {
            try
            {
                using (client)
                using (NetworkStream ns = client.GetStream())
                {
                    ns.ReadTimeout = 15000;
                    ns.WriteTimeout = 30000;
                    while (true)
                    {
                        string requestLine;
                        Dictionary<string, string> headers;
                        if (!ReadHead(ns, out requestLine, out headers)) return;
                        if (requestLine == null) return;

                        string[] parts = requestLine.Split(' ');
                        if (parts.Length < 3) { WriteStatus(ns, 400, "bad request", null); return; }
                        string method = parts[0].ToUpperInvariant();
                        string target = parts[1];

                        int q = target.IndexOf('?');
                        if (q >= 0) target = target.Substring(0, q);

                        byte[] body = null;
                        string ctype = null;
                        int status = 200;
                        string lenHeader;
                        if (headers.TryGetValue("content-length", out lenHeader))
                        {
                            int len;
                            if (int.TryParse(lenHeader, out len) && len > 0)
                            {
                                body = new byte[len];
                                int got = 0;
                                while (got < len)
                                {
                                    int n = ns.Read(body, got, len - got);
                                    if (n <= 0) break;
                                    got += n;
                                }
                            }
                        }
                        Requests++;

                        bool keepAlive = !(headers.ContainsKey("connection") &&
                            headers["connection"].ToLowerInvariant().Contains("close"));

                        status = Route(method, target, body, out ctype, out body);
                        WriteResponse(ns, status, ctype, body, keepAlive);
                        if (!keepAlive) return;
                        if (body == null && method == "HEAD") return;
                    }
                }
            }
            catch { /* client went away; nothing to do */ }
        }

        private static bool ReadHead(NetworkStream ns, out string requestLine, out Dictionary<string, string> headers)
        {
            requestLine = null;
            headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            List<byte> buffer = new List<byte>(1024);
            byte[] one = new byte[1];
            int state = 0;
            while (true)
            {
                int n;
                try { n = ns.Read(one, 0, 1); }
                catch { return false; }
                if (n <= 0) return buffer.Count > 0;
                byte b = one[0];
                if (b == (byte)'\r') continue;
                if (b == (byte)'\n')
                {
                    if (state == 0) { if (buffer.Count == 0) return buffer.Count > 0; }
                    string line = Encoding.ASCII.GetString(buffer.ToArray());
                    buffer.Clear();
                    if (requestLine == null) { requestLine = line.Trim(); }
                    else
                    {
                        int c = line.IndexOf(':');
                        if (c > 0) headers[line.Substring(0, c).Trim()] = line.Substring(c + 1).Trim();
                    }
                    if (state == 0) state = 1;
                    else if (line.Length == 0) return true;
                    continue;
                }
                buffer.Add(b);
                if (buffer.Count > 16384) return false;
            }
        }

        private int Route(string method, string target, byte[] requestBody, out string ctype, out byte[] body)
        {
            ctype = "text/plain; charset=utf-8";
            body = null;

            // Test-harness result sink: POST /__result -> tests/last-report.json
            if (method == "POST" && target == "/__result")
            {
                try
                {
                    string dir = Path.Combine(_root, "tests");
                    Directory.CreateDirectory(dir);
                    File.WriteAllBytes(Path.Combine(dir, "last-report.json"), requestBody ?? new byte[0]);
                }
                catch { }
                ctype = "application/json";
                body = Encoding.UTF8.GetBytes("{\"ok\":true}");
                return 200;
            }
            if (method != "GET" && method != "HEAD")
            {
                body = Encoding.UTF8.GetBytes("method not allowed");
                return 405;
            }

            string rel = Uri.UnescapeDataString(target).TrimStart('/');
            if (rel.Length == 0 || rel.EndsWith("/")) rel += "index.html";

            string full;
            try { full = Path.GetFullPath(Path.Combine(_root, rel)); }
            catch { body = Encoding.UTF8.GetBytes("bad path"); return 400; }

            string rootFull = Path.GetFullPath(_root);
            // trim any trailing separator so the "is inside root" test cannot end
            // up comparing against a doubled separator
            while (rootFull.Length > 3 &&
                   (rootFull.EndsWith(Path.DirectorySeparatorChar.ToString()) ||
                    rootFull.EndsWith(Path.AltDirectorySeparatorChar.ToString())))
                rootFull = rootFull.Substring(0, rootFull.Length - 1);
            string sep = Path.DirectorySeparatorChar.ToString();
            if (!full.StartsWith(rootFull + sep, StringComparison.OrdinalIgnoreCase))
            {
                body = Encoding.UTF8.GetBytes("forbidden: " + full + " not under " + rootFull);
                return 403;
            }
            if (!File.Exists(full))
            {
                body = Encoding.UTF8.GetBytes("404 not found: " + rel);
                return 404;
            }

            string ext = Path.GetExtension(full);
            string mime;
            if (!Mime.TryGetValue(ext, out mime)) mime = "application/octet-stream";
            ctype = mime;
            body = File.ReadAllBytes(full);
            return 200;
        }

        private static void WriteResponse(NetworkStream ns, int status, string ctype, byte[] body, bool keepAlive)
        {
            int len = body == null ? 0 : body.Length;
            StringBuilder head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(StatusText(status)).Append("\r\n");
            head.Append("Content-Type: ").Append(ctype ?? "application/octet-stream").Append("\r\n");
            head.Append("Content-Length: ").Append(len).Append("\r\n");
            head.Append("Cache-Control: no-store\r\n");
            head.Append("Connection: ").Append(keepAlive ? "keep-alive" : "close").Append("\r\n");
            head.Append("\r\n");
            byte[] hb = Encoding.ASCII.GetBytes(head.ToString());
            ns.Write(hb, 0, hb.Length);
            if (body != null && len > 0) ns.Write(body, 0, len);
            ns.Flush();
        }

        private static void WriteStatus(NetworkStream ns, int status, string text, string ctype)
        {
            WriteResponse(ns, status, ctype ?? "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(text), false);
        }

        private static string StatusText(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 400: return "Bad Request";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 405: return "Method Not Allowed";
                default: return "Internal Server Error";
            }
        }
    }

    /// <summary>
    /// Control window: shows the address, keeps the server alive, and offers
    /// shortcuts to open the app, copy the URL or browse the program folder.
    /// All captions are ASCII so the source stays encoding-independent.
    /// </summary>
    internal sealed class HostForm : Form
    {
        private readonly StaticServer _server;
        private readonly Label _status;

        public HostForm(string url, string root, StaticServer server)
        {
            _server = server;

            Text = Program.AppTitle + "  |  " + url;
            ClientSize = new Size(600, 268);
            MinimumSize = new Size(500, 268);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(12, 17, 23);
            ForeColor = Color.FromArgb(201, 211, 222);
            Font = new Font("Segoe UI", 9f);

            Label title = new Label();
            title.Text = Program.AppTitle;
            title.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(230, 237, 244);
            title.AutoSize = true;
            title.Location = new Point(18, 16);

            Label subtitle = new Label();
            subtitle.Text = "Local server is running - everything works offline.";
            subtitle.ForeColor = Color.FromArgb(124, 139, 156);
            subtitle.AutoSize = true;
            subtitle.Location = new Point(20, 46);

            Label addrLabel = new Label();
            addrLabel.Text = "Address";
            addrLabel.ForeColor = Color.FromArgb(124, 139, 156);
            addrLabel.AutoSize = true;
            addrLabel.Location = new Point(20, 82);

            TextBox addr = new TextBox();
            addr.Text = url;
            addr.ReadOnly = true;
            addr.BackColor = Color.FromArgb(7, 10, 14);
            addr.ForeColor = Color.FromArgb(216, 230, 242);
            addr.BorderStyle = BorderStyle.FixedSingle;
            addr.Font = new Font("Consolas", 10f);
            addr.Location = new Point(20, 101);
            addr.Width = 380;

            Button openBtn = MakeButton("Open app", 412, 99, 92, true);
            openBtn.Click += delegate { Program.OpenBrowser(url); };

            Button copyBtn = MakeButton("Copy URL", 412, 131, 92, false);
            copyBtn.Click += delegate
            {
                try { Clipboard.SetText(url); _status.Text = "URL copied to the clipboard."; }
                catch { _status.Text = "Copy failed - select the text field manually."; }
            };

            Button dirBtn = MakeButton("Open folder", 412, 163, 92, false);
            dirBtn.Click += delegate
            {
                try { Process.Start(new ProcessStartInfo("explorer.exe", "\"" + root + "\"")); }
                catch { }
            };

            Label path = new Label();
            path.Text = "Files: " + root;
            path.ForeColor = Color.FromArgb(91, 104, 117);
            path.AutoSize = false;
            path.Location = new Point(20, 134);
            path.Size = new Size(380, 30);

            _status = new Label();
            _status.Text = "Closing this window stops the server.";
            _status.ForeColor = Color.FromArgb(124, 139, 156);
            _status.AutoSize = true;
            _status.Location = new Point(20, 172);

            Label hint = new Label();
            hint.Text = "The browser should have opened automatically. Loading the simulation modules\n" +
                        "takes a moment on first run. Keep this window open while you work.";
            hint.ForeColor = Color.FromArgb(91, 104, 117);
            hint.AutoSize = false;
            hint.Location = new Point(20, 200);
            hint.Size = new Size(560, 44);

            Controls.Add(title);
            Controls.Add(subtitle);
            Controls.Add(addrLabel);
            Controls.Add(addr);
            Controls.Add(openBtn);
            Controls.Add(copyBtn);
            Controls.Add(dirBtn);
            Controls.Add(path);
            Controls.Add(_status);
            Controls.Add(hint);
        }

        private static Button MakeButton(string text, int x, int y, int w, bool primary)
        {
            Button b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, 26);
            b.FlatStyle = FlatStyle.Flat;
            b.BackColor = primary ? Color.FromArgb(29, 51, 80) : Color.FromArgb(19, 26, 35);
            b.ForeColor = primary ? Color.FromArgb(216, 230, 242) : Color.FromArgb(201, 211, 222);
            b.FlatAppearance.BorderColor = primary ? Color.FromArgb(45, 75, 109) : Color.FromArgb(42, 54, 68);
            return b;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _server.Stop();
            base.OnFormClosed(e);
        }
    }
}
