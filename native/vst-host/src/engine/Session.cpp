#include "Session.h"

#include <algorithm>
#include <cstring>

#include "../util/AtomicFile.h"
#include "../util/Base64.h"
#include "../util/Log.h"
#include "../util/SehGuard.h"
#include "../util/StringUtil.h"
#include "ChannelMap.h"

namespace thedaw {
namespace {

constexpr size_t kControlSlotReserve = 4096;
constexpr int kParkTimeoutMs = 4000;
// Connection markers in the control queue (never valid JSON, never accepted from the wire).
constexpr char kConnectionMarkerPrefix = '\x01';
constexpr const char* kMarkerConnected = "connected";
constexpr const char* kMarkerGone = "gone";
constexpr int kParamEchoIntervalMs = 33;  // <= 30 Hz per parameter
constexpr int kXrunIntervalMs = 1000;
// How long the audio thread waits for the next audio_in block before it delivers queued
// parameter changes itself. Short enough that a knob move with the transport stopped feels
// immediate, long enough that a streaming client never pays for it: at 48k/512 a block lands
// every ~10.7 ms, so a running stream keeps resetting the timer and no flush ever happens.
constexpr ULONGLONG kParamFlushIdleMs = 20;
constexpr double kBypassFadeSeconds = 0.010;

ULONGLONG nowMs() { return GetTickCount64(); }

const char* noticeText(AudioNoticeCode code) {
    switch (code) {
        case AudioNoticeCode::NotReady:
            return "audio block received before hello/ready";
        case AudioNoticeCode::ShortFrame:
            return "audio message is shorter than its header says";
        case AudioNoticeCode::BadMagic:
            return "audio message has the wrong magic";
        case AudioNoticeCode::BadType:
            return "audio message is not an audio_in frame";
        case AudioNoticeCode::BadChannels:
            return "audio message channel count is out of range (1..8)";
        case AudioNoticeCode::BadFrameCount:
            return "audio message frame count exceeds --block-size";
        case AudioNoticeCode::FrameTooLarge:
            return "audio message is larger than the negotiated block";
        case AudioNoticeCode::ProtocolViolation:
            return "websocket protocol violation";
        default:
            return "audio thread notice";
    }
}

}  // namespace

Session::Session() = default;

Session::~Session() {
    stop();
    for (HANDLE* handle : {&parkedEvent_, &resumeEvent_, &stopEvent_, &controlEvent_}) {
        if (*handle != nullptr) {
            CloseHandle(*handle);
            *handle = nullptr;
        }
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

bool Session::start(const Options& options, MessageLoop& loop, std::string& error,
                    int& exitCode) {
    options_ = options;
    loop_ = &loop;
    exitCode = 0;

    LARGE_INTEGER frequency{};
    QueryPerformanceFrequency(&frequency);
    qpcToMicros_ = frequency.QuadPart > 0 ? 1000000.0 / static_cast<double>(frequency.QuadPart)
                                          : 0.0;

    parkedEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    resumeEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    controlEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (parkedEvent_ == nullptr || resumeEvent_ == nullptr || stopEvent_ == nullptr ||
        controlEvent_ == nullptr) {
        error = "cannot create synchronisation events";
        exitCode = 6;
        return false;
    }

    // Reserve the queue payloads up front so the audio thread never grows one
    // for a normal control message.
    incoming_.forEachSlot([](std::string& slot) { slot.reserve(kControlSlotReserve); });
    outgoing_.forEachSlot([](std::string& slot) { slot.reserve(kControlSlotReserve); });

    // ---- plugin ----
    if (options_.nullPlugin) {
        plugin_ = createNullPlugin(this);
    } else {
        if (!util::fileExists(options_.pluginPath)) {
            error = "plugin file not found: " + util::wideToUtf8(options_.pluginPath);
            exitCode = 3;
            return false;
        }
        PluginLoadResult loaded =
            createVst3Plugin(util::wideToUtf8(options_.pluginPath), options_.pluginName,
                             options_.classId, this);
        startupWarnings_ = loaded.warnings;
        if (loaded.plugin == nullptr) {
            error = loaded.error.empty() ? "plugin failed to load" : loaded.error;
            exitCode = loaded.exitCodeHint != 0 ? loaded.exitCodeHint : 4;
            return false;
        }
        plugin_ = std::move(loaded.plugin);
    }

    PrepareConfig config;
    config.sampleRate = options_.sampleRate;
    config.maxBlockSize = options_.blockSize;
    config.requestedChannels = options_.channels;

    IPluginInstance* instance = plugin_.get();
    PrepareResult prepared;
    const unsigned long fault = util::guarded([&] { prepared = instance->prepare(config); });
    if (fault != 0) {
        error = "the plugin faulted during prepare (exception 0x" +
                util::toString(static_cast<long long>(fault)) + ")";
        exitCode = 4;
        return false;
    }
    if (!prepared.ok) {
        error = prepared.error.empty() ? "the plugin rejected the requested bus layout"
                                       : prepared.error;
        exitCode = 5;
        return false;
    }
    prepared_ = prepared;
    prepared_.channelsIn = std::clamp(prepared_.channelsIn, 1, kMaxWireChannels);
    prepared_.channelsOut = std::clamp(prepared_.channelsOut, 1, kMaxWireChannels);

    util::guarded([&] {
        pluginInfo_ = instance->info();
        hasEditor_ = instance->hasEditor();
        stateCompatible_ = instance->stateIsPedalboardCompatible();
    });

    // ---- preallocate every audio-thread buffer ----
    const size_t block = static_cast<size_t>(options_.blockSize);
    const size_t plane = static_cast<size_t>(kMaxWireChannels) * block;
    wireIn_.assign(plane, 0.0f);
    pluginIn_.assign(plane, 0.0f);
    pluginOut_.assign(plane, 0.0f);
    dryDelayed_.assign(plane, 0.0f);
    dryMapped_.assign(plane, 0.0f);
    wireOut_.assign(plane, 0.0f);
    for (int ch = 0; ch < kMaxWireChannels; ++ch) {
        const size_t offset = static_cast<size_t>(ch) * block;
        wireInPtr_[ch] = wireIn_.data() + offset;
        pluginInPtr_[ch] = pluginIn_.data() + offset;
        pluginOutPtr_[ch] = pluginOut_.data() + offset;
        dryDelayedPtr_[ch] = dryDelayed_.data() + offset;
        dryMappedPtr_[ch] = dryMapped_.data() + offset;
        wireOutPtr_[ch] = wireOut_.data() + offset;
    }
    txBuffer_.assign(16 + kAudioFrameHeaderSize + plane * sizeof(float), 0);

    bypassStep_ = 1.0f / std::max(1.0f, static_cast<float>(kBypassFadeSeconds *
                                                           options_.sampleRate));
    bypassDelay_.prepare(kMaxWireChannels, std::max(prepared_.latencySamples, 4096),
                         options_.blockSize);
    bypassDelay_.setDelay(std::max(prepared_.latencySamples, 0));

    // The reader needs room for the largest audio message plus slack for a
    // control message; anything bigger grows once, off the hot path.
    reader_.reserve(std::max<size_t>(1024 * 1024,
                                     kAudioFrameHeaderSize + plane * sizeof(float) + 1024));

    restoreStateFile();

    // ---- server ----
    std::string socketError;
    if (!winsock_.start(socketError)) {
        error = socketError;
        exitCode = 6;
        return false;
    }
    server_.setOnClientConnected(&Session::acceptorConnectedTrampoline, this);
    if (!server_.start(options_.port, socketError)) {
        error = socketError;
        exitCode = 6;
        return false;
    }

    loop.addEvent(controlEvent_, &Session::controlEventTrampoline, this);
    loop.setTick(&Session::tickTrampoline, this, 5);

    lastActivityMs_ = nowMs();
    ready_.store(false, std::memory_order_release);
    audioThread_ = std::thread([this] { audioLoop(); });

    util::log::writef("listening on 127.0.0.1:%d (plugin \"%s\", %d in / %d out, "
                      "latency %d, sample rate %.0f, block %d)",
                      server_.port(), pluginInfo_.name.c_str(), prepared_.channelsIn,
                      prepared_.channelsOut, prepared_.latencySamples, options_.sampleRate,
                      options_.blockSize);
    return true;
}

void Session::stop() {
    if (stopped_) return;
    stopped_ = true;

    // Order matters. The audio thread is the only caller of process(), so it is ended and
    // JOINED first; only then is the plugin touched. A park is not enough here: a park can
    // time out (a peer that stops reading stalls send()), and releasing the plugin under a
    // thread that may still be inside process() is a use-after-free. The join is bounded by
    // the socket timeouts (recv 2 ms, send kAudioSendTimeoutMs) and by the 100 ms park wait.
    stopping_.store(true, std::memory_order_release);
    if (stopEvent_ != nullptr) SetEvent(stopEvent_);
    resumeAudio();  // no-op unless an operation in flight had it parked
    if (audioThread_.joinable()) audioThread_.join();

    // Nothing can be inside process() from here on: close the editor -> capture state ->
    // write the state file -> release the plugin.
    if (plugin_ != nullptr) {
        IPluginInstance* instance = plugin_.get();
        if (editorOpen_) {
            util::guarded([instance] { instance->closeEditor(); });
            editorOpen_ = false;
        }
        writeStateFile();
        util::guarded([instance] { instance->release(); });
    }

    const SOCKET socket = clientSocket_.exchange(INVALID_SOCKET);
    if (socket != INVALID_SOCKET) server_.releaseClient(socket);
    server_.stop();

    plugin_.reset();
}

// ---------------------------------------------------------------------------
// Trampolines
// ---------------------------------------------------------------------------

void Session::controlEventTrampoline(void* context) {
    Session* self = static_cast<Session*>(context);
    self->drainControlQueue();
    self->drainAudioNotices();
}

void Session::tickTrampoline(void* context) { static_cast<Session*>(context)->tick(); }

void Session::acceptorConnectedTrampoline(void* context) {
    postToMessageThread(&Session::clientConnectedTrampoline, context);
}

void Session::clientConnectedTrampoline(void* context) {
    // Only the idle clock. The per-connection reset is NOT done here: this task is posted by
    // the acceptor thread and can run after the audio thread has already delivered the new
    // connection's `hello`, which would wipe helloSeen_/ready_ for good. The reset rides the
    // control queue instead (see queueConnectionMarker).
    static_cast<Session*>(context)->lastActivityMs_ = nowMs();
}

void Session::onClientConnected() {
    helloSeen_ = false;
    ready_.store(false, std::memory_order_release);
    bypassTarget_.store(false, std::memory_order_release);
    paramEchoes_.clear();
    lateBlocks_.store(0, std::memory_order_relaxed);
    maxProcessMicros_.store(0, std::memory_order_relaxed);
    lastActivityMs_ = nowMs();
}

void Session::onClientGone() {
    helloSeen_ = false;
    ready_.store(false, std::memory_order_release);
    lastActivityMs_ = nowMs();
    util::log::write("client disconnected");
}

// ---------------------------------------------------------------------------
// Message-thread pumps
// ---------------------------------------------------------------------------

void Session::drainControlQueue() {
    for (;;) {
        std::string* slot = incoming_.readSlot();
        if (slot == nullptr) return;
        // Copy out before commitRead so the audio thread cannot reuse the slot
        // while the handler still reads it.
        const std::string text = *slot;
        incoming_.commitRead();
        if (!text.empty() && text[0] == kConnectionMarkerPrefix) {
            handleConnectionMarker(text);
            continue;
        }
        handleControlText(text);
    }
}

void Session::handleConnectionMarker(const std::string& text) {
    if (text.compare(1, std::string::npos, kMarkerConnected) == 0) {
        onClientConnected();
    } else if (text.compare(1, std::string::npos, kMarkerGone) == 0) {
        onClientGone();
    }
}

void Session::drainAudioNotices() {
    AudioNotice notice;
    while (notices_.pop(notice)) {
        if (notice.code == AudioNoticeCode::ClientGone) {
            onClientGone();
            continue;
        }
        std::string text = noticeText(notice.code);
        if (notice.a != 0 || notice.b != 0) {
            text += " (" + util::toString(notice.a) + ", " + util::toString(notice.b) + ")";
        }
        sendError(text, false);
        util::log::writef("audio notice: %s", text.c_str());
    }
}

void Session::tick() {
    // The audio-note ring has exactly one consumer, and that is the logger
    // thread -- draining it here as well would break the SPSC invariant.
    flushParamEchoes(false);

    const ULONGLONG now = nowMs();

    if (paramSweepPending_ && now >= paramSweepAtMs_) {
        paramSweepPending_ = false;
        sweepParamsForClient();
    }

    // Work a timed-out park had to put off.
    if (restartRetryPending_) onRestartRequired();
    if (latencyRetryPending_) applyLatency(latencyRetrySamples_);

    // xrun: at most one event per second and only when nonzero. The counters are taken (and
    // zeroed) only when a report is due, so everything between two reports is in the report --
    // taking them on every tick threw away all but the last tick's worth.
    uint32_t late = 0;
    uint32_t worst = 0;
    if (now - lastXrunReportMs_ >= kXrunIntervalMs) {
        late = lateBlocks_.exchange(0, std::memory_order_relaxed);
        worst = maxProcessMicros_.exchange(0, std::memory_order_relaxed);
    }
    if (late > 0) {
        lastXrunReportMs_ = now;
        json::Writer writer;
        writer.beginObject()
            .strField("ev", "xrun")
            .intField("late_blocks", late)
            .numField("max_process_ms", static_cast<double>(worst) / 1000.0)
            .endObject();
        sendText(writer.take());
    }

    if (options_.idleTimeoutSec > 0 && !server_.hasClient() && !editorOpen_) {
        const ULONGLONG idleMs = now - lastActivityMs_;
        if (idleMs >= static_cast<ULONGLONG>(options_.idleTimeoutSec) * 1000ull) {
            util::log::writef("idle for %llu ms with no client; exiting", idleMs);
            postHostQuit(0);
        }
    }
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

void Session::handleControlText(const std::string& text) {
    lastActivityMs_ = nowMs();

    json::Value message;
    std::string parseError;
    if (!json::parse(text, message, parseError)) {
        sendError("malformed control message: " + parseError, false);
        return;
    }
    if (!message.isObject()) {
        sendError("control message must be a JSON object", false);
        return;
    }
    const std::string op = message.stringOr("op", "");
    if (op.empty()) {
        sendError("control message has no \"op\"", false);
        return;
    }
    if (op != "hello" && !helloSeen_) {
        sendError("\"hello\" must be the first message", false);
        return;
    }
    handleOp(message, op);
}

void Session::handleOp(const json::Value& message, const std::string& op) {
    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr) {
        sendError("the plugin has already been released", true);
        return;
    }

    if (op == "hello") {
        const double protocol = message.numberOr("protocol", 0);
        if (protocol != 1) {
            sendError("unsupported protocol version; this host speaks protocol 1", true);
            return;
        }
        helloSeen_ = true;
        sendReady();
        ready_.store(true, std::memory_order_release);
        return;
    }

    if (op == "ping") {
        const json::Value* token = message.find("t");
        json::Writer writer;
        writer.beginObject().strField("ev", "pong").key("t");
        if (token != nullptr && token->isNumber()) {
            writer.valueNumber(token->number);
        } else if (token != nullptr && token->isString()) {
            writer.valueString(token->str);
        } else {
            writer.valueNull();
        }
        writer.endObject();
        sendText(writer.take());
        return;
    }

    if (op == "get_params") {
        sendParams();
        return;
    }

    if (op == "param_text") {
        // The plugin's own words for a value, for a parameter UI that is dragging a slider.
        const json::Value* indexValue = message.find("index");
        const json::Value* valueValue = message.find("value");
        if (indexValue == nullptr || !indexValue->isNumber() || valueValue == nullptr ||
            !valueValue->isNumber()) {
            sendError("param_text needs a numeric \"index\" and \"value\"", false);
            return;
        }
        const int32_t index = static_cast<int32_t>(indexValue->number);
        const double value = std::clamp(valueValue->number, 0.0, 1.0);
        std::string text;
        const unsigned long fault = util::guarded([&] { text = instance->paramText(index, value); });
        if (fault != 0) {
            reportPluginFault("the plugin faulted while formatting a parameter value");
            return;
        }
        json::Writer writer;
        writer.beginObject()
            .strField("ev", "param_text")
            .intField("index", index)
            .numField("value", value)
            .strField("text", text)
            .endObject();
        sendText(writer.take());
        return;
    }

    if (op == "set_param") {
        const json::Value* indexValue = message.find("index");
        const json::Value* nameValue = message.find("name");
        const json::Value* valueValue = message.find("value");
        if (valueValue == nullptr || !valueValue->isNumber()) {
            sendError("set_param needs a numeric \"value\"", false);
            return;
        }
        int32_t index = -1;
        if (indexValue != nullptr && indexValue->isNumber()) {
            index = static_cast<int32_t>(indexValue->number);
        } else if (nameValue != nullptr && nameValue->isString()) {
            std::vector<ParamInfo> list;
            util::guarded([&] { list = instance->params(); });
            for (const ParamInfo& info : list) {
                if (info.name == nameValue->str) {
                    index = info.index;
                    break;
                }
            }
            if (index < 0) {
                sendError("set_param: no parameter named \"" + nameValue->str + "\"", false);
                return;
            }
        } else {
            sendError("set_param needs \"index\" or \"name\"", false);
            return;
        }
        const double value = std::clamp(valueValue->number, 0.0, 1.0);
        util::guarded([&] { instance->setParamNormalized(index, value); });
        if (index >= 0 && static_cast<size_t>(index) < clientKnownParams_.size()) {
            clientKnownParams_[static_cast<size_t>(index)] = value;
        }
        // A program change or a macro moves OTHER parameters inside the plugin, and plugins are
        // not obliged to announce those one by one. Look once the dust has settled.
        if (!clientKnownParams_.empty()) {
            paramSweepPending_ = true;
            paramSweepAtMs_ = nowMs() + 120;
        }
        // The edit is in the plugin's queue now; a VST3 plugin only reads that queue inside a
        // process call. Arm the audio thread's flush so the change lands even if the client
        // never sends another audio block.
        paramFlushPending_.store(true, std::memory_order_release);
        return;
    }

    if (op == "midi") {
        // {"op":"midi","events":[{"pos":<timeline sample frames, -1 = now>,"data":[s,d1,d2]}...]}
        const json::Value* events = message.find("events");
        if (events == nullptr || !events->isArray()) {
            sendError("midi needs an \"events\" array", false);
            return;
        }
        size_t refused = 0;
        for (const json::Value& event : events->array) {
            const json::Value* pos = event.find("pos");
            const json::Value* data = event.find("data");
            uint8_t bytes[3] = {0, 0, 0};
            int32_t size = 0;
            bool ok = pos != nullptr && pos->isNumber() && data != nullptr && data->isArray() &&
                      !data->array.empty() && data->array.size() <= 3;
            if (ok) {
                for (const json::Value& b : data->array) {
                    if (!b.isNumber() || b.number < 0 || b.number > 255 ||
                        b.number != static_cast<double>(static_cast<int>(b.number))) {
                        ok = false;
                        break;
                    }
                    bytes[size++] = static_cast<uint8_t>(b.number);
                }
            }
            const double position = ok ? (pos->number < 0 ? -1.0 : pos->number) : 0.0;
            if (!ok || !midi_->push(position, bytes, size)) ++refused;
        }
        if (refused > 0) {
            sendWarningMessage("midi: " + std::to_string(refused) +
                               " message(s) were not channel voice messages or did not fit, and were dropped");
        }
        return;
    }

    if (op == "midi_panic") {
        // A stop, seek or loop wrap: drop what is waiting and release every note still sounding.
        if (!midi_->pushPanic()) sendWarningMessage("midi_panic: the MIDI queue is full");
        return;
    }

    if (op == "get_state") {
        sendStateMessage();
        return;
    }

    if (op == "set_state") {
        const std::string encoded = message.stringOr("state_b64", "");
        if (encoded.empty()) {
            sendError("set_state needs \"state_b64\"", false);
            return;
        }
        std::vector<uint8_t> blob;
        if (!util::base64Decode(encoded, blob)) {
            sendError("set_state: \"state_b64\" is not valid base64", false);
            return;
        }
        if (blob.empty()) {
            sendError("set_state: decoded state is empty", false);
            return;
        }
        std::string stateError;
        bool ok = false;
        unsigned long fault = 0;
        {
            ParkGuard park(*this);
            if (!park.quiet()) {
                sendError("set_state: the plugin is busy (audio did not pause in time); try again",
                          false);
                return;
            }
            fault = util::guarded(
                [&] { ok = instance->setState(blob.data(), blob.size(), stateError); });
        }
        if (fault != 0) {
            reportPluginFault("the plugin faulted while restoring state");
            return;
        }
        if (!ok) {
            sendError(stateError.empty() ? "the plugin rejected the state blob" : stateError,
                      false);
            return;
        }
        return;
    }

    if (op == "bypass") {
        const bool on = message.boolOr("on", false);
        bypassTarget_.store(on, std::memory_order_release);
        util::log::writef("bypass %s", on ? "on" : "off");
        return;
    }

    if (op == "open_editor") {
        if (!hasEditor_) {
            sendError("this plugin has no editor", false);
            sendEditorState(false, 0, 0);
            return;
        }
        uint64_t parent = 0;
        const json::Value* parentValue = message.find("parent_hwnd");
        if (parentValue != nullptr && parentValue->isString()) {
            long long parsed = 0;
            if (util::parseInt(parentValue->str, parsed) && parsed > 0) {
                parent = static_cast<uint64_t>(parsed);
            }
        } else if (parentValue != nullptr && parentValue->isNumber()) {
            parent = static_cast<uint64_t>(parentValue->number);
        }
        const int x = static_cast<int>(message.numberOr("x", 0));
        const int y = static_cast<int>(message.numberOr("y", 0));
        const int w = static_cast<int>(message.numberOr("w", 0));
        const int h = static_cast<int>(message.numberOr("h", 0));
        const std::string title = message.stringOr("title", pluginInfo_.name);
        std::string editorError;
        bool opened = false;
        const unsigned long fault = util::guarded(
            [&] { opened = instance->openEditor(parent, x, y, w, h, title, editorError); });
        if (fault != 0) {
            reportPluginFault("the plugin faulted while opening its editor");
            return;
        }
        if (!opened) {
            sendError(editorError.empty() ? "the editor could not be opened" : editorError,
                      false);
            sendEditorState(false, 0, 0);
            return;
        }
        editorOpen_ = true;
        // The view reported its real size while it opened (onEditorResized). Repeating the
        // requested box here told the client the plugin was as large as the box it asked for.
        sendEditorState(true, editorWidth_ > 0 ? editorWidth_ : w,
                        editorHeight_ > 0 ? editorHeight_ : h);
        return;
    }

    if (op == "editor_rect") {
        const int x = static_cast<int>(message.numberOr("x", 0));
        const int y = static_cast<int>(message.numberOr("y", 0));
        const int w = static_cast<int>(message.numberOr("w", 0));
        const int h = static_cast<int>(message.numberOr("h", 0));
        util::guarded([&] { instance->setEditorRect(x, y, w, h); });
        return;
    }

    if (op == "close_editor") {
        util::guarded([instance] { instance->closeEditor(); });
        editorOpen_ = false;
        editorWidth_ = 0;
        editorHeight_ = 0;
        sendEditorState(false, 0, 0);
        return;
    }

    if (op == "shutdown") {
        util::log::write("shutdown requested by the client");
        postHostQuit(0);
        return;
    }

    sendError("unknown op \"" + op + "\"", false);
}

// ---------------------------------------------------------------------------
// Outgoing messages
// ---------------------------------------------------------------------------

void Session::sendText(std::string text) {
    if (!server_.hasClient()) return;
    for (int attempt = 0; attempt < 200; ++attempt) {
        std::string* slot = outgoing_.writeSlot();
        if (slot != nullptr) {
            *slot = std::move(text);
            outgoing_.commitWrite();
            return;
        }
        Sleep(1);  // message thread only; the audio thread drains every ~2 ms
    }
    util::log::write("dropping an outgoing message: the send queue stayed full");
}

void Session::sendReady() {
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "ready")
        .intField("protocol", 1)
        .key("plugin")
        .beginObject()
        .strField("name", pluginInfo_.name)
        .strField("vendor", pluginInfo_.vendor)
        .strField("version", pluginInfo_.version)
        .strField("category", pluginInfo_.category)
        .strField("identifier", pluginInfo_.identifier)
        .strField("format", pluginInfo_.format)
        .endObject()
        .intField("latency_samples", prepared_.latencySamples)
        .numField("tail_seconds", prepared_.tailSeconds)
        .numField("sample_rate", options_.sampleRate)
        .intField("block_size", options_.blockSize)
        .intField("channels_in", prepared_.channelsIn)
        .intField("channels_out", prepared_.channelsOut)
        .boolField("has_editor", hasEditor_)
        .boolField("state_compat", stateCompatible_)
        // This host takes the `midi` and `midi_panic` ops: a client asks before it sends notes.
        .boolField("accepts_midi", true)
        .key("warnings")
        .beginArray();
    for (const std::string& warning : startupWarnings_) writer.valueString(warning);
    for (const std::string& warning : prepared_.warnings) writer.valueString(warning);
    writer.endArray().endObject();
    sendText(writer.take());
}

void Session::sendParams() {
    IPluginInstance* instance = plugin_.get();
    std::vector<ParamInfo> list;
    const unsigned long fault = util::guarded([&] { list = instance->params(); });
    if (fault != 0) {
        reportPluginFault("the plugin faulted while listing parameters");
        return;
    }
    clientKnownParams_.assign(list.size(), 0.0);
    for (size_t i = 0; i < list.size(); ++i) clientKnownParams_[i] = list[i].value;
    json::Writer writer;
    writer.beginObject().strField("ev", "params").key("list").beginArray();
    for (const ParamInfo& info : list) {
        writer.beginObject()
            .intField("index", info.index)
            .strField("name", info.name)
            .strField("label", info.label)
            .numField("default", info.defaultValue)
            .numField("value", info.value)
            .intField("steps", info.steps)
            .boolField("automatable", info.automatable)
            .boolField("discrete", info.discrete)
            .boolField("boolean", info.boolean_)
            .boolField("hidden", info.hidden)
            .boolField("read_only", info.readOnly)
            .boolField("bypass", info.isBypass)
            .boolField("program_change", info.isProgramChange)
            .strField("text", info.text)
            .endObject();
    }
    writer.endArray().endObject();
    sendText(writer.take());
}

void Session::sendStateMessage() {
    std::vector<uint8_t> blob;
    std::string stateError;
    if (!captureState(blob, stateError)) {
        sendError(stateError, false);
        return;
    }
    // The contract refreshes the state file on every get_state. The file is
    // written BEFORE the reply goes out, so a client that reacts to `state` by
    // shutting the host down (which the backend's DELETE /session does) always
    // finds the new bytes already on disk.
    if (!options_.stateFile.empty()) {
        std::string writeError;
        if (!util::writeFileAtomic(options_.stateFile, blob.data(), blob.size(),
                                   writeError)) {
            util::log::writef("state file write failed: %s", writeError.c_str());
        }
    }
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "state")
        .strField("state_b64", util::base64Encode(blob.data(), blob.size()))
        .endObject();
    sendText(writer.take());
}

void Session::sendError(const std::string& text, bool fatal) {
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "error")
        .strField("text", text)
        .boolField("fatal", fatal)
        .endObject();
    sendText(writer.take());
    util::log::writef("error (%s): %s", fatal ? "fatal" : "recoverable", text.c_str());
}

