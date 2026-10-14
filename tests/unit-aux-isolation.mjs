/**
 * BR-AUX-1: an auxiliary agent's query runs to completion while a parent query is parked.
 *
 * The completion auditor runs inside the parent's `goal_complete` tool call, so its provider
 * calls arrive while the parent's Claude Code query sits parked on that very tool call. The
 * auditor is a separate pi session (its own session id) with its own tools, and its own tool
 * loop must stay inside its own query: results routed by id to the auxiliary query only, the
 * parent's pending call, history cursor, digests, mirror and stream left exactly as they were,
 * and the parent's result delivered to it once, afterwards, whatever became of the auxiliary
 * (success, error, cancel).
 *
 * Real pieces: streamSimple, the bridge's MCP tool server (the parked handlers are the real
 * `tools/call` handlers, driven the way Claude Code drives them) and the shared session state.
 * Mocked: the SDK query() only.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDITOR_PREAMBLE, auxSections } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-aux-isolation-"));
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, "claude");
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");

let providerConfig;
activate({ on: () => {}, registerProvider: (_n, c) => { providerConfig = c; }, registerTool: () => {} });
const model = providerConfig.models[0];
const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const PARENT_TOOLS = [tool("read"), tool("goal_complete")];
const AUX_TOOLS = [tool("read"), tool("grep")]; // `read` on purpose: same tool name, different query

// --- pi-side messages ---
let clock = 1;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: clock++ });
const say = (text) => asst([{ type: "text", text }]);
const toolCall = (id, name = "read") => asst([{ type: "toolCall", id, name, arguments: {} }], "toolUse");
const toolResult = (id, text, name = "read") => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: clock++ });

const sys = (extra) => ({ role: "system", content: "", timestamp: 0, ...extra });
const auxHead = () => [sys({ toolsAdded: AUX_TOOLS }), sys({ sections: auxSections(AUDITOR_PREAMBLE, "/work/synthetic-auditxxxxxxx") })];

// --- fake SDK query ---
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id, name = "read") => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${name}`, input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

const calls = [];
const scripts = [];
/** Drive a tool the way Claude Code does: a tools/call on the query's own in-process MCP server. */
function callTool(options, toolName, toolUseId) {
	const server = options.mcpServers["custom-tools"].instance.server;
	const handler = server._requestHandlers.get("tools/call");
	return handler({ method: "tools/call", params: { name: toolName, arguments: {}, _meta: { "claudecode/toolUseId": toolUseId } } }, {});
}
const handlers = {}; // tool_use id -> { promise, settled: [..results] }
const park = (toolName, toolUseId) => ({ park: true, toolName, toolUseId });
/** The SDK keeps the query open until the tool answers. */
const answered = (toolUseId) => () => handlers[toolUseId].promise;

