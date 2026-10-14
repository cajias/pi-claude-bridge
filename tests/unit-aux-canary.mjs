/**
 * Sanitized synthetic checkpoint sequence: a parked worker receives a checkpoint steer,
 * makes two completion requests with standalone auditors, then starts a new checkpoint.
 * Tails are modelled with real LiveTailRetention, NOT an exact live canary reconstruction.
 * The mid-query reset yields recorded 14 / priors 16 / cursor 15 (one rebuild); the
 * no-reset control yields zero rebuilds. Neighbouring patterns show the fit is not unique.
 * All session/tool/goal ids and non-public message text are synthetic.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession } from "cc-session-io";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { AUDITOR_PREAMBLE, auxSections, join as joinSections, leadFixture } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-aux-canary-"));
const claudeDir = join(tmpRoot, "claude");
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const { LiveTailRetention } = await import("pi-goal-x/extensions/goal-live-retention.ts");

const DIAG = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-diag.log");
const staleEvents = () => (existsSync(DIAG) ? readFileSync(DIAG, "utf8").split("\n").filter((l) => l.includes('"mirror_stale"')).map((l) => JSON.parse(l)) : []);

let providerConfig;
const handlers = new Map();
activate({ on: (e, h) => handlers.set(e, h), registerProvider: (_n, c) => { providerConfig = c; }, registerTool: () => {} });
const model = providerConfig.models[0];

// --- the canary's messages, as the provider receives them (pi's real convertToLlm) ---
const fixture = JSON.parse(readFileSync(new URL("./fixtures/goal-canary-sequence.json", import.meta.url), "utf8"));
let clock = 1;
const msgs = {};
for (const e of fixture.entries) {
	const timestamp = clock++;
	if (e.kind === "custom") msgs[e.entry] = convertToLlm([{ role: "custom", customType: e.customType, content: e.content, display: false, timestamp }])[0];
	else if (e.kind === "user") msgs[e.entry] = { role: "user", content: e.content, timestamp };
	else if (e.kind === "assistant") msgs[e.entry] = { role: "assistant", content: e.content, timestamp };
	else msgs[e.entry] = { role: "toolResult", toolCallId: e.toolCallId, toolName: e.toolName, content: e.content, isError: e.isError, timestamp };
}
const callId = (entry) => msgs[entry].content.find((b) => b.type === "toolCall").id;
const [U1, U2, U3] = [callId(15), callId(19), callId(23)];

const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const lead = leadFixture();
const sys = (x) => ({ role: "system", content: "", timestamp: 0, ...x });
const workerHead = () => [sys({ toolsAdded: [tool("read"), tool("update_goal")] }), sys({ sections: lead.replay })];
const auditorHead = () => [sys({ toolsAdded: [tool("read")] }), sys({ sections: auxSections(AUDITOR_PREAMBLE, "/work/synthetic-auditxxxxxxx") })];

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
let strayQueries = 0;
const trapQuery = () => { strayQueries++; throw new Error("unexpected real SDK query outside a mocked test"); };
after(() => assert.equal(strayQueries, 0, "no SDK query outside the mocked ones"));

const calls = [];
const scripts = [];
const parked = {};
const ids = new Set();
beforeEach(() => {
	rmSync(DIAG, { force: true });
	__test.resetSharedSession();
	__test.promptCaptures.captures.clear();
	calls.length = 0;
	scripts.length = 0;
	for (const key of Object.keys(parked)) delete parked[key];
	handlers.get("before_agent_start")({
		systemPrompt: joinSections(lead.replay),
		systemPromptOptions: { contextFiles: [{ path: "/work/AGENTS.md", content: "WORKER_RULES" }], skills: [], selectedTools: ["read", "update_goal"] },
	});
	handlers.get("agent_start")({}, { getSystemPrompt: () => joinSections(lead.replay) });
	__test.setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const entry = { label: script.label, resume: options.resume, append: options.systemPrompt.append, prompts: [] };
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
afterEach(() => {
	__test.setQuery(trapQuery);
	for (const c of [...__test.activeQueryContexts]) { c.releasePendingToolCalls("test cleanup"); __test.activeQueryContexts.delete(c); }
	for (const id of ids) deleteSession(id, process.cwd(), claudeDir);
	ids.clear();
});
const park = (toolName, toolUseId) => ({ park: true, toolName, toolUseId });
const answered = (toolUseId) => () => parked[toolUseId].promise;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * One replay of the canary. `tails` says, per provider call B..F (checkpoint 1, the checkpoint-2 steer, the
 * two tool-result calls, checkpoint 3), whether goal-x's counters block and its state block changed.
 */