void Session::reportPluginFault(const std::string& text) {
    sendError(text, true);
    // Give the audio thread its ~2 ms window to push the message out before the
    // loop tears the session down.
    Sleep(20);
    postHostQuit(4);
}

void Session::sendWarningMessage(const std::string& text) {
    json::Writer writer;
    writer.beginObject().strField("ev", "warning").strField("text", text).endObject();
    sendText(writer.take());
}

void Session::sendEditorState(bool open, int width, int height) {
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "editor")
        .boolField("open", open)
        .intField("w", width)
        .intField("h", height)
        .endObject();
    sendText(writer.take());
}

void Session::flushParamEchoes(bool force) {
    if (paramEchoes_.empty()) return;
    const ULONGLONG now = nowMs();
    for (auto& entry : paramEchoes_) {
        ParamEcho& echo = entry.second;
        if (!echo.pending) continue;
        if (!force && now - echo.lastSentMs < static_cast<ULONGLONG>(kParamEchoIntervalMs)) {
            continue;
        }
        echo.pending = false;
        echo.lastSentMs = now;
        if (entry.first >= 0 && static_cast<size_t>(entry.first) < clientKnownParams_.size()) {
            clientKnownParams_[static_cast<size_t>(entry.first)] = echo.value;
        }
        // With the plugin's own words for the value, so a parameter UI never formats one itself.
        std::string text;
        if (IPluginInstance* instance = plugin_.get()) {
            util::guarded([&] { text = instance->paramText(entry.first, echo.value); });
        }
        json::Writer writer;
        writer.beginObject()
            .strField("ev", "param")
            .intField("index", entry.first)
            .numField("value", echo.value)
            .strField("text", text)
            .endObject();
        sendText(writer.take());
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

bool Session::captureState(std::vector<uint8_t>& out, std::string& error) {
    out.clear();
    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr) {
        error = "no plugin instance";
        return false;
    }
    bool ok = false;
    std::string stateError;
    unsigned long fault = 0;
    {
        ParkGuard park(*this);
        if (!park.quiet()) {
            error = "the plugin is busy (audio did not pause in time); try again";
            out.clear();
            return false;
        }
        fault = util::guarded([&] { ok = instance->getState(out, stateError); });
    }
    if (fault != 0) {
        error = "the plugin faulted while saving state";
        out.clear();
        return false;
    }
    if (!ok) {
        error = stateError.empty() ? "the plugin could not save its state" : stateError;
        out.clear();
        return false;
    }
    return true;
}

bool Session::writeStateFile() {
    if (options_.stateFile.empty()) return true;
    std::vector<uint8_t> blob;
    std::string error;
    if (!captureState(blob, error)) {
        util::log::writef("state capture failed: %s", error.c_str());
        return false;
    }
    if (blob.empty()) {
        util::log::write("state capture produced no bytes; leaving the state file alone");
        return false;
    }
    if (!util::writeFileAtomic(options_.stateFile, blob.data(), blob.size(), error)) {
        util::log::writef("state file write failed: %s", error.c_str());
        return false;
    }
    util::log::writef("wrote %zu state bytes", blob.size());
    return true;
}

void Session::restoreStateFile() {
    if (options_.stateFile.empty() || !util::fileExists(options_.stateFile)) return;
    std::vector<uint8_t> blob;
    std::string error;
    if (!util::readFile(options_.stateFile, blob, error)) {
        startupWarnings_.push_back("could not read the state file: " + error);
        return;
    }
    if (blob.empty()) return;
    IPluginInstance* instance = plugin_.get();
    bool ok = false;
    std::string stateError;
    const unsigned long fault =
        util::guarded([&] { ok = instance->setState(blob.data(), blob.size(), stateError); });
    if (fault != 0) {
        startupWarnings_.push_back("the plugin faulted while restoring the state file");
        return;
    }
    if (!ok) {
        startupWarnings_.push_back(
            "the state file was not restored: " +
            (stateError.empty() ? std::string("the plugin rejected it") : stateError));
        return;
    }
    util::log::writef("restored %zu state bytes", blob.size());
}

// ---------------------------------------------------------------------------
// Plugin callbacks (message thread)
// ---------------------------------------------------------------------------

void Session::applyLatency(int32_t latencySamples) {
    const int32_t latency = std::max(latencySamples, 0);
    // The delay line is read by the audio thread every block, so every change
    // to it -- length or buffer -- happens with audio parked.
    ParkGuard park(*this);
    if (!park.quiet()) {
        // The delay line belongs to the audio thread until a park succeeds; tick() retries.
        latencyRetryPending_ = true;
        latencyRetrySamples_ = latency;
        util::log::write("latency change deferred: audio did not pause in time");
        return;
    }
    latencyRetryPending_ = false;
    prepared_.latencySamples = latency;
    if (!bypassDelay_.setDelay(latency)) {
        bypassDelay_.prepare(kMaxWireChannels, latency + 4096, options_.blockSize);
        bypassDelay_.setDelay(latency);
    }
}

void Session::onLatencyChanged(int32_t latencySamples) {
    applyLatency(latencySamples);
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "latency")
        .intField("latency_samples", prepared_.latencySamples)
        .endObject();
    sendText(writer.take());
    util::log::writef("latency changed to %d samples", prepared_.latencySamples);
}