beforeEach(() => {
	__test.resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	for (const key of Object.keys(handlers)) delete handlers[key];
	__test.setQuery(({ options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume, append: options.systemPrompt.append });
		// close() is how pi/the bridge kills the CLI: a real query ends its iterator when it is called.
		const closed = gate();
		const gen = (async function* () {
			for (const step of script.steps) {
				if (typeof step === "function") { if (await Promise.race([step().then(() => false), closed.wait().then(() => true)])) return; continue; }
				if (step.park) {
					// What the SDK does after a tool_use block: call the tool and wait for the answer.
					const entry = { settled: [] };
					entry.promise = callTool(options, step.toolName, step.toolUseId).then((r) => { entry.settled.push(r); return r; });
					handlers[step.toolUseId] = entry;
					continue;
				}
				if (step.throw) throw new Error(step.throw);
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => closed.open();
		return gen;
	});
});
/** Between tests the SDK entry is a trap, never the real query(): a stray late call must fail loudly, not spawn Claude Code. */
let strayQueries = 0;
const trapQuery = () => { strayQueries++; throw new Error("unexpected real SDK query outside a mocked test"); };
after(() => assert.equal(strayQueries, 0, "no SDK query outside the mocked ones"));
afterEach(() => {
	__test.setQuery(trapQuery);
	for (const c of [...__test.activeQueryContexts]) { c.releasePendingToolCalls("test cleanup"); __test.activeQueryContexts.delete(c); }
});

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const call = (sessionId, messages, tools = [], signal) => providerConfig.streamSimple(model, { messages, tools }, { sessionId, signal });

const P = "pi-parent";
const A = "pi-auditor";

/** Everything a parked parent owns, serialised: any change by the auxiliary query shows. */
function parentSnapshot() {
	const parentCtx = [...__test.activeQueryContexts].find((c) => c.piSessionId === P);
	assert.ok(parentCtx, "the parent query is still registered");
	return {
		ctx: parentCtx,
		activeQuery: parentCtx.activeQuery,
		promptStream: parentCtx.promptStream,
		currentPiStream: parentCtx.currentPiStream,
		pending: [...parentCtx.pendingToolCalls.keys()],
		queued: [...parentCtx.pendingResults.keys()],
		turnIds: [...parentCtx.turnToolCallIds],
		latestCursor: parentCtx.latestCursor,
		historyStale: parentCtx.historyStale,
		preservesMirror: parentCtx.preservesMirror,
		state: JSON.stringify(__test.getSharedSession(P)),
		stateObject: __test.getSharedSession(P),
	};
}
function assertSnapshotUnchanged(before) {
	const after = parentSnapshot();
	for (const key of Object.keys(before)) {
		if (typeof before[key] === "object" && before[key] !== null && !Array.isArray(before[key])) assert.equal(after[key], before[key], `${key}: same object`);
		else assert.deepEqual(after[key], before[key], key);
	}
}

/** The parent has finished turn 1 (so it owns a mirror, cursor and digests) and is parked on a tool call in turn 2. */
async function parkParent() {
	const u1 = user("first"), a1 = say("first answer"), u2 = user("now complete the goal");
	scripts.push({ label: "parent turn 1", steps: [init("cc-P"), result("first answer")] });
	await call(P, [u1], PARENT_TOOLS).result();
	const gP = gate();
	scripts.push({ label: "parent turn 2", steps: [init("cc-P"), ...toolUse("toolu_P1", "goal_complete"), park("goal_complete", "toolu_P1"), gP.wait, result("parent done")] });
	const turn2 = call(P, [u1, a1, u2], PARENT_TOOLS);
	await settle();
	assert.deepEqual([...[...__test.activeQueryContexts].find((c) => c.piSessionId === P).pendingToolCalls.keys()], ["toolu_P1"], "precondition: the parent is parked on its tool call");
	return { u1, a1, u2, gP, turn2, parentContext: [u1, a1, u2] };
}

/** The parent's own tool result arrives (pi finished the goal_complete call that ran the auxiliary). */
async function resumeParent({ parentContext, gP, turn2 }) {
	const a2 = toolCall("toolu_P1", "goal_complete"), tr = toolResult("toolu_P1", "PARENT_RESULT_BODY", "goal_complete");
	const delivery = call(P, [...parentContext, a2, tr], PARENT_TOOLS);
	await settle();
	assert.equal(handlers.toolu_P1.settled.length, 1, "the parent's handler was released exactly once");
	assert.match(JSON.stringify(handlers.toolu_P1.settled[0]), /PARENT_RESULT_BODY/, "with the parent's own result");
	gP.open();
	await Promise.all([delivery.result(), turn2.result()]);
	await settle();
	assert.equal(handlers.toolu_P1.settled.length, 1, "and not again when the parent finishes");
	assert.equal(__test.getSharedSession(P).sessionId, "cc-P", "the parent's mirror is still its own");
	assert.equal(__test.getSharedSession(P).cursor, parentContext.length + 2, "its cursor counts only its own messages (call + result)");
}

describe("BR-AUX-1: an auxiliary query beside a parked parent", () => {
	it("success: the auxiliary tool loop stays query-local; the parent resumes exactly once afterwards", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		const auditorUser = user("audit the goal");

		// Auxiliary turn 1: asks for a tool.
		scripts.push({ label: "aux turn 1", steps: [init("cc-A"), ...toolUse("toolu_A1"), park("read", "toolu_A1"), answered("toolu_A1"), result("aux inspected")] });
		const aux1 = call(A, [...auxHead(), auditorUser], []);
		await settle();
		assert.equal(calls.at(-1).label, "aux turn 1");
		assert.equal(calls.at(-1).append, AUDITOR_PREAMBLE, "the auxiliary query got the verbatim preamble");
		assert.equal(calls.at(-1).resume, undefined, "and a fresh conversation: nothing of the parent's is resumed");
		const auxCtx = [...__test.activeQueryContexts].find((c) => c.piSessionId === A);
		assert.ok(auxCtx && auxCtx !== before.ctx, "a query context of its own");
		assert.deepEqual([...auxCtx.pendingToolCalls.keys()], ["toolu_A1"]);
		assertSnapshotUnchanged(before);

		// Its tool result comes back through the provider: routed to the auxiliary query by id.
		const aCall = toolCall("toolu_A1"), aResult = toolResult("toolu_A1", "AUX_RESULT_BODY");
		await call(A, [...auxHead(), auditorUser, aCall, aResult], []).result();
		await settle();
		assert.equal(handlers.toolu_A1.settled.length, 1);
		assert.match(JSON.stringify(handlers.toolu_A1.settled[0]), /AUX_RESULT_BODY/);
		assert.equal(handlers.toolu_P1.settled.length, 0, "the parent's handler saw nothing of it");
		await aux1.result();
		await settle();
		assert.equal([...__test.activeQueryContexts].some((c) => c.piSessionId === A), false, "the auxiliary query left the routing set");

		// The parent is exactly as parked, and its mirror was never the auxiliary's.
		assertSnapshotUnchanged(before);
		assert.notEqual(__test.getSharedSession(A)?.sessionId ?? "cc-A", before.stateObject.sessionId);
		assert.equal(__test.getSharedSession(P).sessionId, "cc-P");

		await resumeParent(parked);
		assert.equal(handlers.toolu_A1.settled.length, 1, "the auxiliary result was not delivered twice either");
		assert.equal(__test.getSharedSession(P).sessionId, "cc-P", "the parent kept its own conversation");
	});

	it("error: the auxiliary query fails mid-loop; the parent's pending call and mirror are untouched", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();

		scripts.push({ label: "aux error", steps: [init("cc-A"), ...toolUse("toolu_A1"), park("read", "toolu_A1"), () => settle(5), { throw: "aux subprocess died" }] });
		const aux = call(A, [...auxHead(), user("audit")], []);
		const outcome = await aux.result();
		await settle();
		assert.equal(outcome.stopReason, "error");
		assert.match(outcome.errorMessage, /aux subprocess died/);
		assert.equal(handlers.toolu_A1.settled.length, 1, "the auxiliary's own parked handler was released with its query");
		assert.equal(handlers.toolu_P1.settled.length, 0, "the parent's was not");
		assertSnapshotUnchanged(before);

		await resumeParent(parked);
	});

	it("error before any tool call, at start-up", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		scripts.push({ label: "aux boot error", steps: [{ throw: "boot failed" }] });
		const outcome = await call(A, [...auxHead(), user("audit")], []).result();
		await settle();
		assert.equal(calls.at(-1)?.label, "aux boot error", "the mocked auxiliary SDK query actually started (not a capture rejection)");
		assert.equal(calls.at(-1).append, AUDITOR_PREAMBLE);
		assert.equal(outcome.stopReason, "error");
		assert.match(outcome.errorMessage, /boot failed/, "and the error is the SDK's, not prompt-capture's");
		assertSnapshotUnchanged(before);
		await resumeParent(parked);
	});

	it("cancel while the auxiliary query is parked on its tool: only its own handlers are released", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		const controller = new AbortController();

		scripts.push({ label: "aux cancel", steps: [init("cc-A"), ...toolUse("toolu_A1"), park("read", "toolu_A1"), gate().wait] });
		const aux = call(A, [...auxHead(), user("audit")], [], controller.signal);
		await aux.result(); // pi's stream for the turn ends at its tool call; the query stays parked
		await settle();
		assert.deepEqual([...[...__test.activeQueryContexts].find((c) => c.piSessionId === A).pendingToolCalls.keys()], ["toolu_A1"]);
		controller.abort();
		await settle();
		assert.equal(handlers.toolu_A1.settled.length, 1, "its own handler was settled by the abort");
		assert.match(JSON.stringify(handlers.toolu_A1.settled[0]), /Operation aborted/);
		assert.equal(handlers.toolu_P1.settled.length, 0, "the parent's handler was not");
		assertSnapshotUnchanged(before);

		await resumeParent(parked);
	});

	it("cancel before the auxiliary query reaches a tool: the turn is aborted, the parent undisturbed", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		const controller = new AbortController();

		scripts.push({ label: "aux cancel early", steps: [init("cc-A"), gate().wait] });
		const aux = call(A, [...auxHead(), user("audit")], [], controller.signal);
		await settle();
		controller.abort();
		const outcome = await aux.result();
		assert.equal(outcome.stopReason, "aborted");
		assert.equal(handlers.toolu_P1.settled.length, 0, "the parent's handler was not released");
		assertSnapshotUnchanged(before);

		await resumeParent(parked);
	});

	it("an auxiliary query that is already cancelled when it starts cannot disturb the parent", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		const controller = new AbortController();
		controller.abort();
		scripts.push({ label: "aux pre-aborted", steps: [init("cc-A"), result("never")] });
		const outcome = await call(A, [...auxHead(), user("audit")], [], controller.signal).result();
		await settle();
		assert.equal(outcome.stopReason, "aborted");
		assertSnapshotUnchanged(before);
		await resumeParent(parked);
	});

	it("two auxiliary agents at once (an auditor and an oracle) stay apart from each other and the parent", async () => {
		const parked = await parkParent();
		const before = parentSnapshot();
		const B = "pi-oracle";
		scripts.push({ label: "aux A", steps: [init("cc-A"), ...toolUse("toolu_A1"), park("read", "toolu_A1"), answered("toolu_A1"), result("A done")] });
		scripts.push({ label: "aux B", steps: [init("cc-B"), ...toolUse("toolu_B1"), park("read", "toolu_B1"), answered("toolu_B1"), result("B done")] });
		const a = call(A, [...auxHead(), user("audit")], []);
		await settle();
		const b = call(B, [...auxHead(), user("advise")], []);
		await settle();
		// B's result arrives first; it must reach B only.
		await call(B, [...auxHead(), user("advise"), toolCall("toolu_B1"), toolResult("toolu_B1", "B_BODY")], []).result();
		await settle();
		assert.equal(handlers.toolu_B1.settled.length, 1);
		assert.equal(handlers.toolu_A1.settled.length, 0);
		await call(A, [...auxHead(), user("audit"), toolCall("toolu_A1"), toolResult("toolu_A1", "A_BODY")], []).result();
		await settle();
		assert.match(JSON.stringify(handlers.toolu_A1.settled[0]), /A_BODY/);
		assert.match(JSON.stringify(handlers.toolu_B1.settled[0]), /B_BODY/);
		await a.result(); await b.result();
		assertSnapshotUnchanged(before);
		await resumeParent(parked);
	});
});
