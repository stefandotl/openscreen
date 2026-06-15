import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "../types";
import {
	CLICK_CANDIDATE_STRENGTH,
	detectZoomClickCandidates,
	detectZoomDwellCandidates,
	normalizeCursorTelemetry,
} from "./zoomSuggestionUtils";

function makeSamples(points: CursorTelemetryPoint[]): CursorTelemetryPoint[] {
	return points;
}

describe("zoomSuggestionUtils", () => {
	it("keeps interaction metadata when normalizing telemetry", () => {
		const samples = normalizeCursorTelemetry(
			makeSamples([{ timeMs: 1200, cx: 2, cy: -1, interactionType: "click" }]),
			1000,
		);

		expect(samples).toEqual([{ timeMs: 1000, cx: 1, cy: 0, interactionType: "click" }]);
	});

	it("turns click clusters into high-priority zoom candidates", () => {
		const candidates = detectZoomClickCandidates(
			makeSamples([
				{ timeMs: 100, cx: 0.2, cy: 0.3, interactionType: "click" },
				{ timeMs: 450, cx: 0.22, cy: 0.32, interactionType: "click" },
				{ timeMs: 1800, cx: 0.7, cy: 0.5, interactionType: "click" },
			]),
		);

		expect(candidates).toHaveLength(2);
		expect(candidates[0].centerTimeMs).toBe(275);
		expect(candidates[0].focus.cx).toBeCloseTo(0.21, 2);
		expect(candidates[0].strength).toBeGreaterThan(CLICK_CANDIDATE_STRENGTH);
		expect(candidates[1].centerTimeMs).toBe(1800);
	});

	it("still detects dwell moments for recordings without clicks", () => {
		const candidates = detectZoomDwellCandidates(
			makeSamples([
				{ timeMs: 0, cx: 0.5, cy: 0.5 },
				{ timeMs: 200, cx: 0.51, cy: 0.5 },
				{ timeMs: 500, cx: 0.5, cy: 0.51 },
				{ timeMs: 800, cx: 0.5, cy: 0.5 },
			]),
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0].focus.cx).toBeCloseTo(0.5, 2);
	});
});
