/**
 * The Extension goal-x checkpoint shape, end to end through streamSimple with a mocked SDK query.
 *
 * pi-goal-x sends its checkpoint with sendMessage({triggerTurn}) on an idle session, so the turn
 * skips before_agent_start (pi#5581) and the provider gets the transcript's stored sections: here
 * they carry an `agent_browser` extension section that no forced prompt (the only recorded key)
 * had, diverging at the cwd boundary. The context also ends in goal-x's request-only tails.
 *
 * Messages are built with the real code, not hand-written look-alikes:
 *   - the checkpoint: goal-x's own checkpointTriggerPrompt, converted by pi's convertToLlm
 *     (a custom message reaches the provider as a user message);
 *   - the state/counters tails: goal-x's real LiveTailRetention (the `context` hook's engine),
 *     which re-inserts previously sent tails at their anchors, then convertToLlm.
 * The bridge therefore sees exactly the trailing user runs and mid-history user messages that
 * produced the cursor arithmetic worth pinning.
 *
 * KNOWN FINDING, pre-existing in 0.9.1 and unchanged by the patch: with >= 2 per-call user notices
 * that pi never stores (ACP nudge + herdsman notice, unlike goal-x's retained tails) trailing a
 * call, the cursor counts them and the next call's history is shorter than the cursor, so that
 * turn runs history-less. Pinned in its own block as a characterization: it must pass identically
 * on unpatched 0.9.1 (verify.sh checks this) and be flipped when someone fixes it.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { extensionFixture, join as joinSections } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-goal-checkpoint-"));
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
const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };

// --- pi-side messages, in the shape the provider receives (after convertToLlm) ---
let clock = 1;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: clock++ });
const call = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "x" } }], timestamp: clock++ });
const toolResult = (id, text = "file") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: clock++ });
const GOAL_ID = "synthetic-goal";
const checkpoint = () => convertToLlm([{
	role: "custom", customType: "pi-goal-event", content: checkpointTriggerPrompt(GOAL_ID), display: false,
	details: { version: 2, kind: "checkpoint", goalId: GOAL_ID }, timestamp: clock++,
}])[0];

/** What goal-x's context hook does per provider request: retained tails + only new content. */
function goalContext(retention, key, base, fresh) {
	return convertToLlm(retention.apply(key, base, fresh).messages);
}
const STATE = "<goal_state>objective: test objective; status: active</goal_state>";
const counters = (n) => `<goal_counters>autonomous runs used: ${n}</goal_counters>`;

// --- Extension system prompt: stored sections carry the stale agent_browser section ---
const f = extensionFixture();
const sys = (extra) => ({ role: "system", content: "", timestamp: 0, ...extra });
const head = () => [sys({ toolsAdded: [readTool] }), sys({ sections: f.replay })];
const BROWSER = /BROWSER_RULES/;

// --- fake SDK query: records resume target, the mirror at start, and every prompt written to stdin ---
const mirrorText = (id) => { try { return JSON.stringify(openSession({ sessionId: id, projectPath: process.cwd(), claudeDir }).messages); } catch { return null; } };
const calls = [];
let appendSent;
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const done = { type: "result", subtype: "success", is_error: false, result: "ok" };
const ids = new Set();