void Session::onParamEdited(int32_t index, double normalizedValue) {
    ParamEcho& echo = paramEchoes_[index];
    echo.value = normalizedValue;
    echo.pending = true;
    flushParamEchoes(false);
}

void Session::sweepParamsForClient() {
    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr || clientKnownParams_.empty()) return;
    std::vector<double> values;
    const unsigned long fault = util::guarded([&] { instance->paramValues(values); });
    if (fault != 0) return;
    const size_t count = std::min(values.size(), clientKnownParams_.size());
    bool any = false;
    for (size_t i = 0; i < count; ++i) {
        const double difference = values[i] - clientKnownParams_[i];
        if (difference > 1e-9 || difference < -1e-9) {
            ParamEcho& echo = paramEchoes_[static_cast<int32_t>(i)];
            echo.value = values[i];
            echo.pending = true;
            any = true;
        }
    }
    if (any) flushParamEchoes(true);
}

void Session::onParamGesture(int32_t index, bool begin) {
    // The end of a gesture goes out AFTER the last value of it: the echo is rate-limited, so
    // whatever is still pending is flushed first.
    if (!begin) flushParamEchoes(true);
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "param_gesture")
        .intField("index", index)
        .boolField("begin", begin)
        .endObject();
    sendText(writer.take());
}

