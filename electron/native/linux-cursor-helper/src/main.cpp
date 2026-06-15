#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/extensions/XInput2.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Bounds {
	int x = 0;
	int y = 0;
	int width = 1;
	int height = 1;
};

struct Config {
	int sampleIntervalMs = 33;
	std::string sourceId;
	std::string sourceName;
	std::string sourceType = "display";
	std::optional<Bounds> bounds;
};

struct PointerState {
	int x = 0;
	int y = 0;
	bool visible = true;
};

std::atomic<bool> g_running{true};

void handleSignal(int) {
	g_running = false;
}

int64_t nowMs() {
	using namespace std::chrono;
	return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string jsonEscape(const std::string& value) {
	std::ostringstream escaped;
	for (char ch : value) {
		switch (ch) {
			case '\\':
				escaped << "\\\\";
				break;
			case '"':
				escaped << "\\\"";
				break;
			case '\n':
				escaped << "\\n";
				break;
			case '\r':
				escaped << "\\r";
				break;
			case '\t':
				escaped << "\\t";
				break;
			default:
				escaped << ch;
				break;
		}
	}
	return escaped.str();
}

std::string lowercase(std::string value) {
	std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
		return static_cast<char>(std::tolower(ch));
	});
	return value;
}

std::string normalizeTitle(std::string value) {
	value = lowercase(value);
	std::string normalized;
	bool previousSpace = false;
	for (char ch : value) {
		const bool isSpace = std::isspace(static_cast<unsigned char>(ch)) != 0;
		if (isSpace) {
			if (!previousSpace && !normalized.empty()) {
				normalized.push_back(' ');
			}
			previousSpace = true;
		} else {
			normalized.push_back(ch);
			previousSpace = false;
		}
	}
	if (!normalized.empty() && normalized.back() == ' ') {
		normalized.pop_back();
	}
	return normalized;
}

void emitReady(const Bounds& bounds, bool xinputReady) {
	std::cout << "{\"type\":\"ready\",\"timestampMs\":" << nowMs()
			  << ",\"provider\":\"linux-x11\",\"xinput\":" << (xinputReady ? "true" : "false")
			  << ",\"bounds\":{\"x\":" << bounds.x << ",\"y\":" << bounds.y
			  << ",\"width\":" << bounds.width << ",\"height\":" << bounds.height << "}}\n";
	std::cout.flush();
}

void emitDiagnostic(const std::string& message) {
	std::cout << "{\"type\":\"diagnostic\",\"message\":\"" << jsonEscape(message) << "\"}\n";
	std::cout.flush();
}

void emitSample(
	int64_t startMs,
	const Bounds& bounds,
	const PointerState& pointer,
	const char* interactionType
) {
	const double width = std::max(1, bounds.width);
	const double height = std::max(1, bounds.height);
	const double rawCx = (static_cast<double>(pointer.x) - bounds.x) / width;
	const double rawCy = (static_cast<double>(pointer.y) - bounds.y) / height;
	const double cx = std::clamp(rawCx, 0.0, 1.0);
	const double cy = std::clamp(rawCy, 0.0, 1.0);
	const bool visible = pointer.visible && rawCx >= 0.0 && rawCx <= 1.0 && rawCy >= 0.0 && rawCy <= 1.0;

	std::cout << "{\"type\":\"sample\",\"timeMs\":" << std::max<int64_t>(0, nowMs() - startMs)
			  << ",\"x\":" << pointer.x << ",\"y\":" << pointer.y << ",\"cx\":" << cx
			  << ",\"cy\":" << cy << ",\"visible\":" << (visible ? "true" : "false")
			  << ",\"interactionType\":\"" << interactionType << "\"}\n";
	std::cout.flush();
}

std::optional<int> parseInt(const std::string& value) {
	char* end = nullptr;
	const long parsed = std::strtol(value.c_str(), &end, 10);
	if (end == value.c_str() || *end != '\0') {
		return std::nullopt;
	}
	return static_cast<int>(parsed);
}

std::optional<unsigned long> parseWindowId(const std::string& value) {
	char* end = nullptr;
	const int base = value.rfind("0x", 0) == 0 || value.rfind("0X", 0) == 0 ? 16 : 10;
	const unsigned long parsed = std::strtoul(value.c_str(), &end, base);
	if (end == value.c_str() || *end != '\0' || parsed == 0) {
		return std::nullopt;
	}
	return parsed;
}

std::vector<unsigned long> parseWindowIdCandidates(const std::string& sourceId) {
	std::vector<unsigned long> ids;
	if (sourceId.rfind("window:", 0) != 0) {
		return ids;
	}

	std::stringstream stream(sourceId.substr(std::strlen("window:")));
	std::string part;
	while (std::getline(stream, part, ':')) {
		if (auto parsed = parseWindowId(part)) {
			ids.push_back(*parsed);
		}
	}
	return ids;
}

