import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingLabel: NSTextField!
    private var serverProcess: Process?
    private var pollTimer: Timer?

    private let appURL = URL(string: "http://localhost:5173")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        createWindow()
        startServers()
        pollForFrontend()
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
    }

    private func createWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "theDAW"
        window.minSize = NSSize(width: 960, height: 640)

        let configuration = WKWebViewConfiguration()
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]

        loadingLabel = NSTextField(labelWithString: "Starting theDAW...")
        loadingLabel.alignment = .center
        loadingLabel.font = NSFont.systemFont(ofSize: 18, weight: .medium)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.frame = frame
        loadingLabel.autoresizingMask = [.width, .height]

        let container = NSView(frame: frame)
        container.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        container.addSubview(loadingLabel)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
    }

    private func startServers() {
        guard let repoPath = Bundle.main.object(forInfoDictionaryKey: "StableDAWRepositoryPath") as? String else {
            showLaunchError("Missing repository path in app bundle.")
            return
        }

        let launcher = URL(fileURLWithPath: repoPath).appendingPathComponent("start-dev.command").path
        guard FileManager.default.isExecutableFile(atPath: launcher) else {
            showLaunchError("Could not find executable launcher at \(launcher).")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [launcher]
        process.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var environment = ProcessInfo.processInfo.environment
        environment["SA3_OPEN_MODE"] = "none"
        environment["PATH"] = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "")
        process.environment = environment
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        do {
            try process.run()
            serverProcess = process
        } catch {
            showLaunchError("Could not start theDAW launcher: \(error.localizedDescription)")
        }
    }

    private func pollForFrontend() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkFrontend()
        }
        checkFrontend()
    }

    private func checkFrontend() {
        var request = URLRequest(url: appURL)
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status >= 200 && status < 500 else { return }
            DispatchQueue.main.async {
                self.pollTimer?.invalidate()
                self.pollTimer = nil
                self.loadingLabel.removeFromSuperview()
                self.webView.load(URLRequest(url: self.appURL))
            }
        }.resume()
    }

    private func showLaunchError(_ message: String) {
        loadingLabel.stringValue = message
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