void Session::onEditorResized(int32_t width, int32_t height) {
    editorWidth_ = static_cast<int>(width);
    editorHeight_ = static_cast<int>(height);
    sendEditorState(true, width, height);
}

void Session::onEditorClosed() {
    editorOpen_ = false;
    editorWidth_ = 0;
    editorHeight_ = 0;
    sendEditorState(false, 0, 0);
}

void Session::onWarning(const std::string& text) {
    sendWarningMessage(text);
    util::log::writef("plugin warning: %s", text.c_str());
}

void Session::onRestartRequired() {
    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr) return;
    PrepareResult result;
    unsigned long fault = 0;
    {
        ParkGuard park(*this);
        if (!park.quiet()) {
            // Re-preparing under a running process() would tear the plugin apart; tick() retries.
            restartRetryPending_ = true;
            util::log::write("plugin restart deferred: audio did not pause in time");
            return;
        }
        restartRetryPending_ = false;
        fault = util::guarded([&] { result = instance->reprepare(); });
        if (fault == 0 && result.ok) {
            prepared_ = result;
            prepared_.channelsIn = std::clamp(prepared_.channelsIn, 1, kMaxWireChannels);
            prepared_.channelsOut = std::clamp(prepared_.channelsOut, 1, kMaxWireChannels);
        }
    }

    if (fault != 0) {
        reportPluginFault("the plugin faulted while restarting");
        return;
    }
    if (!result.ok) {
        reportPluginFault(result.error.empty() ? "the plugin could not restart"
                                              : result.error);
        return;
    }
    for (const std::string& warning : result.warnings) sendWarningMessage(warning);
    applyLatency(prepared_.latencySamples);
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "latency")
        .intField("latency_samples", prepared_.latencySamples)
        .endObject();
    sendText(writer.take());
}