Config parseArgs(int argc, char** argv) {
	Config config;
	for (int i = 1; i < argc; ++i) {
		const std::string arg = argv[i];
		auto readValue = [&](std::string& target) {
			if (i + 1 < argc) {
				target = argv[++i];
			}
		};

		if (arg == "--sample-interval-ms" && i + 1 < argc) {
			if (auto parsed = parseInt(argv[++i])) {
				config.sampleIntervalMs = std::max(5, *parsed);
			}
		} else if (arg == "--source-id") {
			readValue(config.sourceId);
		} else if (arg == "--source-name") {
			readValue(config.sourceName);
		} else if (arg == "--source-type") {
			readValue(config.sourceType);
		} else if (arg == "--bounds" && i + 1 < argc) {
			const std::string value = argv[++i];
			std::stringstream stream(value);
			std::string part;
			std::vector<int> values;
			while (std::getline(stream, part, ',')) {
				if (auto parsed = parseInt(part)) {
					values.push_back(*parsed);
				}
			}
			if (values.size() == 4 && values[2] > 0 && values[3] > 0) {
				config.bounds = Bounds{values[0], values[1], values[2], values[3]};
			}
		}
	}
	return config;
}

std::optional<std::string> getWindowName(Display* display, Window window) {
	char* name = nullptr;
	if (XFetchName(display, window, &name) != 0 && name) {
		std::string result = name;
		XFree(name);
		if (!result.empty()) {
			return result;
		}
	}

	const Atom netWmName = XInternAtom(display, "_NET_WM_NAME", True);
	const Atom utf8String = XInternAtom(display, "UTF8_STRING", True);
	if (netWmName == None || utf8String == None) {
		return std::nullopt;
	}

	Atom actualType = None;
	int actualFormat = 0;
	unsigned long itemCount = 0;
	unsigned long bytesAfter = 0;
	unsigned char* prop = nullptr;
	const int status = XGetWindowProperty(
		display,
		window,
		netWmName,
		0,
		1024,
		False,
		utf8String,
		&actualType,
		&actualFormat,
		&itemCount,
		&bytesAfter,
		&prop
	);
	if (status == Success && prop && itemCount > 0) {
		std::string result(reinterpret_cast<char*>(prop), itemCount);
		XFree(prop);
		return result;
	}
	if (prop) {
		XFree(prop);
	}
	return std::nullopt;
}

std::vector<Window> getClientWindows(Display* display, Window root) {
	const Atom clientListAtom = XInternAtom(display, "_NET_CLIENT_LIST", True);
	std::vector<Window> windows;
	if (clientListAtom != None) {
		Atom actualType = None;
		int actualFormat = 0;
		unsigned long itemCount = 0;
		unsigned long bytesAfter = 0;
		unsigned char* prop = nullptr;
		const int status = XGetWindowProperty(
			display,
			root,
			clientListAtom,
			0,
			4096,
			False,
			XA_WINDOW,
			&actualType,
			&actualFormat,
			&itemCount,
			&bytesAfter,
			&prop
		);
		if (status == Success && prop && actualFormat == 32) {
			auto* rawWindows = reinterpret_cast<Window*>(prop);
			windows.assign(rawWindows, rawWindows + itemCount);
			XFree(prop);
			if (!windows.empty()) {
				return windows;
			}
		}
		if (prop) {
			XFree(prop);
		}
	}

	Window rootReturn = 0;
	Window parentReturn = 0;
	Window* children = nullptr;
	unsigned int childCount = 0;
	if (XQueryTree(display, root, &rootReturn, &parentReturn, &children, &childCount) != 0 && children) {
		windows.assign(children, children + childCount);
		XFree(children);
	}
	return windows;
}

std::optional<Bounds> getWindowBounds(Display* display, Window root, Window window) {
	XWindowAttributes attrs{};
	if (XGetWindowAttributes(display, window, &attrs) == 0 || attrs.width <= 0 || attrs.height <= 0) {
		return std::nullopt;
	}

	Window child = 0;
	int rootX = 0;
	int rootY = 0;
	if (XTranslateCoordinates(display, window, root, 0, 0, &rootX, &rootY, &child) == 0) {
		rootX = attrs.x;
		rootY = attrs.y;
	}

	return Bounds{rootX, rootY, attrs.width, attrs.height};
}

