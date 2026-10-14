/** Offline-only verifier preload. Never used by the extension or live integration tests. */
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import child from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const esbuildPackage = import.meta.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`);
const esbuildBinary = fileURLToPath(new URL("bin/esbuild", esbuildPackage));
const esbuildVersion = JSON.parse(readFileSync(new URL(esbuildPackage), "utf8")).version;

let attempts = 0;
function refuse(kind) {
	attempts++;
	const error = new Error(`OFFLINE GUARD: unexpected ${kind}`);
	console.error(error.stack);
	throw error;
}
const sdk = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
const wrapper = "offline-guard:sdk";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@anthropic-ai/claude-agent-sdk") return { url: wrapper, shortCircuit: true };
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === wrapper) return {
			format: "module", shortCircuit: true,
			source: `export * from ${JSON.stringify(sdk)}; export function query() { globalThis[Symbol.for("bridge:offline-refuse")]("SDK query (not mocked)"); }`,
		};
		return next(url, context);
	},
});
globalThis[Symbol.for("bridge:offline-refuse")] = refuse;
for (const object of [http, https]) {
	for (const name of ["request", "get"]) object[name] = () => refuse("network call");
}
// tsx probes its parent's IPC pipe under the redirected TMPDIR. This exact local
// path is not an external network endpoint; all TCP and other sockets stay blocked.
const tsxPipe = join(tmpdir(), `tsx-${process.geteuid()}`, `${process.ppid}.pipe`);
let tsxConnecting = false;
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	if (!tsxConnecting) return refuse("socket connection");
	return socketConnect.apply(this, args);
};
for (const name of ["connect", "createConnection"]) {
	const original = net[name];
	net[name] = (...args) => {
		if (args[0] !== tsxPipe) return refuse("network call");
		tsxConnecting = true;
		try { return original(...args); } finally { tsxConnecting = false; }
	};
}
globalThis.fetch = () => refuse("fetch");
// Package unit tests spawn Node for their own isolated probes. The SDK is trapped above;
// tsx also needs the existing esbuild transform service (exact binary/arguments only).
// No Claude CLI, shell, installer or other subprocess is permitted.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
	const original = child[name];
	child[name] = (binary, ...args) => {
		const transform = binary === esbuildBinary && JSON.stringify(args[0]) === JSON.stringify([`--service=${esbuildVersion}`, "--ping"]);
		if (binary !== process.execPath && !transform) return refuse("non-Node/non-transform subprocess");
		return original(binary, ...args);
	};
}
for (const name of ["exec", "execSync"]) child[name] = () => refuse("shell subprocess");
syncBuiltinESMExports();
process.on("exit", () => {
	if (attempts) {
		console.error(`OFFLINE GUARD: ${attempts} unexpected SDK/network/subprocess call(s)`);
		process.exitCode = 1;
	}
});