// ---------------------------------------------------------------------------
// Park handshake
// ---------------------------------------------------------------------------

bool Session::parkAudio() {
    if (parked_) return false;  // already parked by an outer operation
    if (!audioThread_.joinable()) return false;
    const ULONGLONG started = nowMs();
    // Clear both events: a previous park that timed out may have left one
    // signalled, which would make this handshake return without a parked thread.
    ResetEvent(parkedEvent_);
    ResetEvent(resumeEvent_);
    parkRequest_.store(true, std::memory_order_release);
    const DWORD result = WaitForSingleObject(parkedEvent_, kParkTimeoutMs);
    if (result != WAIT_OBJECT_0) {
        parkRequest_.store(false, std::memory_order_release);
        util::log::write("audio thread did not park in time; continuing unparked");
        return false;
    }
    parked_ = true;
    const ULONGLONG waited = nowMs() - started;
    if (waited > 5) util::log::writef("audio parked after %llu ms", waited);
    return true;
}

Session::ParkGuard::ParkGuard(Session& session) : session_(session) {
    if (session_.parked_ || !session_.audioThread_.joinable()) {
        quiet_ = true;  // an outer guard holds the park, or there is no audio thread
        return;
    }
    parkedHere_ = session_.parkAudio();
    quiet_ = parkedHere_;
}