std::optional<Bounds> resolveWindowBounds(Display* display, Window root, const Config& config) {
	const auto idCandidates = parseWindowIdCandidates(config.sourceId);
	const std::string normalizedSourceName = normalizeTitle(config.sourceName);
	std::optional<Bounds> titleMatch;

	for (Window window : getClientWindows(display, root)) {
		if (std::find(idCandidates.begin(), idCandidates.end(), static_cast<unsigned long>(window)) != idCandidates.end()) {
			if (auto bounds = getWindowBounds(display, root, window)) {
				return bounds;
			}
		}

		if (!titleMatch && !normalizedSourceName.empty()) {
			const auto title = getWindowName(display, window);
			const std::string normalizedTitle = normalizeTitle(title.value_or(""));
			if (
				!normalizedTitle.empty() &&
				(normalizedTitle.find(normalizedSourceName) != std::string::npos ||
				 normalizedSourceName.find(normalizedTitle) != std::string::npos)
			) {
				titleMatch = getWindowBounds(display, root, window);
			}
		}
	}

	return titleMatch;
}

Bounds rootBounds(Display* display, int screenNumber) {
	return Bounds{
		0,
		0,
		DisplayWidth(display, screenNumber),
		DisplayHeight(display, screenNumber),
	};
}

PointerState queryPointer(Display* display, Window root) {
	Window rootReturn = 0;
	Window childReturn = 0;
	int rootX = 0;
	int rootY = 0;
	int windowX = 0;
	int windowY = 0;
	unsigned int mask = 0;
	if (XQueryPointer(display, root, &rootReturn, &childReturn, &rootX, &rootY, &windowX, &windowY, &mask) == 0) {
		return PointerState{0, 0, false};
	}
	return PointerState{rootX, rootY, true};
}

bool setupXInput(Display* display, Window root, int& xiOpcode) {
	int event = 0;
	int error = 0;
	if (!XQueryExtension(display, "XInputExtension", &xiOpcode, &event, &error)) {
		return false;
	}

	int major = 2;
	int minor = 0;
	if (XIQueryVersion(display, &major, &minor) != Success) {
		return false;
	}

	unsigned char mask[(XI_LASTEVENT + 7) / 8] = {};
	XISetMask(mask, XI_RawButtonPress);
	XISetMask(mask, XI_RawButtonRelease);
	XIEventMask eventMask{};
	eventMask.deviceid = XIAllMasterDevices;
	eventMask.mask_len = sizeof(mask);
	eventMask.mask = mask;
	XISelectEvents(display, root, &eventMask, 1);
	XFlush(display);
	return true;
}

}  // namespace

int main(int argc, char** argv) {
	std::signal(SIGINT, handleSignal);
	std::signal(SIGTERM, handleSignal);

	const Config config = parseArgs(argc, argv);
	Display* display = XOpenDisplay(nullptr);
	if (!display) {
		std::cout << "{\"type\":\"error\",\"message\":\"Unable to open X11 display\"}\n";
		std::cout.flush();
		return 1;
	}

	const int screenNumber = DefaultScreen(display);
	const Window root = RootWindow(display, screenNumber);
	Bounds captureBounds = config.bounds.value_or(rootBounds(display, screenNumber));
	if (!config.bounds && config.sourceType == "window") {
		if (auto windowBounds = resolveWindowBounds(display, root, config)) {
			captureBounds = *windowBounds;
		} else {
			emitDiagnostic("Could not resolve selected window bounds; using root bounds.");
		}
	}

	int xiOpcode = 0;
	const bool xinputReady = setupXInput(display, root, xiOpcode);
	if (!xinputReady) {
		emitDiagnostic("XInput2 is unavailable; click events will not be captured.");
	}

	const int64_t startMs = nowMs();
	int64_t nextSampleMs = startMs;
	emitReady(captureBounds, xinputReady);

	while (g_running) {
		while (XPending(display) > 0) {
			XEvent event{};
			XNextEvent(display, &event);
			if (event.xcookie.type == GenericEvent && event.xcookie.extension == xiOpcode) {
				if (XGetEventData(display, &event.xcookie) != 0) {
					const int eventType = event.xcookie.evtype;
					if (eventType == XI_RawButtonPress || eventType == XI_RawButtonRelease) {
						const PointerState pointer = queryPointer(display, root);
						emitSample(
							startMs,
							captureBounds,
							pointer,
							eventType == XI_RawButtonPress ? "click" : "mouseup"
						);
					}
					XFreeEventData(display, &event.xcookie);
				}
			}
		}

		const int64_t currentMs = nowMs();
		if (currentMs >= nextSampleMs) {
			const PointerState pointer = queryPointer(display, root);
			emitSample(startMs, captureBounds, pointer, "move");
			nextSampleMs = currentMs + config.sampleIntervalMs;
		}

		std::this_thread::sleep_for(std::chrono::milliseconds(2));
	}

	std::cout << "{\"type\":\"stopped\"}\n";
	std::cout.flush();
	XCloseDisplay(display);
	return 0;
}
