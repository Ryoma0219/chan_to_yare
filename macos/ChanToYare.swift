// Chan to Yare.app
//
// http://127.0.0.1:7878/ (cc-dashboard のサーバー) を WKWebView 1枚で開く Mac アプリ。
// サーバーは LaunchAgent (com.ryoma0219.cc-dashboard) が動かしていて、このアプリは表示と
// macOS との橋渡し (Dock のバッジ・通知・音・ログイン時の起動) だけを受け持つ。
//
// ページとの橋渡しは WKScriptMessageHandler "ccd":
//   ページ → アプリ  {type: 'badge', count} / {type: 'notify', title, body, sessionId, kind}
//                    {type: 'sound', kind: 'ask'|'reply'} / {type: 'soundEnabled', on}
//                    {type: 'retry'} (エラー画面の Retry ボタン)
//   アプリ → ページ  window.__ccdSound (起動時の音の ON/OFF)、window.ccdJump(sessionId)

import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let serverURL = URL(string: "http://127.0.0.1:7878/")!
let bundleID = "com.ryoma0219.chan-to-yare"
let showRequest = Notification.Name("com.ryoma0219.chan-to-yare.show")
let healthInterval: TimeInterval = 3
let uuidPattern = try! NSRegularExpression(pattern: "^[0-9a-fA-F-]{36}$")

func isSessionId(_ s: String) -> Bool {
  uuidPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

// サーバー (lib/auth.mjs) が作るトークン。ページには window.__ccdToken として注入し
// (public/auth.js が API に付ける)、アプリからの直接の POST には X-CC-Token で付ける
let tokenURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent(".config/cc-dashboard/token")
let tokenPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

func readToken() -> String? {
  guard let raw = try? String(contentsOf: tokenURL, encoding: .utf8) else { return nil }
  let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return tokenPattern.firstMatch(in: token, range: NSRange(token.startIndex..., in: token)) != nil ? token : nil
}

func isDashboard(_ url: URL?) -> Bool {
  guard let url else { return false }
  return url.scheme == "http" && url.host == "127.0.0.1" && url.port == 7878
}

// ~/Library/Logs/chan-to-yare.log に1行ずつ追記する
enum Log {
  static let url = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/chan-to-yare.log")
  static let stamp: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  static func write(_ message: String) {
    let line = "\(stamp.string(from: Date())) \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: url)
    }
  }
}

// ページのヘッダー (Nebula テーマの glass) に近い色。透過したタイトルバーの下地になる
let titlebarColor = NSColor(name: nil) { appearance in
  if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
    return NSColor(srgbRed: 29 / 255, green: 21 / 255, blue: 32 / 255, alpha: 1)
  }
  return NSColor(srgbRed: 253 / 255, green: 250 / 255, blue: 254 / 255, alpha: 1)
}