Session::ParkGuard::~ParkGuard() {
    if (parkedHere_) session_.resumeAudio();
}

void Session::resumeAudio() {
    if (!parked_) return;
    parked_ = false;
    parkRequest_.store(false, std::memory_order_release);
    SetEvent(resumeEvent_);
}

// ---------------------------------------------------------------------------
// Audio thread
// ---------------------------------------------------------------------------

void Session::pushNotice(AudioNoticeCode code, uint32_t a, uint32_t b) {
    AudioNotice notice{code, a, b};
    if (notices_.push(notice)) SetEvent(controlEvent_);
}

void Session::drainOutgoing() {
    for (;;) {
        std::string* slot = outgoing_.readSlot();
        if (slot == nullptr) return;
        const bool sent = sendFrame(net::Opcode::Text,
                                    reinterpret_cast<const uint8_t*>(slot->data()),
                                    slot->size());
        slot->clear();  // keeps the reserved capacity for the producer
        outgoing_.commitRead();
        if (!sent) {
            dropClient();
            return;
        }
    }
}

bool Session::sendFrame(net::Opcode opcode, const uint8_t* payload, size_t size) {
    const SOCKET socket = clientSocket_.load(std::memory_order_acquire);
    if (socket == INVALID_SOCKET) return false;
    uint8_t header[10];
    const size_t headerSize = net::writeFrameHeader(header, opcode, true, size);
    if (!net::sendAll(socket, header, headerSize)) return false;
    if (size > 0 && !net::sendAll(socket, payload, size)) return false;
    return true;
}

void Session::dropClient() {
    const SOCKET socket = clientSocket_.exchange(INVALID_SOCKET);
    if (socket == INVALID_SOCKET) return;
    server_.releaseClient(socket);
    reader_.reset();
    bypassGain_ = 0.0f;
    bypassDelay_.clear();
    // Anything still queued belongs to the connection that just ended.
    for (;;) {
        std::string* stale = outgoing_.readSlot();
        if (stale == nullptr) break;
        stale->clear();
        outgoing_.commitRead();
    }
    // In order with the connection's messages; the notice is only the fallback for a full queue.
    if (!queueConnectionMarker(kMarkerGone)) pushNotice(AudioNoticeCode::ClientGone);
    util::log::audioNote("client dropped");
}

bool Session::queueConnectionMarker(const char* marker) {
    std::string* slot = incoming_.writeSlot();
    if (slot == nullptr) return false;
    slot->assign(1, kConnectionMarkerPrefix);
    slot->append(marker);
    incoming_.commitWrite();
    SetEvent(controlEvent_);
    return true;
}

