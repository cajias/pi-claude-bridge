/**
 * BR-AUX-1 / BR-STALE-1: the goal-worker shape of the 2026-10-10 canary, with the auditor in the middle.
 *
 * In the canary a goal worker called `update_goal` (the completion request), the bridge parked that
 * tool call, the standalone auditor ran inside it, and the worker's next checkpoint began with one
 * `mirror_stale`. That rebuild is the bridge correctly noticing that pi's history no longer begins
 * with what the mirror was recorded over — not something to suppress. These tests pin the other half:
 * the auditor's presence changes nothing about it. Per scenario, with the REAL pieces —
 *   - goal-x's own checkpoint prompt and LiveTailRetention (state/counters tails, re-inserted at their
 *     anchors on later calls, one documented full reset on a state change), converted by pi's real
 *     convertToLlm;
 *   - ACP's guardrail tag appended to a tool result;
 *   - the checkpoint arriving as a steer next to the tool result, into the parked query;
 *   - the bridge's MCP tool server, parked on the worker's `update_goal` call;
 *   - the auditor as the standalone [preamble, cwd] session (BR-AUX-1);
 * and only the SDK query() mocked:
 *   no rewrite              -> ZERO rebuilds, the same mirror resumed;
 *   mid-query tail reset    -> exactly ONE rebuild, in place, then stable;
 *   ACP tag on a settled result -> exactly ONE rebuild;
 * each identical with and without the auxiliary query in flight. No digest or mirror logic differs.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { AUDITOR_PREAMBLE, auxSections, join as joinSections, leadFixture } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-aux-retention-"));
const claudeDir = join(tmpRoot, "claude");
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const { LiveTailRetention } = await import("pi-goal-x/extensions/goal-live-retention.ts");
const { checkpointTriggerPrompt } = await import("../node_modules/pi-goal-x/extensions/prompts/goal-prompts.ts");

const DIAG = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-diag.log");
const staleLines = () => (existsSync(DIAG) ? readFileSync(DIAG, "utf8").split("\n").filter((l) => l.includes('"mirror_stale"')).length : 0);

let providerConfig;
const handlers = new Map();
activate({ on: (e, h) => handlers.set(e, h), registerProvider: (_n, c) => { providerConfig = c; }, registerTool: () => {} });
const model = providerConfig.models[0];
const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const WORKER_TOOLS = [tool("read"), tool("update_goal")];

// --- pi-side messages (the shapes the provider receives, after convertToLlm) ---
let clock = 1;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: clock++ });
const callMsg = (id, name) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: clock++ });
const resultMsg = (id, name, text) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: clock++ });
const GOAL_ID = "synthetic-goal";
const checkpoint = () => convertToLlm([{
	role: "custom", customType: "pi-goal-event", content: checkpointTriggerPrompt(GOAL_ID), display: false,
	details: { version: 2, kind: "checkpoint", goalId: GOAL_ID }, timestamp: clock++,
}])[0];
const goalContext = (retention, key, base, fresh) => convertToLlm(retention.apply(key, base, fresh).messages);
const STATE = "<goal_state>objective: canary; status: active</goal_state>";
const STATE_RESET = "<goal_state>objective: canary; status: auditing</goal_state>";
const counters = (n) => `<goal_counters>autonomous runs used: ${n}/3</goal_counters>`;
const ACP_TAG = "\n\n[ACP guardrail: you have issued 3 CONSECUTIVE identical `update_goal` calls.]";

// --- the worker's system prompt: a recorded default key, as a normal user turn leaves it ---
const lead = leadFixture();
const sys = (extra) => ({ role: "system", content: "", timestamp: 0, ...extra });
const workerHead = () => [sys({ toolsAdded: WORKER_TOOLS }), sys({ sections: lead.replay })];
const auditorHead = () => [sys({ toolsAdded: [tool("read"), tool("grep")] }), sys({ sections: auxSections(AUDITOR_PREAMBLE, "/work/synthetic-auditxxxxxxx") })];

// --- fake SDK query ---
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id, name) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${name}`, input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const done = { type: "result", subtype: "success", is_error: false, result: "ok" };
const mirrorText = (id) => { try { return JSON.stringify(openSession({ sessionId: id, projectPath: process.cwd(), claudeDir }).messages); } catch { return null; } };

const calls = [];
const scripts = [];
const parked = {};
const ids = new Set();
beforeEach(() => {
	__test.resetSharedSession();
	__test.promptCaptures.captures.clear();
	calls.length = 0;
	scripts.length = 0;
	for (const key of Object.keys(parked)) delete parked[key];
	handlers.get("before_agent_start")({
		systemPrompt: joinSections(lead.replay),
		systemPromptOptions: { contextFiles: [{ path: "/work/AGENTS.md", content: "WORKER_RULES_RECORDED" }], skills: [], selectedTools: ["read", "update_goal"] },
	});
	handlers.get("agent_start")({}, { getSystemPrompt: () => joinSections(lead.replay) });
	__test.setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const entry = { label: script.label, resume: options.resume, mirror: options.resume ? mirrorText(options.resume) : null, prompts: [], append: options.systemPrompt.append };
		calls.push(entry);
		void (async () => { for await (const m of prompt) entry.prompts.push(JSON.stringify(m.message.content)); })().catch(() => {});
		const closed = gate();
		const gen = (async function* () {
			for (const step of script.steps) {
				if (typeof step === "function") { if (await Promise.race([step().then(() => false), closed.wait().then(() => true)])) return; continue; }
				if (step.park) {
					const handler = options.mcpServers["custom-tools"].instance.server._requestHandlers.get("tools/call");
					const record = { settled: [] };
					record.promise = handler({ method: "tools/call", params: { name: step.toolName, arguments: {}, _meta: { "claudecode/toolUseId": step.toolUseId } } }, {}).then((r) => { record.settled.push(r); return r; });
					parked[step.toolUseId] = record;
					continue;
				}
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
	for (const id of ids) deleteSession(id, process.cwd(), claudeDir);
	ids.clear();
});
const park = (toolName, toolUseId) => ({ park: true, toolName, toolUseId });
const answered = (toolUseId) => () => parked[toolUseId].promise;
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const call = (sessionId, messages) => providerConfig.streamSimple(model, { messages, tools: [] }, { sessionId });

let seq = 0;
/** Settled pi history before the first checkpoint: one tool exchange and typed turns. */
const settled = () => [
	user("TYPED_ONE"), callMsg("toolu_a", "read"), resultMsg("toolu_a", "read", "FILE_BODY"), say("SAID_ONE"),
	user("TYPED_TWO"), say("SAID_TWO"),
];

