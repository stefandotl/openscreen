import { type ChildProcessByStdio, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Rectangle } from "electron";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";
import type { CursorRecordingSession } from "./session";

interface LinuxNativeCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	sourceName?: string | null;
	startTimeMs?: number;
}

type LinuxCursorEvent =
	| {
			type: "ready";
			timestampMs?: number;
			provider?: string;
			xinput?: boolean;
			bounds?: Rectangle;
	  }
	| {
			type: "diagnostic";
			message?: string;
	  }
	| {
			type: "error";
			message?: string;
	  }
	| {
			type: "sample";
			timeMs?: number;
			x?: number;
			y?: number;
			cx?: number;
			cy?: number;
			visible?: boolean;
			interactionType?: "move" | "click" | "mouseup";
	  }
	| {
			type: "stopped";
	  };

const HELPER_NAME = "openscreen-linux-cursor-helper";
const READY_TIMEOUT_MS = 5_000;

function helperCandidates() {
	const envPath = process.env.OPENSCREEN_LINUX_CURSOR_HELPER_EXE?.trim();
	const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : process.cwd();
	const archTag = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	const resourceRoot =
		typeof process.resourcesPath === "string"
			? process.resourcesPath
			: path.join(appRoot, "resources");

	return [
		envPath,
		path.join(appRoot, "electron", "native", "linux-cursor-helper", "build", HELPER_NAME),
		path.join(appRoot, "electron", "native", "bin", archTag, HELPER_NAME),
		path.join(resourceRoot, "electron", "native", "bin", archTag, HELPER_NAME),
	].filter((candidate): candidate is string => Boolean(candidate));
}

export function findLinuxCursorHelperPath() {
	if (process.platform !== "linux") {
		return null;
	}

	for (const candidate of helperCandidates()) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next helper location.
		}
	}

	return null;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function normalizeBounds(bounds: Rectangle | null): Rectangle | null {
	if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
		return null;
	}

	return {
		x: Math.round(bounds.x),
		y: Math.round(bounds.y),
		width: Math.round(bounds.width),
		height: Math.round(bounds.height),
	};
}