bool Session::handleSocketMessage(const net::FrameReader::Message& message) {
    switch (message.opcode) {
        case net::Opcode::Binary:
            handleAudioBlock(message.data, message.size);
            return true;
        case net::Opcode::Text: {
            // The marker prefix is ours alone; control text is JSON and never starts with it.
            if (message.size > 0 && static_cast<char>(message.data[0]) == kConnectionMarkerPrefix) {
                util::log::audioNote("control text with a reserved prefix ignored");
                return true;
            }
            std::string* slot = incoming_.writeSlot();
            if (slot == nullptr) {
                util::log::audioNote("control queue full; message dropped");
                return true;
            }
            slot->assign(reinterpret_cast<const char*>(message.data), message.size);
            incoming_.commitWrite();
            SetEvent(controlEvent_);
            return true;
        }
        case net::Opcode::Ping:
            if (!sendFrame(net::Opcode::Pong, message.data, message.size)) {
                dropClient();
                return false;
            }
            return true;
        case net::Opcode::Pong:
            return true;
        case net::Opcode::Close:
            sendFrame(net::Opcode::Close, message.data, message.size);
            dropClient();
            return false;
        default:
            return true;
    }
}

void Session::handleAudioBlock(const uint8_t* data, size_t size) {
    if (!ready_.load(std::memory_order_acquire)) {
        pushNotice(AudioNoticeCode::NotReady);
        return;
    }
    AudioFrameHeader header;
    if (!readAudioFrameHeader(data, size, header)) {
        pushNotice(AudioNoticeCode::ShortFrame, static_cast<uint32_t>(size));
        return;
    }
    if (header.magic != kFrameMagic) {
        pushNotice(AudioNoticeCode::BadMagic, header.magic);
        return;
    }
    if (header.type != kFrameTypeAudioIn) {
        pushNotice(AudioNoticeCode::BadType, header.type);
        return;
    }
    const int wireChannels = static_cast<int>(header.channels);
    if (wireChannels < 1 || wireChannels > kMaxWireChannels) {
        pushNotice(AudioNoticeCode::BadChannels, header.channels);
        return;
    }
    const int frames = static_cast<int>(header.frames);
    if (frames < 0 || frames > options_.blockSize) {
        pushNotice(AudioNoticeCode::BadFrameCount, header.frames,
                   static_cast<uint32_t>(options_.blockSize));
        return;
    }
    const size_t expected = kAudioFrameHeaderSize +
                            static_cast<size_t>(wireChannels) * static_cast<size_t>(frames) *
                                sizeof(float);
    if (size != expected) {
        pushNotice(size < expected ? AudioNoticeCode::ShortFrame
                                   : AudioNoticeCode::FrameTooLarge,
                   static_cast<uint32_t>(size), static_cast<uint32_t>(expected));
        return;
    }

    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr) return;

    const size_t planeBytes = static_cast<size_t>(frames) * sizeof(float);
    for (int ch = 0; ch < wireChannels; ++ch) {
        std::memcpy(wireInPtr_[ch], data + kAudioFrameHeaderSize + planeBytes * ch,
                    planeBytes);
    }

    const int channelsIn = prepared_.channelsIn;
    const int channelsOut = prepared_.channelsOut;
    mapChannels(wireInPtr_, wireChannels, pluginInPtr_, channelsIn, frames);

    TransportInfo transport;
    transport.playing = (header.flags & kFlagPlaying) != 0;
    transport.discontinuity = (header.flags & kFlagDiscontinuity) != 0;
    transport.positionSamples = header.positionSamples;
    transport.tempoBpm = header.tempoBpm;

    if (transport.discontinuity) {
        instance->resetDsp();
        bypassDelay_.clear();
    }

    // The client's MIDI for this block, at the offsets its timeline positions put it on.
    const int32_t midiCount =
        midi_->collect(header.positionSamples, frames, blockMidi_, MidiQueue::kMaxPerBlock);
    instance->setBlockMidi(blockMidi_, midiCount);

    LARGE_INTEGER start{};
    LARGE_INTEGER finish{};
    QueryPerformanceCounter(&start);
    instance->process(pluginInPtr_, pluginOutPtr_, frames, transport);
    QueryPerformanceCounter(&finish);
    // This block already carried whatever was queued, which is what holds the flush off while
    // audio is streaming. The pending flag is NOT cleared here: an edit queued between that
    // drain and this line would be lost. It is cleared by the flush itself, which costs nothing
    // when the plugin's queue is already empty.
    lastAudioBlockMs_ = nowMs();

    // Dry path stays aligned with the plugin's latency even when not bypassed,
    // so toggling bypass never jumps the signal.
    bypassDelay_.process(pluginInPtr_, dryDelayedPtr_, channelsIn, frames);
    mapChannels(dryDelayedPtr_, channelsIn, dryMappedPtr_, channelsOut, frames);

    const float target = bypassTarget_.load(std::memory_order_acquire) ? 1.0f : 0.0f;
    if (bypassGain_ == target) {
        if (target == 1.0f) {
            for (int ch = 0; ch < channelsOut; ++ch) {
                std::memcpy(pluginOutPtr_[ch], dryMappedPtr_[ch], planeBytes);
            }
        }
        // target == 0: pluginOut_ already holds the wet signal.
    } else {
        float gain = bypassGain_;
        for (int i = 0; i < frames; ++i) {
            if (gain < target) {
                gain = std::min(target, gain + bypassStep_);
            } else if (gain > target) {
                gain = std::max(target, gain - bypassStep_);
            }
            for (int ch = 0; ch < channelsOut; ++ch) {
                const float wet = pluginOutPtr_[ch][i];
                const float dry = dryMappedPtr_[ch][i];
                // wet + g*(dry - wet) is exact at both ends and whenever the
                // plugin is a passthrough (dry == wet), which the tests rely on.
                pluginOutPtr_[ch][i] = wet + gain * (dry - wet);
            }
        }
        bypassGain_ = gain;
    }

    mapChannels(pluginOutPtr_, channelsOut, wireOutPtr_, wireChannels, frames);

    AudioFrameHeader outHeader;
    outHeader.magic = kFrameMagic;
    outHeader.type = kFrameTypeAudioOut;
    outHeader.channels = static_cast<uint8_t>(wireChannels);
    outHeader.flags = 0;  // reserved on the host -> client direction
    outHeader.seq = header.seq;
    outHeader.frames = header.frames;
    outHeader.positionSamples = header.positionSamples;
    outHeader.tempoBpm = header.tempoBpm;

    const size_t payloadSize = kAudioFrameHeaderSize +
                               static_cast<size_t>(wireChannels) * planeBytes;
    uint8_t* payload = txBuffer_.data();
    writeAudioFrameHeader(payload, outHeader);
    for (int ch = 0; ch < wireChannels; ++ch) {
        std::memcpy(payload + kAudioFrameHeaderSize + planeBytes * ch, wireOutPtr_[ch],
                    planeBytes);
    }
    if (!sendFrame(net::Opcode::Binary, payload, payloadSize)) {
        dropClient();
        return;
    }

    if (qpcToMicros_ > 0.0 && frames > 0) {
        const double micros =
            static_cast<double>(finish.QuadPart - start.QuadPart) * qpcToMicros_;
        const double budget = static_cast<double>(frames) / options_.sampleRate * 1e6;
        const uint32_t rounded = static_cast<uint32_t>(micros < 0 ? 0 : micros);
        uint32_t worst = maxProcessMicros_.load(std::memory_order_relaxed);
        while (rounded > worst &&
               !maxProcessMicros_.compare_exchange_weak(worst, rounded,
                                                        std::memory_order_relaxed)) {
        }
        if (micros > budget) {
            lateBlocks_.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

void Session::maybeFlushParameters() {
    if (!paramFlushPending_.load(std::memory_order_acquire)) return;
    if (!ready_.load(std::memory_order_acquire)) return;
    // A block that landed less than kParamFlushIdleMs ago already carried the edits (or is
    // about to): leave the flush to the stream. lastAudioBlockMs_ == 0 means no block ever
    // arrived, which is exactly the case this exists for.
    const ULONGLONG now = nowMs();
    if (lastAudioBlockMs_ != 0 && now - lastAudioBlockMs_ < kParamFlushIdleMs) return;

    // Cleared BEFORE the call so an edit queued while the plugin is running re-arms us.
    paramFlushPending_.store(false, std::memory_order_release);
    IPluginInstance* instance = plugin_.get();
    if (instance == nullptr) return;
    instance->flushParameters();
}

void Session::audioLoop() {
    util::setThreadTag("audio");

    // MMCSS "Pro Audio", loaded dynamically so a missing avrt.dll degrades to a
    // plain priority bump instead of failing to start.
    HMODULE avrt = LoadLibraryW(L"avrt.dll");
    HANDLE mmcssTask = nullptr;
    using SetCharacteristicsFn = HANDLE(WINAPI*)(LPCWSTR, LPDWORD);
    using SetPriorityFn = BOOL(WINAPI*)(HANDLE, int);
    using RevertFn = BOOL(WINAPI*)(HANDLE);
    RevertFn revert = nullptr;
    if (avrt != nullptr) {
        auto setCharacteristics = reinterpret_cast<SetCharacteristicsFn>(
            reinterpret_cast<void*>(GetProcAddress(avrt, "AvSetMmThreadCharacteristicsW")));
        auto setPriority = reinterpret_cast<SetPriorityFn>(
            reinterpret_cast<void*>(GetProcAddress(avrt, "AvSetMmThreadPriority")));
        revert = reinterpret_cast<RevertFn>(
            reinterpret_cast<void*>(GetProcAddress(avrt, "AvRevertMmThreadCharacteristics")));
        if (setCharacteristics != nullptr) {
            DWORD taskIndex = 0;
            mmcssTask = setCharacteristics(L"Pro Audio", &taskIndex);
            if (mmcssTask != nullptr && setPriority != nullptr) {
                setPriority(mmcssTask, 0 /* AVRT_PRIORITY_NORMAL */);
            }
        }
    }
    if (mmcssTask == nullptr) {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        util::log::audioNote("MMCSS unavailable; using THREAD_PRIORITY_TIME_CRITICAL");
    }

    while (!stopping_.load(std::memory_order_acquire)) {
        if (parkRequest_.load(std::memory_order_acquire)) {
            SetEvent(parkedEvent_);
            HANDLE waits[2] = {resumeEvent_, stopEvent_};
            // Bounded wait so a park request that was abandoned (the message
            // thread timed out) cannot strand this thread forever.
            WaitForMultipleObjects(2, waits, FALSE, 100);
            continue;
        }

        // Between blocks and never while parked (the branch above returns first).
        maybeFlushParameters();

        SOCKET socket = clientSocket_.load(std::memory_order_acquire);
        if (socket == INVALID_SOCKET) {
            const SOCKET taken = server_.takeClient();
            if (taken != INVALID_SOCKET) {
                // The marker goes in before the socket is adopted, so it precedes every
                // message this connection can produce.
                if (!queueConnectionMarker(kMarkerConnected)) {
                    util::log::audioNote("control queue full; new client refused");
                    server_.releaseClient(taken);
                    continue;
                }
                reader_.reset();
                bypassGain_ = 0.0f;
                bypassDelay_.clear();
                clientSocket_.store(taken, std::memory_order_release);
                continue;
            }
            WaitForSingleObject(stopEvent_, 5);
            continue;
        }

        drainOutgoing();
        socket = clientSocket_.load(std::memory_order_acquire);
        if (socket == INVALID_SOCKET) continue;

        size_t space = 0;
        uint8_t* buffer = reader_.writePointer(space);
        if (buffer == nullptr || space == 0) {
            util::log::audioNote("receive buffer exhausted");
            dropClient();
            continue;
        }
        // Wait for bytes with WSAPoll and only then recv(): the recv never times out, so the
        // socket never enters the indeterminate state a timed-out blocking recv leaves behind.
        WSAPOLLFD poll{};
        poll.fd = socket;
        poll.events = POLLRDNORM;
        const int ready = WSAPoll(&poll, 1, net::kAudioPollTimeoutMs);
        if (ready == 0) continue;
        if (ready == SOCKET_ERROR) {
            util::log::audioNote("poll failed", WSAGetLastError());
            dropClient();
            continue;
        }
        const int wanted = static_cast<int>(std::min<size_t>(space, 256 * 1024));
        const int received = recv(socket, reinterpret_cast<char*>(buffer), wanted, 0);
        if (received == 0) {
            dropClient();
            continue;
        }
        if (received == SOCKET_ERROR) {
            const int code = WSAGetLastError();
            if (code == WSAETIMEDOUT || code == WSAEWOULDBLOCK) continue;
            util::log::audioNote("recv failed", code);
            dropClient();
            continue;
        }
        reader_.commitWrite(static_cast<size_t>(received));

        bool connected = true;
        while (connected) {
            net::FrameReader::Message message;
            const net::FrameReader::Status status = reader_.next(message);
            if (status == net::FrameReader::Status::NeedMore) break;
            if (status != net::FrameReader::Status::Message) {
                uint8_t closePayload[2];
                const uint16_t closeCode = reader_.closeCode();
                closePayload[0] = static_cast<uint8_t>((closeCode >> 8) & 0xFFu);
                closePayload[1] = static_cast<uint8_t>(closeCode & 0xFFu);
                sendFrame(net::Opcode::Close, closePayload, sizeof(closePayload));
                util::log::audioNote("websocket protocol error; closing", closeCode);
                pushNotice(AudioNoticeCode::ProtocolViolation, closeCode);
                dropClient();
                connected = false;
                break;
            }
            connected = handleSocketMessage(message);
        }
    }

    if (mmcssTask != nullptr && revert != nullptr) revert(mmcssTask);
    if (avrt != nullptr) FreeLibrary(avrt);

    const SOCKET socket = clientSocket_.exchange(INVALID_SOCKET);
    if (socket != INVALID_SOCKET) server_.releaseClient(socket);
}

}  // namespace thedaw
