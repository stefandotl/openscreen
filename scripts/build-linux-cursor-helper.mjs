#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Skipping Linux cursor helper build: host platform is not Linux.");
	process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "electron", "native", "linux-cursor-helper");
const buildDir = path.join(sourceDir, "build");
const outputPath = path.join(buildDir, "openscreen-linux-cursor-helper");
const archTag = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
const distributableDir = path.join(root, "electron", "native", "bin", archTag);
const distributablePath = path.join(distributableDir, "openscreen-linux-cursor-helper");
const compiler = process.env.CXX ?? "g++";

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
	});

	if (result.error) {
		console.error(`Failed to start ${command}: ${result.error.message}`);
		process.exit(1);
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distributableDir, { recursive: true });

run(compiler, [
	"-std=c++17",
	"-O2",
	"-Wall",
	"-Wextra",
	"-Wpedantic",
	path.join(sourceDir, "src", "main.cpp"),
	"-o",
	outputPath,
	"-lX11",
	"-lXi",
]);

fs.copyFileSync(outputPath, distributablePath);
fs.chmodSync(outputPath, 0o755);
fs.chmodSync(distributablePath, 0o755);

console.log(`Built Linux cursor helper: ${outputPath}`);
console.log(`Copied redistributable helper: ${distributablePath}`);