/** Everything the parked worker owns; the auditor must leave all of it as it was. */
function workerSnapshot(W) {
	const ctx = [...__test.activeQueryContexts].find((c) => c.piSessionId === W);
	assert.ok(ctx, "the worker query is parked");
	const state = __test.getSharedSession(W);
	return { ctx, pending: [...ctx.pendingToolCalls.keys()], turnIds: [...ctx.turnToolCallIds], activeQuery: ctx.activeQuery, state, stateJson: JSON.stringify(state) };
}

/**
 * One goal-worker round trip. `mode`:
 *   control      no rewrite anywhere
 *   tail-reset   the query makes a second tool call; goal-x's state block changes while it is parked on
 *                it, so the tails the first delivery settled into history are dropped and fresh ones
 *                appended at the second tool-result call (a genuine rewrite under a running query)
 *   acp-tag      ACP's guardrail tag appears on the settled tool result after the mirror recorded it
 */
async function round({ mode, withAudit }) {
	const W = `pi-worker-${seq++}`, AUD = `pi-auditor-${seq++}`;
	const retention = new LiveTailRetention();
	const hist = settled();
	const ck1 = checkpoint();
	const ctx1 = goalContext(retention, W, [...hist, ck1], { state: STATE, counters: counters(1) });
	const out = { W, observations: {} };
	const stale0 = staleLines();

	// Checkpoint 1: the worker asks to complete the goal and parks on update_goal.
	const gW = gate();
	const secondCall = mode === "tail-reset" ? [...toolUse("toolu_U2", "read"), park("read", "toolu_U2"), answered("toolu_U2")] : [];
	scripts.push({ label: "worker ckpt 1", steps: [init("cc-W"), ...toolUse("toolu_U1", "update_goal"), park("update_goal", "toolu_U1"), answered("toolu_U1"), ...secondCall, gW.wait, done] });
	const first = call(W, [...workerHead(), ...ctx1]);
	await settle();
	const mirror = __test.getSharedSession(W).sessionId;
	ids.add(mirror);
	assert.deepEqual([...[...__test.activeQueryContexts].find((c) => c.piSessionId === W).pendingToolCalls.keys()], ["toolu_U1"], "precondition: parked on update_goal");
	assert.equal(staleLines(), stale0, "the first query builds its mirror without a stale event");

	// The auditor runs inside that tool call (BR-AUX-1).
	if (withAudit) {
		const before = workerSnapshot(W);
		scripts.push({ label: "auditor", steps: [init("cc-AUD"), ...toolUse("toolu_AUD1", "read"), park("read", "toolu_AUD1"), answered("toolu_AUD1"), done] });
		const audit = call(AUD, [...auditorHead(), user("Audit the claimed completion of the goal.")]);
		await audit.result();
		await settle();
		await call(AUD, [...auditorHead(), user("Audit the claimed completion of the goal."), callMsg("toolu_AUD1", "read"), resultMsg("toolu_AUD1", "read", "AUDIT_EVIDENCE")]).result();
		await settle();
		out.observations.audit = calls.find((c) => c.label === "auditor");
		const after = workerSnapshot(W);
		assert.equal(after.state, before.state, "the worker's session state object is untouched");
		assert.equal(after.stateJson, before.stateJson, "including cursor, digests and mirror id");
		assert.deepEqual(after.pending, ["toolu_U1"]);
		assert.equal(after.ctx, before.ctx);
		assert.equal(after.activeQuery, before.activeQuery);
		assert.equal(parked.toolu_U1.settled.length, 0, "the worker's call is still waiting");
		assert.equal(staleLines(), stale0, "the auditor's run is not a stale event");
	}

	// The worker's tool result arrives with the checkpoint steer beside it.
	const toolCallMsg = callMsg("toolu_U1", "update_goal");
	const stored = resultMsg("toolu_U1", "update_goal", `Goal audit rejected.${mode === "acp-tag" ? "" : ACP_TAG}`);
	const steer = checkpoint();
	const ctx2 = goalContext(retention, W, [...hist, ck1, toolCallMsg, stored, steer], { state: STATE, counters: counters(1) });
	const delivery = call(W, [...workerHead(), ...ctx2]);
	await settle();
	assert.equal(parked.toolu_U1.settled.length, 1, "the worker's handler was released exactly once");
	assert.match(JSON.stringify(parked.toolu_U1.settled[0]), /Goal audit rejected/);
	const deliveries = [delivery];
	let tail = [toolCallMsg, stored, steer];
	let fresh3 = { state: STATE, counters: counters(2) };
	if (mode === "tail-reset") {
		// Still the same parked query, on its second tool call: goal-x's state block changes, which
		// drops the retained tails (already settled into history by the first delivery) from the
		// request and appends fresh ones.
		await delivery.result(); // pi's stream for that call ends at the query's next tool call
		await settle();
		assert.deepEqual([...[...__test.activeQueryContexts].find((c) => c.piSessionId === W).pendingToolCalls.keys()], ["toolu_U2"], "parked on the second call");
		const call2 = callMsg("toolu_U2", "read"), stored2 = resultMsg("toolu_U2", "read", "SECOND_RESULT");
		tail = [...tail, call2, stored2];
		const ctx2b = goalContext(retention, W, [...hist, ck1, ...tail], { state: STATE_RESET, counters: counters(2) });
		assert.ok(!ctx2b.some((m) => m.content?.[0]?.text === STATE), "precondition: the retained tails are gone from the request");
		const delivery2 = call(W, [...workerHead(), ...ctx2b]);
		await settle();
		assert.equal(parked.toolu_U2.settled.length, 1);
		deliveries.push(delivery2);
		fresh3 = { state: STATE_RESET, counters: counters(3) };
	}
	gW.open();
	await Promise.all([first.result(), ...deliveries.map((d) => d.result())]);
	await settle();
	out.observations.worker1 = calls.find((c) => c.label === "worker ckpt 1");
	assert.ok(out.observations.worker1.prompts.length >= 2, "the checkpoint steer reached the parked query's stdin");
	assert.equal(out.observations.worker1.append.includes("WORKER_RULES_RECORDED"), true, "the worker kept its own instructions");
	assert.ok(!out.observations.worker1.append.includes(AUDITOR_PREAMBLE));

	// Checkpoint 2: a fresh query on the worker. The retained history is the same objects pi stores.
	const reply = say("REPLY_ONE");
	const ck2 = checkpoint();
	// ACP's tag reaches the stored result only after the mirror recorded it without, on this variant.
	const storedNow = mode === "acp-tag" ? { ...stored, content: [{ type: "text", text: `Goal audit rejected.${ACP_TAG}` }] } : stored;
	const tailNow = tail.map((m) => (m === stored ? storedNow : m));
	const ctx3 = goalContext(retention, W, [...hist, ck1, ...tailNow, reply, ck2], fresh3);
	for (let i = 0; i < hist.length; i++) assert.equal(ctx3[i], ctx1[i], `settled message #${i} keeps its identity across calls`);
	scripts.push({ label: "worker ckpt 2", steps: [init("cc-W"), done] });
	await call(W, [...workerHead(), ...ctx3]).result();
	await settle();
	out.observations.worker2 = calls.find((c) => c.label === "worker ckpt 2");
	out.rebuildsAtCkpt2 = staleLines() - stale0;
	out.mirror = mirror;

	// Checkpoint 3: nothing loops.
	scripts.push({ label: "worker ckpt 3", steps: [init("cc-W"), done] });
	const ctx4 = goalContext(retention, W, [...hist, ck1, ...tailNow, reply, ck2, say("REPLY_TWO"), checkpoint()], { ...fresh3, counters: counters(4) });
	await call(W, [...workerHead(), ...ctx4]).result();
	await settle();
	out.observations.worker3 = calls.find((c) => c.label === "worker ckpt 3");
	out.rebuildsTotal = staleLines() - stale0;
	return out;
}