// WKUserContentController はハンドラーを強参照するので、間に弱参照を挟む
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(ucc, didReceive: message)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation,
  WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
  var window: NSWindow!
  var webView: WKWebView!
  var showingError = false
  var healthFailures = 0
  var healthInFlight = false
  var healthTimer: Timer?
  var loadedWithoutToken = false
  var activity: NSObjectProtocol?
  let probe: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 2
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c)
  }()

  var soundEnabled: Bool {
    get { UserDefaults.standard.bool(forKey: "soundEnabled") }
    set { UserDefaults.standard.set(newValue, forKey: "soundEnabled") }
  }

  // MARK: - Lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    UserDefaults.standard.register(defaults: ["soundEnabled": true])
    Log.write("launch pid=\(getpid())")
    buildMenu()
    buildWindow()

    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.getNotificationSettings { settings in
      Log.write("notification settings authorizationStatus=\(settings.authorizationStatus.rawValue) alertSetting=\(settings.alertSetting.rawValue)")
    }
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      Log.write("notification authorization granted=\(granted) error=\(error?.localizedDescription ?? "nil")")
    }

    // 2つ目の起動から「前に出して」と頼まれたとき
    DistributedNotificationCenter.default().addObserver(
      forName: showRequest, object: nil, queue: .main
    ) { [weak self] _ in self?.showWindow() }

    // ウィンドウを閉じていても、セッションの状態の変化を拾い続ける
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiatedAllowingIdleSystemSleep], reason: "Watching Claude Code sessions")

    loadDashboard()
    healthTimer = Timer.scheduledTimer(withTimeInterval: healthInterval, repeats: true) { [weak self] _ in
      self?.checkServer()
    }
    registerLoginItemOnce()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    Log.write("reopen (Dock) hasVisibleWindows=\(flag)")
    if !flag { showWindow() }
    return true
  }

  // MARK: - Window

  func buildWindow() {
    let config = WKWebViewConfiguration()
    let ucc = WKUserContentController()
    ucc.add(WeakMessageHandler(self), name: "ccd")
    config.userContentController = ucc
    config.websiteDataStore = .default()
    if #available(macOS 14.0, *) {
      // 背面・非表示でも JS のタイマーと SSE を止めない (バッジと通知のため)
      config.preferences.inactiveSchedulingPolicy = .none
    }
    installUserScripts(ucc)

    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 860), configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.setValue(false, forKey: "drawsBackground")
    if #available(macOS 13.3, *) { webView.isInspectable = true }

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Chan to Yare"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = titlebarColor
    window.contentMinSize = NSSize(width: 760, height: 480)
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    window.delegate = self
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("ChanToYareMain")
    window.makeKeyAndOrderFront(nil)
  }

  func installUserScripts(_ ucc: WKUserContentController, token: String? = readToken()) {
    ucc.removeAllUserScripts()
    var source = "window.__ccdSound = \(soundEnabled ? "true" : "false");"
    // readToken は 16進64文字だけを返すので、そのまま文字列リテラルに埋め込める
    if let token { source += " window.__ccdToken = '\(token)';" }
    ucc.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  @objc func showWindow() {
    if window.isMiniaturized { window.deminiaturize(nil) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: - Menu

  func buildMenu() {
    let main = NSMenu()

    let app = NSMenu(title: "Chan to Yare")
    app.addItem(withTitle: "About Chan to Yare", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Open at Login", action: #selector(toggleLoginItem(_:)), keyEquivalent: "").target = self
    app.addItem(.separator())
    app.addItem(withTitle: "Hide Chan to Yare", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit Chan to Yare", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    main.addItem(submenu(app))

    // WKWebView のテキスト欄で ⌘C / ⌘V を効かせるために要る
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    main.addItem(submenu(edit))

    let view = NSMenu(title: "View")
    // WKWebView 自身も reload(_:) を持つので、別名にしてターゲットを明示する (エラー画面からの再接続のため)
    view.addItem(withTitle: "Reload", action: #selector(reloadDashboard(_:)), keyEquivalent: "r").target = self
    view.addItem(.separator())
    for (i, (title, hash)) in [("Live", "#live"), ("Last 7 days", "#insights"), ("PRs", "#prs")].enumerated() {
      let item = view.addItem(withTitle: title, action: #selector(showView(_:)), keyEquivalent: "\(i + 1)")
      item.target = self
      item.representedObject = hash
    }
    view.addItem(.separator())
    let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fullScreen.keyEquivalentModifierMask = [.command, .control]
    main.addItem(submenu(view))

    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    win.addItem(.separator())
    win.addItem(withTitle: "Chan to Yare", action: #selector(showWindow), keyEquivalent: "0").target = self
    win.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    main.addItem(submenu(win))
    NSApp.windowsMenu = win

    NSApp.mainMenu = main
  }

  func submenu(_ menu: NSMenu) -> NSMenuItem {
    let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
    item.submenu = menu
    return item
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(toggleLoginItem(_:)) {
      item.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
    return true
  }

  func windowWillClose(_ notification: Notification) {
    Log.write("window closed (app keeps running)")
  }

  @objc func reloadDashboard(_ sender: Any?) {
    Log.write("menu reload")
    showWindow()
    if showingError || !isDashboard(webView.url) { loadDashboard() } else { webView.reload() }
  }

  @objc func showView(_ sender: NSMenuItem) {
    guard let hash = sender.representedObject as? String else { return }
    Log.write("menu view \(hash)")
    showWindow()
    guard !showingError, isDashboard(webView.url) else { return }
    webView.evaluateJavaScript("location.hash = '\(hash)'; void 0")
  }

  // MARK: - Loading and the "server is not running" view

  func loadDashboard() {
    showingError = false
    healthFailures = 0
    guard let token = readToken() else {
      // サーバーがまだトークンを作っていない。ページはロック画面に移り、トークンができたら開き直す
      Log.write("token not found, showing the locked page")
      loadedWithoutToken = true
      installUserScripts(webView.configuration.userContentController, token: nil)
      webView.load(URLRequest(url: serverURL))
      return
    }
    loadedWithoutToken = false
    installUserScripts(webView.configuration.userContentController, token: token)
    webView.load(URLRequest(url: serverURL))
  }

  func showServerDown(_ reason: String) {
    if !showingError { Log.write("server unreachable: \(reason)") }
    showingError = true
    setBadge(0)
    webView.loadHTMLString(errorPage, baseURL: nil)
  }

  func checkServer() {
    guard !healthInFlight else { return }
    healthInFlight = true
    let request = URLRequest(url: serverURL.appendingPathComponent("favicon.svg"))
    probe.dataTask(with: request) { [weak self] _, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async {
        guard let self else { return }
        self.healthInFlight = false
        if ok {
          self.healthFailures = 0
          if self.showingError {
            Log.write("server is back, reloading")
            self.loadDashboard()
          } else if self.loadedWithoutToken && readToken() != nil {
            Log.write("token appeared, reloading")
            self.loadDashboard()
          }
        } else {
          self.healthFailures += 1
          if !self.showingError && self.healthFailures >= 2 { self.showServerDown("health check") }
        }
      }
    }.resume()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    handleLoadError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleLoadError(error)
  }

  func handleLoadError(_ error: Error) {
    let e = error as NSError
    // 自分で止めた遷移 (外部リンクを既定のブラウザへ回したときなど) はエラーにしない
    if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
    if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
    showServerDown("\(e.domain) \(e.code)")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.write("web content process terminated, reloading")
    loadDashboard()
  }

  // MARK: - Links: アプリ内で開くのはダッシュボードだけ。それ以外は既定のブラウザへ

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if isDashboard(url) || url.scheme == "about" { return decisionHandler(.allow) }
    if action.targetFrame?.isMainFrame ?? true { openExternally(url) }
    decisionHandler(.cancel)
  }

  // target="_blank" のリンク
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { openExternally(url) }
    return nil
  }

  func openExternally(_ url: URL) {
    guard url.scheme == "https" || url.scheme == "http" else {
      Log.write("blocked link scheme=\(url.scheme ?? "nil")")
      return
    }
    Log.write("open in browser host=\(url.host ?? "")")
    NSWorkspace.shared.open(url)
  }

  // MARK: - Bridge (ページ → アプリ)

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    if type == "retry" {
      Log.write("bridge retry")
      loadDashboard()
      return
    }
    // バッジ・通知・音は、ダッシュボードのページ (メインフレーム) から来たものだけを受ける
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == 7878 else {
      Log.write("bridge rejected type=\(type) origin=\(origin.protocol)://\(origin.host):\(origin.port)")
      return
    }
    switch type {
    case "badge":
      let count = (body["count"] as? NSNumber)?.intValue ?? 0
      Log.write("bridge badge count=\(count)")
      setBadge(count)
    case "notify":
      notify(body)
    case "sound":
      let kind = body["kind"] as? String == "ask" ? "ask" : "reply"
      playSound(kind)
    case "soundEnabled":
      soundEnabled = (body["on"] as? Bool) ?? true
      Log.write("bridge soundEnabled on=\(soundEnabled)")
      installUserScripts(webView.configuration.userContentController)
    default:
      Log.write("bridge unknown type=\(type)")
    }
  }

  func setBadge(_ count: Int) {
    NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
  }

  func playSound(_ kind: String) {
    guard soundEnabled else {
      Log.write("bridge sound kind=\(kind) skipped (sound off)")
      return
    }
    // 返事待ち: 柔らかい Glass。確認待ち: 目立つ Hero
    let name = kind == "ask" ? "Hero" : "Glass"
    let played = NSSound(named: NSSound.Name(name))?.play() ?? false
    Log.write("bridge sound kind=\(kind) sound=\(name) played=\(played)")
  }

  // ウィンドウが見えていて、アプリが前面にあるとき
  var userIsLooking: Bool {
    NSApp.isActive && window.isVisible && !window.isMiniaturized
  }

  func notify(_ body: [String: Any]) {
    guard let sessionId = body["sessionId"] as? String, isSessionId(sessionId) else { return }
    let kind = body["kind"] as? String ?? ""
    if userIsLooking {
      Log.write("bridge notify session=\(sessionId) kind=\(kind) skipped (app is in front)")
      return
    }
    let content = UNMutableNotificationContent()
    content.title = String((body["title"] as? String ?? "Chan to Yare").prefix(200))
    content.body = String((body["body"] as? String ?? "").prefix(300))
    content.userInfo = ["sessionId": sessionId]
    content.threadIdentifier = kind
    content.sound = nil  // 音はアプリが1回だけ鳴らす
    // 同じセッションの通知は置き換える (ブラウザ版の tag と同じ)
    let request = UNNotificationRequest(identifier: sessionId, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      Log.write("bridge notify session=\(sessionId) kind=\(kind) posted error=\(error?.localizedDescription ?? "nil")")
    }
  }

  // MARK: - Notifications (アプリ → cmux のタブ)

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    DispatchQueue.main.async {
      completionHandler(self.userIsLooking ? [] : [.banner, .list])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
    DispatchQueue.main.async {
      Log.write("notification clicked session=\(sessionId ?? "nil")")
      self.showWindow()
      if let sessionId, isSessionId(sessionId) { self.jump(to: sessionId) }
      completionHandler()
    }
  }

  func jump(to sessionId: String) {
    if !showingError, isDashboard(webView.url) {
      // sessionId は UUID の形だけを通しているので、そのまま文字列リテラルに埋め込める
      webView.evaluateJavaScript("void (window.ccdJump && window.ccdJump('\(sessionId)'))")
      return
    }
    // ページがないとき (エラー画面など) はアプリから直接タブ移動を頼む。ページと同じヘッダーを付ける
    var request = URLRequest(url: serverURL.appendingPathComponent("api/focus"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("1", forHTTPHeaderField: "X-CC-Dashboard")
    if let token = readToken() { request.setValue(token, forHTTPHeaderField: "X-CC-Token") }
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["sessionId": sessionId])
    probe.dataTask(with: request) { _, response, _ in
      Log.write("focus via app status=\((response as? HTTPURLResponse)?.statusCode ?? 0)")
    }.resume()
  }

  // MARK: - Open at login

  func registerLoginItemOnce() {
    let key = "loginItemAttempted"
    let service = SMAppService.mainApp
    if UserDefaults.standard.bool(forKey: key) {
      Log.write("login item status=\(service.status.rawValue)")
      return
    }
    UserDefaults.standard.set(true, forKey: key)
    do {
      try service.register()
      Log.write("login item registered status=\(service.status.rawValue)")
    } catch {
      Log.write("login item register failed: \(error.localizedDescription)")
    }
  }

  @objc func toggleLoginItem(_ sender: NSMenuItem) {
    let service = SMAppService.mainApp
    do {
      if service.status == .enabled {
        try service.unregister()
      } else {
        try service.register()
      }
      Log.write("login item toggled status=\(service.status.rawValue)")
    } catch {
      Log.write("login item toggle failed: \(error.localizedDescription)")
      let alert = NSAlert()
      alert.messageText = "Could not change Open at Login"
      alert.informativeText =
        "\(error.localizedDescription)\n\nAdd Chan to Yare in System Settings > General > Login Items instead."
      alert.runModal()
    }
  }
}

let errorPage = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<title>Chan to Yare</title>
<style>
  :root { --ground: #18131a; --ink: #f1ebf2; --ink-2: #c4b8c6; --line: #3a2f3d; --accent: #df9ce2; }
  @media (prefers-color-scheme: light) {
    :root { --ground: #fbf9fc; --ink: #2a2230; --ink-2: #5d5162; --line: #e2d9e4; --accent: #8e3f93; }
  }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; background: var(--ground); color: var(--ink);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
    -webkit-user-select: none; cursor: default;
  }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 0.5rem; letter-spacing: 0.01em; }
  p { color: var(--ink-2); margin: 0 0 1rem; }
  code { font: 12px ui-monospace, "SF Mono", Menlo, monospace; -webkit-user-select: text; cursor: text; }
  pre { text-align: left; background: color-mix(in srgb, var(--line) 40%, transparent); border: 1px solid var(--line);
        border-radius: 6px; padding: 0.6rem 0.8rem; overflow-x: auto; margin: 0 0 1.5rem; }
  button { font: inherit; font-weight: 600; color: var(--ground); background: var(--accent); border: 0;
           border-radius: 6px; padding: 0.45rem 1.4rem; cursor: pointer; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
         margin-right: 0.5rem; vertical-align: 2px; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.25; } }
</style>
</head>
<body>
<main>
  <h1>Server is not running</h1>
  <p><span class="dot"></span>Could not reach <code>http://127.0.0.1:7878</code>. Trying again every 3 seconds.</p>
  <pre><code>launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryoma0219.cc-dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.ryoma0219.cc-dashboard</code></pre>
  <button type="button" id="retry">Retry now</button>
</main>
<script>
  document.getElementById('retry').addEventListener('click', () => {
    window.webkit?.messageHandlers?.ccd?.postMessage({ type: 'retry' });
  });
</script>
</body>
</html>
"""

// MARK: - main

// 起動は1つだけ。先に動いているものがあれば、そちらを前に出して自分は終わる
let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
  .filter { $0.processIdentifier != getpid() }
if let other = others.first {
  DistributedNotificationCenter.default().postNotificationName(
    showRequest, object: nil, userInfo: nil, deliverImmediately: true)
  if #available(macOS 14.0, *) { NSApplication.shared.yieldActivation(to: other) }
  other.activate(options: [.activateAllWindows])
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
