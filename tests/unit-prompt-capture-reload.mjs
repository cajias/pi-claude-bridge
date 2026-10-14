/**
 * The shared capture store survives a /reload: it lives on globalThis and holds every key the
 * session recorded, so the new module instance finds the *previous* instance's object. One built
 * by an older bridge has none of the methods this version added; calling them used to be a
 * TypeError on every turn until a full restart. The new instance adopts the old object in place,
 * so it keeps its recorded keys and gains the current methods.
 *
 * Own file: the store is process-wide and index.js reads it at import time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadFixture } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-reload-"));
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, "claude");
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

// What a running 0.9.2 process holds: an instance of the old class with a key already recorded.
const { PromptCaptures: LegacyPromptCaptures } = await import("./fixtures/prompt-capture-0.9.2.ts");
const legacy = new LegacyPromptCaptures(256);
const RECORDED = "You are a recorded prompt from before the reload.";
legacy.record(RECORDED, { contextFiles: [{ path: "/w/AGENTS.md", content: "RECORDED_BEFORE_RELOAD" }], skills: [], sections: { mcp_servers: "RECORDED_MCP_POLICY" } }, "before_agent_start");
globalThis[Symbol.for("claude-bridge:promptCaptures")] = legacy;
assert.equal(typeof legacy.recordFromReplay, "undefined", "precondition: the old class predates replay capture");

const { default: activate, __test } = await import("../src/index.js");

describe("shared capture store across a /reload", () => {
	it("adopts the previous bridge's store: same object, recorded keys kept, current methods present", async () => {
		assert.equal(__test.promptCaptures, legacy);
		assert.equal(typeof __test.promptCaptures.recordFromReplay, "function");
		assert.deepEqual(__test.promptCaptures.resolveOrDerive(RECORDED).contextFiles, [{ path: "/w/AGENTS.md", content: "RECORDED_BEFORE_RELOAD" }]);
		assert.equal(__test.promptCaptures.size, 1);
		const { projectPromptCapture } = await import("../src/prompt-capture.js");
		assert.match(projectPromptCapture(__test.promptCaptures.resolveOrDerive(RECORDED), { skillReadTool: "none" }), /<mcp_servers>\nRECORDED_MCP_POLICY\n<\/mcp_servers>/);
	});

	it("serves a replay turn from the adopted store without a TypeError", async () => {
		let providerConfig;
		activate({ on: () => {}, registerProvider: (_n, c) => { providerConfig = c; }, registerTool: () => {} });
		let append;
		__test.setQuery(({ options }) => {
			append = options.systemPrompt.append;
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: "cc-reload" };
				yield { type: "result", subtype: "success", is_error: false, result: "ok" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		try {
			const f = leadFixture();
			const messages = [
				{ role: "system", content: "", timestamp: 0, toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] },
				{ role: "system", content: "", timestamp: 0, sections: f.replay },
				{ role: "user", content: "checkpoint", timestamp: 1 },
			];
			const result = await providerConfig.streamSimple(providerConfig.models[0], { messages, tools: [] }, { sessionId: "pi-reload" }).result();
			assert.notEqual(result.stopReason, "error", result.errorMessage);
			assert.match(append, new RegExp(f.marker));
			assert.equal(__test.promptCaptures.size, 2, "the old key and the replayed one");
		} finally {
			__test.setQuery(null);
		}
	});

});