async function replay({ tails, withAudit }) {
	calls.length = 0;
	for (const key of Object.keys(parked)) delete parked[key];
	const W = "pi-canary-worker";
	const retention = new LiveTailRetention();
	let counters = 0, state = 0, step = 0;
	const request = (entries) => {
		const spec = tails[step++];
		if (spec.counters) counters++;
		if (spec.state) state++;
		return [...workerHead(), ...convertToLlm(retention.apply(W, entries.map((i) => msgs[i]), { state: `<goal_state>canary rev ${state}</goal_state>`, counters: `<goal_counters>used ${counters}/3</goal_counters>` }).messages)];
	};
	const call = (messages, sessionId = W) => providerConfig.streamSimple(model, { messages, tools: [] }, { sessionId });
	const out = { W };

	// Setup turn: no goal yet, so no tails.
	scripts.push({ label: "setup", steps: [init("cc-W"), done] });
	await call([...workerHead(), msgs[5], msgs[6], msgs[9]]).result();
	await settle();
	ids.add(__test.getSharedSession(W).sessionId);

	// Checkpoint 1: update_goal "ready". pi ends the run on that result (terminate) - no provider call follows it.
	// The same query then takes checkpoint 2 as a steer beside that result, and makes both completion requests.
	const hold = gate();
	scripts.push({
		label: "worker query",
		steps: [init("cc-W"),
			...toolUse(U1, "update_goal"), park("update_goal", U1), answered(U1),
			...toolUse(U2, "update_goal"), park("update_goal", U2), answered(U2),
			...toolUse(U3, "update_goal"), park("update_goal", U3), answered(U3),
			hold.wait, done],
	});
	const b = call(request([5, 6, 9, 10, 14]));
	await settle();
	out.mirror = __test.getSharedSession(W).sessionId;
	assert.deepEqual([...[...__test.activeQueryContexts].find((c) => c.piSessionId === W).pendingToolCalls.keys()], [U1], "parked on checkpoint 1's update_goal");

	// Checkpoint 2: pi's context ends with the stored result of that call plus the new checkpoint (and tails).
	const c = call(request([5, 6, 9, 10, 14, 15, 16, 18]));
	await settle();
	assert.equal(parked[U1].settled.length, 1, "checkpoint 1's result was delivered to the parked query, which did not start a second one");
	assert.equal(calls.filter((x) => x.label === "worker query").length, 1);
	assert.match(calls[1].prompts.at(-1), /pi_goal_continuation/, "the checkpoint-2 steer went into the parked query's stdin");

	// The completion request(s): the standalone auditor runs inside the parked update_goal call.
	const audit = async (n) => {
		scripts.push({ label: `auditor ${n}`, steps: [init(`cc-AUD${n}`), ...toolUse(`toolu_AUD${n}`, "read"), park("read", `toolu_AUD${n}`), answered(`toolu_AUD${n}`), done] });
		const A = `pi-canary-auditor-${n}`;
		const prompt = { role: "user", content: "Audit the claimed completion of the goal.", timestamp: clock++ };
		const first = call([...auditorHead(), prompt], A);
		await first.result();
		await settle();
		await call([...auditorHead(), prompt, { role: "assistant", content: [{ type: "toolCall", id: `toolu_AUD${n}`, name: "read", arguments: {} }], timestamp: clock++ }, { role: "toolResult", toolCallId: `toolu_AUD${n}`, toolName: "read", content: [{ type: "text", text: "AUDIT_EVIDENCE" }], isError: false, timestamp: clock++ }], A).result();
		await settle();
	};
	if (withAudit) await audit(1);
	const d = call(request([5, 6, 9, 10, 14, 15, 16, 18, 19, 20]));
	await settle();
	if (withAudit) await audit(2);
	const e = call(request([5, 6, 9, 10, 14, 15, 16, 18, 19, 20, 23, 24]));
	await settle();
	hold.open();
	await Promise.all([b.result(), c.result(), d.result(), e.result()]);
	await settle();
	assert.equal(parked[U2].settled.length, 1);
	assert.equal(parked[U3].settled.length, 1);
	assert.equal(staleEvents().length, 0, "nothing is stale while the query runs");
	out.worker = calls.find((x) => x.label === "worker query");

	// Checkpoint 3, after the final text and the four audit-event messages.
	scripts.push({ label: "checkpoint 3", steps: [init(out.mirror), done] });
	await call(request([5, 6, 9, 10, 14, 15, 16, 18, 19, 20, 23, 24, 26, 27, 28, 29, 30, 32])).result();
	await settle();
	out.ckpt3 = calls.at(-1);
	out.stale = staleEvents();
	return out;
}