export class LinuxNativeCursorRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
	private lineBuffer = "";
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private readyTimer: NodeJS.Timeout | null = null;
	private sampleCount = 0;
	private clickSampleCount = 0;
	private helperBounds: Rectangle | null = null;

	constructor(private readonly options: LinuxNativeCursorRecordingSessionOptions) {}

	async start(): Promise<void> {
		this.samples = [];
		this.lineBuffer = "";
		this.sampleCount = 0;
		this.clickSampleCount = 0;
		this.helperBounds = null;

		const helperPath = findLinuxCursorHelperPath();
		if (!helperPath) {
			throw new Error("Linux cursor helper is not available.");
		}

		const args = [
			"--sample-interval-ms",
			String(this.options.sampleIntervalMs),
			"--source-type",
			this.options.sourceId?.startsWith("window:") ? "window" : "display",
		];
		if (this.options.sourceId) {
			args.push("--source-id", this.options.sourceId);
		}
		if (this.options.sourceName) {
			args.push("--source-name", this.options.sourceName);
		}
		const displayBounds = normalizeBounds(this.options.getDisplayBounds());
		if (displayBounds && !this.options.sourceId?.startsWith("window:")) {
			args.push(
				"--bounds",
				`${displayBounds.x},${displayBounds.y},${displayBounds.width},${displayBounds.height}`,
			);
		}

		const child = spawn(helperPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.process = child;

		this.logDiagnostic("spawn", {
			helperPath,
			pid: child.pid ?? null,
			sourceId: this.options.sourceId ?? null,
			sourceName: this.options.sourceName ?? null,
			displayBounds,
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.handleStdoutChunk(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const message = chunk.trim();
			if (message) {
				this.logDiagnostic("stderr", { message });
			}
		});
		child.once("exit", (code, signal) => {
			this.logDiagnostic("exit", {
				code,
				signal,
				sampleCount: this.sampleCount,
				clickSampleCount: this.clickSampleCount,
			});
			this.rejectReady(
				new Error(`Linux cursor helper exited before ready (code=${code}, signal=${signal})`),
			);
		});
		child.once("error", (error) => {
			this.logDiagnostic("process-error", { message: error.message });
			this.rejectReady(error);
		});

		try {
			await this.waitUntilReady();
		} catch (error) {
			this.terminateHelperProcess();
			throw error;
		}
	}

	async stop(): Promise<CursorRecordingData> {
		const child = this.process;
		this.process = null;
		this.clearReadyState();
		this.killHelperProcess(child);

		this.logDiagnostic("stop", {
			sampleCount: this.sampleCount,
			clickSampleCount: this.clickSampleCount,
			bounds: this.helperBounds,
		});

		return {
			version: 2,
			provider: "none",
			samples: this.samples,
			assets: [],
		};
	}

	private handleStdoutChunk(chunk: string) {
		this.lineBuffer += chunk;
		const lines = this.lineBuffer.split(/\r?\n/);
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine) {
				continue;
			}

			try {
				const payload = JSON.parse(trimmedLine) as LinuxCursorEvent;
				this.handleEvent(payload);
			} catch (error) {
				console.error("Failed to parse Linux cursor helper output:", error, trimmedLine);
			}
		}
	}

	private handleEvent(payload: LinuxCursorEvent) {
		if (payload.type === "ready") {
			this.helperBounds = normalizeBounds(payload.bounds ?? null);
			this.logDiagnostic("ready", {
				timestampMs: payload.timestampMs ?? null,
				xinput: payload.xinput === true,
				bounds: this.helperBounds,
			});
			this.resolveReady();
			return;
		}

		if (payload.type === "diagnostic") {
			this.logDiagnostic("helper-diagnostic", { message: payload.message ?? "" });
			return;
		}

		if (payload.type === "error") {
			const message = payload.message || "Linux cursor helper failed.";
			this.logDiagnostic("helper-error", { message });
			this.failHelper(new Error(message));
			return;
		}

		if (payload.type !== "sample") {
			return;
		}

		const sample = this.normalizeSample(payload);
		this.sampleCount += 1;
		if (sample.interactionType === "click") {
			this.clickSampleCount += 1;
		}
		this.samples.push(sample);

		if (this.samples.length > this.options.maxSamples) {
			this.samples.shift();
		}
	}

	private normalizeSample(
		payload: Extract<LinuxCursorEvent, { type: "sample" }>,
	): CursorRecordingSample {
		let cx = isFiniteNumber(payload.cx) ? payload.cx : 0.5;
		let cy = isFiniteNumber(payload.cy) ? payload.cy : 0.5;
		let visible = payload.visible !== false;

		if (
			(!isFiniteNumber(payload.cx) || !isFiniteNumber(payload.cy)) &&
			isFiniteNumber(payload.x) &&
			isFiniteNumber(payload.y)
		) {
			const bounds = this.helperBounds ?? this.options.getDisplayBounds();
			if (bounds && bounds.width > 0 && bounds.height > 0) {
				const rawCx = (payload.x - bounds.x) / bounds.width;
				const rawCy = (payload.y - bounds.y) / bounds.height;
				cx = rawCx;
				cy = rawCy;
				visible = visible && rawCx >= 0 && rawCx <= 1 && rawCy >= 0 && rawCy <= 1;
			}
		}

		const interactionType =
			payload.interactionType === "click" || payload.interactionType === "mouseup"
				? payload.interactionType
				: "move";

		return {
			timeMs: isFiniteNumber(payload.timeMs) ? Math.max(0, payload.timeMs) : 0,
			cx: clamp(cx, 0, 1),
			cy: clamp(cy, 0, 1),
			visible,
			interactionType,
		};
	}

	private waitUntilReady() {
		return new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
			this.readyTimer = setTimeout(() => {
				this.rejectReady(new Error("Timed out waiting for Linux cursor helper readiness"));
			}, READY_TIMEOUT_MS);
		});
	}

	private resolveReady() {
		const resolve = this.readyResolve;
		this.clearReadyState();
		resolve?.();
	}

	private rejectReady(error: Error) {
		const reject = this.readyReject;
		this.clearReadyState();
		reject?.(error);
	}

	private failHelper(error: Error) {
		this.rejectReady(error);
		this.terminateHelperProcess();
	}

	private terminateHelperProcess() {
		const child = this.process;
		this.process = null;
		this.killHelperProcess(child);
	}

	private killHelperProcess(child: ChildProcessByStdio<null, Readable, Readable> | null) {
		if (child && !child.killed) {
			child.kill("SIGTERM");
		}
	}

	private clearReadyState() {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		this.readyResolve = null;
		this.readyReject = null;
	}

	private logDiagnostic(event: string, data: Record<string, unknown>) {
		console.info(
			"[cursor-native][linux]",
			JSON.stringify({
				event,
				...data,
			}),
		);
	}
}
