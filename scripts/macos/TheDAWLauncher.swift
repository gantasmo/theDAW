import AppKit
import CoreMIDI
import WebKit

private func midiNotifyCallback(message: UnsafePointer<MIDINotification>, refCon: UnsafeMutableRawPointer?) {
    guard let refCon else { return }
    let bridge = Unmanaged<CoreMidiBridge>.fromOpaque(refCon).takeUnretainedValue()
    bridge.handleMidiNotification()
}

private func midiReadCallback(
    packetList: UnsafePointer<MIDIPacketList>,
    refCon: UnsafeMutableRawPointer?,
    sourceRefCon: UnsafeMutableRawPointer?
) {
    guard let refCon else { return }
    let bridge = Unmanaged<CoreMidiBridge>.fromOpaque(refCon).takeUnretainedValue()
    let inputName = sourceRefCon.map { Unmanaged<NSString>.fromOpaque($0).takeUnretainedValue() as String }
    bridge.handlePacketList(packetList.pointee, inputName: inputName)
}

final class CoreMidiBridge {
    private weak var webView: WKWebView?
    private var client = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var connectedSources = Set<MIDIEndpointRef>()
    private var sourceNameRefs: [MIDIEndpointRef: Unmanaged<NSString>] = [:]
    private var started = false

    init(webView: WKWebView) {
        self.webView = webView
    }

    deinit {
        stop()
    }

    func start() {
        guard !started else {
            rescanSources()
            return
        }
        started = true

        let ref = Unmanaged.passUnretained(self).toOpaque()
        let clientStatus = MIDIClientCreate("theDAW CoreMIDI Client" as CFString, midiNotifyCallback, ref, &client)
        guard clientStatus == noErr else {
            sendBridgeStatus("CoreMIDI client failed: \(clientStatus)")
            return
        }

        let portStatus = MIDIInputPortCreate(client, "theDAW MIDI Input" as CFString, midiReadCallback, ref, &inputPort)
        guard portStatus == noErr else {
            sendBridgeStatus("CoreMIDI input failed: \(portStatus)")
            return
        }

        rescanSources()
    }

    func stop() {
        for source in connectedSources {
            MIDIPortDisconnectSource(inputPort, source)
        }
        connectedSources.removeAll()
        releaseSourceNameRefs()
        if inputPort != 0 {
            MIDIPortDispose(inputPort)
            inputPort = 0
        }
        if client != 0 {
            MIDIClientDispose(client)
            client = 0
        }
        started = false
    }

    func handleMidiNotification() {
        DispatchQueue.main.async { [weak self] in
            self?.rescanSources()
        }
    }

    func rescanSources() {
        guard started, inputPort != 0 else { return }

        for source in connectedSources {
            MIDIPortDisconnectSource(inputPort, source)
        }
        connectedSources.removeAll()
        releaseSourceNameRefs()

        let count = MIDIGetNumberOfSources()
        for index in 0..<count {
            let source = MIDIGetSource(index)
            guard source != 0 else { continue }
            let name = endpointName(source)
            let retainedName = Unmanaged.passRetained(name as NSString)
            let status = MIDIPortConnectSource(inputPort, source, retainedName.toOpaque())
            if status == noErr {
                connectedSources.insert(source)
                sourceNameRefs[source] = retainedName
            } else {
                retainedName.release()
            }
        }

        sendDeviceList()
    }

    func sendDeviceList() {
        let names = (0..<MIDIGetNumberOfSources()).compactMap { index -> String? in
            let source = MIDIGetSource(index)
            return source == 0 ? nil : endpointName(source)
        }
        sendEvent("thedaw:native-midi-devices", payload: ["inputs": names])
    }

    func handlePacketList(_ packetList: MIDIPacketList, inputName: String?) {
        var packet = packetList.packet
        for _ in 0..<packetList.numPackets {
            let bytes = withUnsafeBytes(of: packet.data) { raw in
                Array(raw.prefix(Int(packet.length))).map { Int($0) }
            }
            if !bytes.isEmpty {
                sendEvent("thedaw:native-midi", payload: ["data": bytes, "input": inputName ?? "MIDI Input"])
            }
            packet = MIDIPacketNext(&packet).pointee
        }
    }

    private func endpointName(_ endpoint: MIDIEndpointRef) -> String {
        var displayName: Unmanaged<CFString>?
        if MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &displayName) == noErr,
           let name = displayName?.takeRetainedValue() as String?,
           !name.isEmpty {
            return name
        }

        var nameRef: Unmanaged<CFString>?
        if MIDIObjectGetStringProperty(endpoint, kMIDIPropertyName, &nameRef) == noErr,
           let name = nameRef?.takeRetainedValue() as String?,
           !name.isEmpty {
            return name
        }

        return "MIDI Input"
    }

    private func sendBridgeStatus(_ message: String) {
        sendEvent("thedaw:native-midi-status", payload: ["message": message])
    }

    private func releaseSourceNameRefs() {
        for retainedName in sourceNameRefs.values {
            retainedName.release()
        }
        sourceNameRefs.removeAll()
    }

    private func sendEvent(_ name: String, payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }

        let script = "window.dispatchEvent(new CustomEvent('\(name)', { detail: \(json) }));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingLabel: NSTextField!
    private var serverProcess: Process?
    private var pollTimer: Timer?
    private var midiBridge: CoreMidiBridge?
    private var launchLog = ""

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
        midiBridge?.stop()
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
        let contentController = WKUserContentController()
        contentController.add(self, name: "nativeMidi")
        configuration.userContentController = contentController

        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        midiBridge = CoreMidiBridge(webView: webView)
        midiBridge?.start()

        loadingLabel = NSTextField(labelWithString: "Starting theDAW...")
        loadingLabel.alignment = .center
        loadingLabel.font = NSFont.systemFont(ofSize: 18, weight: .medium)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.lineBreakMode = .byWordWrapping
        loadingLabel.maximumNumberOfLines = 0
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
        guard let repoPath = resolveRepositoryPath() else {
            showLaunchError("Could not find the bundled StableDAW project.")
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
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.appendLaunchOutput(handle.availableData)
        }
        errorPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.appendLaunchOutput(handle.availableData)
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.pollTimer != nil else { return }
                self.showLaunchError("theDAW stopped during startup.\n\n\(self.launchLogTail())")
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showLaunchError("Could not start theDAW launcher: \(error.localizedDescription)")
        }
    }

    private func appendLaunchOutput(_ data: Data) {
        guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.launchLog += text
            if self.launchLog.count > 8000 {
                self.launchLog = String(self.launchLog.suffix(8000))
            }
        }
    }

    private func launchLogTail() -> String {
        let lines = launchLog
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(12)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return lines.isEmpty ? "No startup logs were captured." : lines
    }

    private func resolveRepositoryPath() -> String? {
        let fileManager = FileManager.default
        if let bundledRepo = Bundle.main.resourceURL?.appendingPathComponent("StableDAW").path,
           fileManager.fileExists(atPath: bundledRepo) {
            return bundledRepo
        }

        if let repoPath = Bundle.main.object(forInfoDictionaryKey: "StableDAWRepositoryPath") as? String,
           fileManager.fileExists(atPath: repoPath) {
            return repoPath
        }

        return nil
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        midiBridge?.sendDeviceList()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeMidi" else { return }
        midiBridge?.sendDeviceList()
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