/** The assumed tail pattern (see the header): [B checkpoint 1, C steer, D result 1, E result 2, F checkpoint 3]. */
const CHANGED = { counters: true, state: false }, SAME = { counters: false, state: false }, RESET = { counters: true, state: true };
const PATTERN_RESET = [CHANGED, SAME, RESET, CHANGED, SAME];
const PATTERN_CONTROL = [CHANGED, SAME, CHANGED, CHANGED, SAME]; // identical, minus the state change at D

for (const withAudit of [true, false]) {
	describe(`canary replay (${withAudit ? "standalone auditor inside each completion request" : "control without an auditor"})`, () => {
		it("goal-x resets its retained tails mid-query: exactly one mirror_stale, with the canary's numbers, rebuilt in place", async () => {
			const r = await replay({ tails: PATTERN_RESET, withAudit });
			assert.equal(r.stale.length, 1, "exactly one rebuild");
			const { label, sessionId, recorded, priors, cursor, writerActive } = r.stale[0];
			assert.deepEqual({ label, recorded, priors, cursor, writerActive }, { label: "mirror_stale", recorded: 14, priors: 16, cursor: 15, writerActive: false },
				"the canary's diag line: recorded 14 / priors 16 / cursor 15, no writer");
			assert.equal(sessionId, r.mirror);
			assert.equal(r.ckpt3.resume, r.mirror, "rebuilt in place under the same id, not started history-less");
			assert.match(r.ckpt3.prompts[0], /pi_goal_continuation/);
			if (withAudit) {
				assert.equal(calls.find((x) => x.label === "auditor 1").append, AUDITOR_PREAMBLE, "the auditor ran on its verbatim custom prompt");
				assert.equal(calls.find((x) => x.label === "auditor 1").resume, undefined);
			}
		});

		it("control, identical but for the state change: zero mirror_stale, the same mirror resumed", async () => {
			const r = await replay({ tails: PATTERN_CONTROL, withAudit });
			assert.equal(r.stale.length, 0);
			assert.equal(r.ckpt3.resume, r.mirror);
		});
	});
}

describe("canary replay: the fit is not unique, and the tests say which assumption they rest on", () => {
	it("neighbouring tail patterns (counters also moving at the steer call or at checkpoint 3) give the same diag line", async () => {
		for (const tails of [[CHANGED, CHANGED, RESET, CHANGED, SAME], [CHANGED, SAME, RESET, CHANGED, CHANGED], [CHANGED, CHANGED, RESET, CHANGED, CHANGED]]) {
			rmSync(DIAG, { force: true });
			__test.resetSharedSession();
			const r = await replay({ tails, withAudit: false });
			assert.equal(r.stale.length, 1, JSON.stringify(tails) + JSON.stringify(r.stale));
			const { recorded, priors, cursor, writerActive } = r.stale[0];
			assert.deepEqual({ recorded, priors, cursor, writerActive }, { recorded: 14, priors: 16, cursor: 15, writerActive: false });
		}
	});
});