beforeEach(() => {
	__test.resetSharedSession();
	calls.length = 0;
	appendSent = undefined;
	__test.setQuery(({ prompt, options }) => {
		const entry = { resume: options.resume, mirror: options.resume ? mirrorText(options.resume) : null, prompts: [] };
		calls.push(entry);
		appendSent = options.systemPrompt.append;
		void (async () => { for await (const m of prompt) entry.prompts.push(JSON.stringify(m.message.content)); })().catch(() => {});
		const gen = (async function* () {
			yield init(options.resume ?? "cc-new");
			yield done;
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => {
	__test.setQuery(null);
	for (const id of ids) deleteSession(id, process.cwd(), claudeDir);
	ids.clear();
});

let seq = 0;
const piSession = () => `pi-goal-${seq++}`;
async function turn(sessionId, messages) {
	const result = await providerConfig.streamSimple(model, { messages, tools: [] }, { sessionId }).result();
	await new Promise((r) => setTimeout(r, 10));
	const state = __test.getSharedSession(sessionId);
	if (state) ids.add(state.sessionId);
	return result;
}

/** Settled pi history before the first checkpoint: one tool exchange and three typed turns. */
const settled = () => [
	user("TYPED_ONE"), call("toolu_a"), toolResult("toolu_a", "FILE_BODY"), say("SAID_ONE"),
	user("TYPED_TWO"), say("SAID_TWO"), user("TYPED_THREE"), say("SAID_THREE"),
];

before(() => {
	// The only key this process recorded: the forced prompt (extension's), with real options.
	handlers.get("before_agent_start")({
		systemPrompt: f.forced,
		systemPromptOptions: { contextFiles: [{ path: "/work/AGENTS.md", content: "RECORDED_FORCED_RULES" }], skills: [], selectedTools: ["read"] },
	});
	handlers.get("agent_start")({}, { getSystemPrompt: () => f.forced });
});

describe("goal-x checkpoint turn with a stale agent_browser section (Extension)", () => {
	it("precondition: the stored prompt diverges from the only recorded key at the cwd boundary", () => {
		const replay = joinSections(f.replay);
		assert.equal(replay.length, 152_327);
		assert.equal(__test.promptCaptures.resolve(replay), undefined);
		assert.equal(f.divergesAt, 117_771, "cwd ends at 117,769, agent_browser starts two chars (the separator) later");
	});

	it("resolves by replay: forwards project_context + skills, and the #153 agent_browser section", async () => {
		const retention = new LiveTailRetention();
		const sid = piSession();
		const base = [...settled(), checkpoint()];
		const result = await turn(sid, [...head(), ...goalContext(retention, sid, base, { state: STATE, counters: counters(1) })]);

		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, /EXTENSION_RULES/, "the replay's own project context");
		assert.match(appendSent, /SKILL_EXTENSION_RULES/);
		assert.match(appendSent, BROWSER, "#153 custom sections survive the replay route");
		assert.doesNotMatch(appendSent, /RECORDED_FORCED_RULES/, "not the forced key's options: the replay is what the provider got");
		assert.equal(__test.promptCaptures.resolve(joinSections(f.replay)).source, "replay");
		assert.equal(__test.promptCaptures.resolve(f.forced).contextFiles[0].content, "RECORDED_FORCED_RULES", "the recorded key is untouched");
	});

	it("two consecutive checkpoint calls: tails reach Claude Code, history intact, one mirror, no mirror_stale", async () => {
		const retention = new LiveTailRetention();
		const sid = piSession();
		const before = staleLines();
		const hist = settled();

		// Call 1: first checkpoint after a restart. Trailing run = checkpoint + state + counters.
		const ck1 = checkpoint();
		await turn(sid, [...head(), ...goalContext(retention, sid, [...hist, ck1], { state: STATE, counters: counters(1) })]);
		const mirror = __test.getSharedSession(sid).sessionId;
		assert.match(calls[0].prompts[0], /pi_goal_continuation/, "the checkpoint reaches Claude Code");
		assert.match(calls[0].prompts[0], /goal_state/, "state tail delivered");
		assert.match(calls[0].prompts[0], /autonomous runs used: 1/, "counters tail delivered");
		const built = mirrorText(mirror);
		for (const marker of ["TYPED_ONE", "FILE_BODY", "SAID_THREE"]) assert.match(built, new RegExp(marker), `mirror holds ${marker}`);

		// Call 2: the reply is now history, the retained tails sit mid-history at their anchor, counters moved.
		const reply = say("REPLY_ONE");
		const ck2 = checkpoint();
		const ctx2 = goalContext(retention, sid, [...hist, ck1, reply, ck2], { state: STATE, counters: counters(2) });
		const tailsMid = ctx2.slice(hist.length + 1, hist.length + 3).map((m) => m.content[0].text);
		assert.deepEqual(tailsMid, [STATE, counters(1)], "real retention re-inserts the first call's tails at their anchor");
		await turn(sid, [...head(), ...ctx2]);

		assert.equal(calls[1].resume, mirror, "resumes the same mirror");
		assert.equal(staleLines(), before, "no mirror_stale: retained tails are not a history rewrite");
		assert.match(calls[1].prompts[0], /autonomous runs used: 2/, "the new counters tail is delivered");
		assert.doesNotMatch(calls[1].prompts[0], /autonomous runs used: 1/, "and only as the trailing prompt, not duplicated into it");
		assert.equal(__test.getSharedSession(sid).cursor, ctx2.length, "cursor counts the full context, as in 0.9.1");

		// Call 3: confirms there is no loop or drift on the turn after that.
		const ctx3 = goalContext(retention, sid, [...hist, ck1, reply, ck2, say("REPLY_TWO"), checkpoint()], { state: STATE, counters: counters(3) });
		await turn(sid, [...head(), ...ctx3]);
		assert.equal(calls[2].resume, mirror);
		assert.equal(staleLines(), before, "still no mirror_stale on the third call");
		assert.match(calls[2].prompts[0], /autonomous runs used: 3/);
	});

	it("unchanged counters append nothing: the second checkpoint is the only trailing message", async () => {
		const retention = new LiveTailRetention();
		const sid = piSession();
		const before = staleLines();
		const hist = settled();
		const ck1 = checkpoint();
		await turn(sid, [...head(), ...goalContext(retention, sid, [...hist, ck1], { state: STATE, counters: counters(1) })]);
		const mirror = __test.getSharedSession(sid).sessionId;
		await turn(sid, [...head(), ...goalContext(retention, sid, [...hist, ck1, say("REPLY_ONE"), checkpoint()], { state: STATE, counters: counters(1) })]);
		assert.equal(calls[1].resume, mirror);
		assert.equal(staleLines(), before);
	});

	it("a goal-x reset (state block changed) rewrites the retained tails: exactly one rebuild, then stable", async () => {
		const retention = new LiveTailRetention();
		const sid = piSession();
		const before = staleLines();
		const hist = settled();
		const ck1 = checkpoint();
		await turn(sid, [...head(), ...goalContext(retention, sid, [...hist, ck1], { state: STATE, counters: counters(1) })]);
		const mirror = __test.getSharedSession(sid).sessionId;
		const reply = say("REPLY_ONE");
		const ck2 = checkpoint();
		await turn(sid, [...head(), ...goalContext(retention, sid, [...hist, ck1, reply, ck2], { state: STATE, counters: counters(2) })]);
		assert.equal(staleLines(), before);

		// The goal's state changes: goal-x drops every retained tail from history and appends fresh ones at the end.
		const STATE2 = "<goal_state>objective: test objective; status: paused-by-user</goal_state>";
		// Same message objects on later calls, as pi replays its stored entries: goal-x fingerprints whole messages.
		const reply2 = say("REPLY_TWO");
		const ck3 = checkpoint();
		const ctx3 = goalContext(retention, sid, [...hist, ck1, reply, ck2, reply2, ck3], { state: STATE2, counters: counters(3) });
		assert.ok(!ctx3.some((m) => m.content?.[0]?.text === STATE), "precondition: the old tails are gone from history");
		await turn(sid, [...head(), ...ctx3]);
		assert.equal(staleLines(), before + 1, "exactly one mirror_stale for the genuine history change");
		assert.equal(calls[2].resume, mirror, "rebuilt in place (same id), not a history-less start");
		assert.match(calls[2].mirror, /SAID_THREE/, "and the rebuilt mirror still holds the settled history");
		assert.match(calls[2].prompts[0], /paused-by-user/);

		// The next call after the reset is stable again.
		const ctx4 = goalContext(retention, sid, [...hist, ck1, reply, ck2, reply2, ck3, say("REPLY_THREE"), checkpoint()], { state: STATE2, counters: counters(4) });
		await turn(sid, [...head(), ...ctx4]);
		assert.equal(calls[3].resume, mirror);
		assert.equal(staleLines(), before + 1, "no second rebuild: the reset does not loop");
	});
});

describe("KNOWN FINDING (pre-existing in 0.9.1, identical on baseline): >= 2 unstored trailing notices", () => {
	// Not goal-x's tails (those are retained, hence stored in place). ACP's nudge and herdsman's
	// retired-context notice are appended per call and never stored.
	const NOTICE = (n) => user(`<notice ${n}>per-call extension context</notice>`);

	// Prompt capture is not under test here and unpatched 0.9.1 cannot resolve a replay: record the
	// stored prompt as a normal key, so both versions reach mirror sync and the cursor arithmetic.
	before(() => {
		handlers.get("before_agent_start")({
			systemPrompt: joinSections(f.replay),
			systemPromptOptions: { contextFiles: [{ path: "/work/AGENTS.md", content: "NOTICE_BLOCK_RULES" }], skills: [], selectedTools: ["read"] },
		});
	});

	it("one trailing notice is harmless: the next turn resumes the mirror", async () => {
		const sid = piSession();
		const before = staleLines();
		const hist = settled();
		await turn(sid, [...head(), ...hist, user("ASK_ONE"), NOTICE(1)]);
		const mirror = __test.getSharedSession(sid).sessionId;
		await turn(sid, [...head(), ...hist, user("ASK_ONE"), say("ANSWER_ONE"), user("ASK_TWO"), NOTICE(1)]);
		assert.equal(calls[1].resume, mirror);
		assert.equal(staleLines(), before);
	});

	it("two trailing notices push the cursor past the next call's history: that turn runs history-less", async () => {
		const sid = piSession();
		const before = staleLines();
		const hist = settled();
		await turn(sid, [...head(), ...hist, user("ASK_ONE"), NOTICE(1), NOTICE(2)]);
		assert.equal(__test.getSharedSession(sid).cursor, hist.length + 3, "the cursor counted both notices");
		await turn(sid, [...head(), ...hist, user("ASK_ONE"), say("ANSWER_ONE"), user("ASK_TWO"), NOTICE(1), NOTICE(2)]);
		// Pinned as observed on 0.9.1 and the patch alike. A fix would resume (or rebuild) here instead:
		// then flip this to assert calls[1].resume is a mirror holding hist, and drop the KNOWN label.
		assert.equal(calls[1].resume, undefined, "KNOWN: no resume, the turn runs without the conversation");
		assert.equal(staleLines(), before, "and it is not a mirror_stale event (digests agree; the count does not)");
	});
});