for (const withAudit of [true, false]) {
	const label = withAudit ? "with the auditor in flight" : "control without an auditor";
	describe(`goal worker round trip (${label})`, () => {
		it("no rewrite: zero rebuilds, the same mirror resumed, the checkpoint steer in the mirror's next turn", async () => {
			const r = await round({ mode: "control", withAudit });
			assert.equal(r.rebuildsAtCkpt2, 0, "no mirror_stale");
			assert.equal(r.observations.worker2.resume, r.mirror, "resumes the worker's own mirror");
			assert.equal(r.rebuildsTotal, 0);
			assert.equal(r.observations.worker3.resume, r.mirror);
			assert.match(r.observations.worker2.prompts[0], /pi_goal_continuation/, "the new checkpoint reaches Claude Code");
			assert.match(r.observations.worker2.prompts[0], /autonomous runs used: 2\/3/, "with the new counters tail");
			if (withAudit) {
				assert.equal(r.observations.audit.append, AUDITOR_PREAMBLE, "the auditor ran on its verbatim custom prompt");
				assert.equal(r.observations.audit.resume, undefined, "on a conversation of its own");
				assert.ok(!r.observations.worker2.mirror.includes("AUDIT_EVIDENCE"), "its tool results never entered the worker's mirror");
			}
		});

		it("mid-query retained-tail reset: exactly one rebuild, in place, then stable", async () => {
			const r = await round({ mode: "tail-reset", withAudit });
			assert.equal(r.rebuildsAtCkpt2, 1, "exactly one mirror_stale for the genuine rewrite");
			assert.equal(r.observations.worker2.resume, r.mirror, "rebuilt in place: the same mirror id, not a history-less start");
			assert.match(r.observations.worker2.mirror, /SAID_TWO/, "the rebuilt mirror holds the settled history");
			assert.match(r.observations.worker2.mirror, /Goal audit rejected/, "tool result included");
			assert.equal(r.rebuildsTotal, 1, "and the next checkpoint does not rebuild again");
			assert.equal(r.observations.worker3.resume, r.mirror);
			if (withAudit) assert.ok(!r.observations.worker2.mirror.includes("AUDIT_EVIDENCE"));
		});

		it("an ACP tag appearing on a settled tool result: exactly one rebuild", async () => {
			const r = await round({ mode: "acp-tag", withAudit });
			assert.equal(r.rebuildsAtCkpt2, 1);
			assert.equal(r.observations.worker2.resume, r.mirror);
			assert.match(r.observations.worker2.mirror, /ACP guardrail/, "the rebuilt mirror carries the tag pi now stores");
			assert.equal(r.rebuildsTotal, 1);
		});
	});
}
