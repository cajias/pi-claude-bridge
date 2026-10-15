/**
 * A Claude Code mirror is resumed only while it still holds what pi's history says.
 *
 * Field incident (ACP `compress`, 16:05Z): the mirror held ~3,100 messages (1.2M tokens) while
 * pi's own view, after the extension compressed it, was ~47. `compress` is not a pi compaction,
 * so no session_compact marked the mirror. The compress tool ran inside a history-less
 * ("preserve") query — its context was shorter than the mirror's cursor — and the tool-result
 * path lowered the mirror's cursor to that query's 46 messages although the query never wrote
 * to the mirror. The next turn (48 messages: 46 + the trailing assistant + the checkpoint)
 * then looked like a one-message continuation of a 3,100-message mirror and resumed it; the
 * API refused it (1,198,519 > 1,000,000 tokens).
 *
 * Two independent guards, each pinned here:
 *   1. a history-less query leaves the mirror's cursor alone (QueryContext.preservesMirror);
 *   2. the mirror records content digests of what it holds, so a resume needs the incoming
 *      history to begin with exactly those messages — same-length rewrites and compressed
 *      histories rebuild instead of resuming.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { QueryContext, ctx } from "../src/query-state.js";
import { priorDigests } from "../src/priors-fingerprint.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-mirror-guard-"));
const claudeDir = join(tmpRoot, "claude");
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const DIAG = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-diag.log");
const staleLines = () => (existsSync(DIAG) ? readFileSync(DIAG, "utf8").split("\n").filter((l) => l.includes('"mirror_stale"')).length : 0);

let providerConfig;
activate({ on: () => {}, registerProvider: (_n, c) => { providerConfig = c; }, registerTool: () => {} });
const model = providerConfig.models[0];
const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };

// --- pi-side message builders ---
let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const say = (text, meta = {}) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: clock++, ...meta });
const call = (id, args = { path: "x" }) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }], timestamp: clock++ });
const result = (id, text = "file") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: clock++ });
/** user, assistant, user, assistant, … ending on an assistant message. */
const conversation = (n, tag) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`${tag}_${i}`) : say(`${tag}_${i}`)));

// --- mirror inspection ---
const cwdOf = () => process.cwd();
const mirrorText = (sessionId) => {
	try { return JSON.stringify(openSession({ sessionId, projectPath: cwdOf(), claudeDir }).messages); } catch { return null; }
};

// --- fake SDK query (same shape as unit-cross-session-turns) ---
const calls = [];
const scripts = [];
let promptDrainGate;
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const done = (text = "ok") => ({ type: "result", subtype: "success", is_error: false, result: text });

const settle = () => new Promise((r) => setTimeout(r, 20));
const ids = new Set();
beforeEach(() => {
	__test.resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	promptDrainGate = null;
	__test.setQuery(({ prompt, options }) => {
		// Drain the input like the SDK's pump does: a steer's ack resolves only once it is read.
		const drainGate = promptDrainGate;
		void (async () => {
			for await (const msg of prompt) {
				if (msg.priority === "next" && drainGate) await drainGate.wait();
			}
		})().catch(() => {});
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		// What the resumed mirror held when this query started.
		calls.push({ resume: options.resume, mirror: options.resume ? mirrorText(options.resume) : null });
		const gen = (async function* () {
			for (const step of script) {
				if (typeof step === "function") { await step(); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => {
	__test.setQuery(null);
	for (const id of ids) deleteSession(id, cwdOf(), claudeDir);
	ids.clear();
	__test.activeQueryContexts.clear();
});

const stream = (sessionId, messages) =>
	providerConfig.streamSimple(model, { messages, tools: [readTool] }, sessionId === null ? {} : { sessionId });
const stateOf = (sessionId) => {
	const state = __test.getSharedSession(sessionId);
	if (state) ids.add(state.sessionId);
	return state;
};

/** One plain turn: a query that answers without calling a tool. */
async function plainTurn(sessionId, messages) {
	scripts.push([init("cc-plain"), done()]);
	await stream(sessionId, messages).result();
	stateOf(sessionId);
}

/** A turn whose query calls a tool; `resultMessages` is the context pi hands back with the
 *  tool's result — which an extension may have rewritten (ACP's compress). */
async function toolTurn(sessionId, firstMessages, resultMessages) {
	const g = gate();
	scripts.push([init("cc-tool"), ...toolUse("toolu_1"), g.wait, done()]);
	await stream(sessionId, firstMessages).result();
	const second = stream(sessionId, resultMessages);
	g.open();
	await second.result();
	stateOf(sessionId);
}

describe("the compress incident: a history-less query must not lower the mirror's cursor", () => {
	// Scaled from 3,100 mirror messages / 46 at the tool result / 48 at the checkpoint.
	const OLD = conversation(120, "OLD");

	/** Run the whole incident on `sessionId` and return what the checkpoint turn resumed. */
	async function incident(sessionId, view) {
		await plainTurn(sessionId, [...OLD, user("first")]);
		const seeded = stateOf(sessionId);
		assert.equal(seeded.cursor, 121);
		assert.match(mirrorText(seeded.sessionId), /OLD_119/, "precondition: the mirror holds the long history");

		// ACP has compressed pi's view: 46 messages, far shorter than the mirror's cursor.
		const prefix = [...view, user("go")];
		const withCall = [...prefix, call("toolu_1")];
		const atToolResult = [...withCall, result("toolu_1")];
		assert.equal(atToolResult.length, 46, "the incident's tool-result continuation had 46 messages");
		await toolTurn(sessionId, prefix, atToolResult);

		assert.equal(__test.getSharedSession(sessionId).cursor, 121,
			"the history-less query never wrote to the mirror, so its 46 messages say nothing about it");

		// The checkpoint turn: those 46, the assistant's reply, and the new user prompt = 48.
		const checkpoint = [...atToolResult, say("reply"), user("checkpoint")];
		assert.equal(checkpoint.length, 48);
		scripts.push([init("cc-checkpoint"), done()]);
		await stream(sessionId, checkpoint).result();
		return { seeded, resumed: calls.at(-1) };
	}

	it("unattributed callers (the shared \"(none)\" mirror, no digests): the checkpoint starts clean instead of resuming the stale mirror", async () => {
		const { resumed } = await incident(null, [...conversation(42, "VIEW"), say("VIEW_42")]);
		assert.equal(resumed.resume, undefined, "a 1.2M-token mirror was resumed here before the fix");
	});

	it("an attributed mirror whose recorded digests are a prefix of the shrunken view: the cursor still holds", async () => {
		const sessionId = "pi-prefix-intact";
		// The shrunken view keeps pi's first messages, so the digests alone would not object:
		// make that the case by recording only that prefix (a mirror that outgrew its record).
		await plainTurn(sessionId, [...OLD, user("first")]);
		const state = stateOf(sessionId);
		__test.setSharedSession(sessionId, { ...state, priorDigests: state.priorDigests.slice(0, 3) });

		const view = [...OLD.slice(0, 3), ...conversation(40, "VIEW")];
		const prefix = [...view, user("go")];
		const atToolResult = [...prefix, call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, prefix, atToolResult);
		assert.equal(__test.getSharedSession(sessionId).cursor, 121, "cursor untouched by the history-less query");

		scripts.push([init("cc-checkpoint"), done()]);
		await stream(sessionId, [...atToolResult, say("reply"), user("checkpoint")]).result();
		assert.equal(calls.at(-1).resume, undefined, "no resume of a mirror that holds 121 messages pi no longer has");
	});

	it("a query that runs on the mirror still advances its cursor on tool results", async () => {
		const sessionId = "pi-grows";
		const base = conversation(10, "GROW");
		await plainTurn(sessionId, [...base, user("first")]);
		const prefix = [...base, user("first"), say("a1"), user("go")];
		const atToolResult = [...prefix, call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, prefix, atToolResult);
		assert.equal(__test.getSharedSession(sessionId).cursor, atToolResult.length);
	});
});

describe("QueryContext.preservesMirror", () => {
	it("is set for a history-less query (unattributed mirror: count-only) and cleared for one that runs on the mirror", async () => {
		await plainTurn(null, [...conversation(20, "F"), user("x")]);
		const g = gate();

		scripts.push([init("cc-short"), ...toolUse("toolu_1"), g.wait, done()]);
		await stream(null, [user("only"), say("a"), user("short view")]).result();
		assert.equal(ctx().preservesMirror, true, "a shorter view starts a history-less query");
		g.open();
		await settle();

		scripts.push([init("cc-long"), done()]);
		await stream(null, [...conversation(20, "F"), user("x"), say("y"), user("z")]).result();
		await settle();
		assert.equal(ctx().preservesMirror, false, "the next query on the mirror resets the flag");
	});
});

describe("syncSharedSession mirror digests", () => {
	let cwd;
	const PI = "pi-session-A";
	const sync = (history) => __test.syncSharedSession(history, cwd, undefined, undefined, PI);
	const text = (sessionId) => JSON.stringify(openSession({ sessionId, projectPath: cwd, claudeDir }).messages);
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "sync-digests-")); });
	afterEach(() => {
		const state = __test.getSharedSession(PI);
		if (state) deleteSession(state.sessionId, cwd, claudeDir);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("resumes while the priors are unchanged, whatever their metadata", () => {
		const priors = [user("a"), say("b"), call("t1", { path: "x" }), result("t1", "SECRET")];
		const first = sync([...priors, user("go")]);
		const before = staleLines();
		const rerendered = priors.map((m) => ({ ...m, timestamp: m.timestamp + 1000, usage: { input: 9, output: 3 } }));
		const second = sync([...rerendered, user("go again")]);
		assert.equal(second.sessionId, first.sessionId);
		assert.equal(staleLines(), before, "no rebuild for a re-render of the same conversation");
	});

	it("rebuilds when a tool result is rewritten at the same length (redaction)", () => {
		const first = sync([user("a"), say("b"), call("t1"), result("t1", "SECRET"), user("go")]);
		assert.match(text(first.sessionId), /SECRET/);
		const next = sync([user("a"), say("b"), call("t1"), result("t1", "hidden"), user("go")]);
		assert.equal(next.sessionId, first.sessionId, "rebuilt in place");
		assert.doesNotMatch(text(next.sessionId), /SECRET/);
	});

	it("rebuilds when tool-call arguments change at the same length", () => {
		const first = sync([user("a"), say("b"), call("t1", { path: "ARGS_ONE" }), result("t1"), user("go")]);
		assert.match(text(first.sessionId), /ARGS_ONE/);
		const next = sync([user("a"), say("b"), call("t1", { path: "ARGS_TWO" }), result("t1"), user("go")]);
		assert.doesNotMatch(text(next.sessionId), /ARGS_ONE/);
		assert.match(text(next.sessionId), /ARGS_TWO/);
	});

	it("rebuilds when an image changes at the same length", () => {
		const shot = (data) => ({ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", data }], timestamp: clock++ });
		const first = sync([shot("IMGONE"), say("b"), user("go")]);
		const before = staleLines();
		const next = sync([shot("IMGTWO"), say("b"), user("go")]);
		assert.equal(next.sessionId, first.sessionId);
		assert.equal(staleLines(), before + 1);
		assert.match(text(next.sessionId), /IMGTWO/);
		assert.doesNotMatch(text(next.sessionId), /IMGONE/);
	});

	it("rebuilds from the compressed priors instead of resuming the oversized mirror", () => {
		const first = sync([...conversation(20, "LONG"), user("go")]);
		assert.match(text(first.sessionId), /LONG_19/);
		const next = sync([user("[compressed blocks b1-b3] SUMMARY"), say("noted"), user("go")]);
		assert.ok(next.sessionId, "a mirror for the compressed conversation, not a history-less clean start");
		assert.equal(next.preserveSharedSession, undefined);
		assert.match(text(next.sessionId), /SUMMARY/);
		assert.doesNotMatch(text(next.sessionId), /LONG_19/);
		assert.equal(__test.getSharedSession(PI).cursor, 2);
	});

	it("rotates to a fresh file when a query is still running on the stale mirror", () => {
		const first = sync([...conversation(6, "BUSY"), user("go")]);
		const running = new QueryContext();
		running.piSessionId = PI;
		__test.activeQueryContexts.add(running);
		const next = sync([user("summary"), say("noted"), user("go")]);
		assert.ok(next.sessionId, "a rebuilt mirror, not a history-less start");
		assert.notEqual(next.sessionId, first.sessionId, "a live writer must not have its file rewritten under it");
		assert.match(text(first.sessionId), /BUSY_5/, "the old file is left to the query that owns it");
		deleteSession(first.sessionId, cwd, claudeDir);
	});

	it("keeps counting only for the unattributed bucket and for a mirror with no digests", () => {
		const unattributed = (history) => __test.syncSharedSession(history, cwd);
		const long = [...conversation(6, "L"), user("go")];
		const first = unattributed(long);
		assert.equal(__test.getSharedSession(null).priorDigests, undefined, "the shared bucket cannot tell its callers apart");
		const shorter = unattributed([user("x"), say("y"), user("go")]);
		assert.equal(shorter.sessionId, null);
		assert.equal(shorter.preserveSharedSession, true);
		deleteSession(first.sessionId, cwd, claudeDir);
		__test.resetSharedSession();

		const attributed = sync(long);
		const state = __test.getSharedSession(PI);
		__test.setSharedSession(PI, { ...state, priorDigests: undefined });
		const legacy = sync([user("x"), say("y"), user("go")]);
		assert.equal(legacy.preserveSharedSession, true, "a state recorded before digests existed keeps the old behavior");
		assert.ok(attributed.sessionId);
	});
});

describe("mirror digests through real turns", () => {
	it("a first-query publication retains ownership for a pending steer rejected by teardown", async () => {
		const sessionId = "pi-first-pending-steer";
		const first = [user("FIRST_PENDING_A")];
		const continuation = [...first, call("toolu_first_pending"), result("toolu_first_pending"), user("PENDING_STEER")];
		const queryGate = gate();
		const drainGate = gate();
		promptDrainGate = drainGate;
		// A CLI failure result still completes consumeQuery normally; teardown is
		// what rejects the steer that the input pump has not acknowledged.
		scripts.push([init("cc-first-pending"), ...toolUse("toolu_first_pending"), queryGate.wait,
			{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["query stopped"] }]);
		await stream(sessionId, first).result();
		const originalCtx = ctx();
		assert.equal(stateOf(sessionId), null, "no mirror exists before first completion");
		const prompt = originalCtx.promptStream;
		const push = prompt.push;
		let steerAck;
		prompt.push = (message) => {
			const ack = push(message);
			if (message.priority === "next") steerAck = ack;
			return ack;
		};
		const fail = prompt.fail;
		let published;
		prompt.fail = (error) => {
			published ??= structuredClone(stateOf(sessionId));
			fail(error);
		};
		const finishing = stream(sessionId, continuation);
		assert.ok(steerAck, "real delivery has a pending steer acknowledgement");
		assert.equal(stateOf(sessionId), null, "delivery only records query-local history");
		queryGate.open();
		await finishing.result();
		await assert.rejects(steerAck, /query ended/, "teardown rejects the pending acknowledgement");
		drainGate.open();
		await settle();
		const afterRejection = structuredClone(stateOf(sessionId));
		const missedSteer = originalCtx.missedSteer;
		const sameContext = ctx() === originalCtx;
		await plainTurn(sessionId, [...continuation, say("reply"), user("next")]);

		assert.ok(sameContext, "publication did not replace the query context");
		assert.equal(published.cursor, 4, "completion published before rejecting the steer");
		assert.deepEqual(published.priorDigests, priorDigests(continuation.slice(0, 3)));
		assert.equal(Boolean(published.needsRebuild), false, "the rejection has not run at publication");
		assert.match(calls.at(-1).mirror ?? "", /PENDING_STEER/,
			"the next turn rebuilds from history including the missed steer, rather than reusing the empty mirror");
		assert.equal(missedSteer, true, "the originating delivery retains its ownership");
		assert.equal(afterRejection.needsRebuild, true, "its newly published mirror is marked stale");
	});

	it("fences a deferred steer rejection after discard reuses the context for a replacement query", async () => {
		const sessionId = "pi-deferred-steer";
		const first = [...conversation(6, "BEFORE_STEER"), user("go")];
		const oldGate = gate();
		const drainGate = gate();
		promptDrainGate = drainGate;
		scripts.push([init("cc-old-steer"), ...toolUse("toolu_old_steer"), oldGate.wait, done()]);
		await stream(sessionId, first).result();
		const originalCtx = ctx();
		const oldQuery = originalCtx.activeQuery;
		const displaced = stateOf(sessionId);

		// Keep the helper's promise so the rejection can be awaited exactly, without
		// a timing sleep. Its real prompt-stream ack remains pending until discard.
		const delivery = __test.deliverToolResults(originalCtx,
			[{ toolCallId: "toolu_old_steer", content: [{ type: "text", text: "old result" }] }],
			[{ type: "text", text: "late steer" }], first.length + 3);
		__test.markRebuildForSession(sessionId, "session_compact:test");
		const rewritten = [user("STEER_SUMMARY"), say("noted"), user("go"),
			call("toolu_old_steer"), result("toolu_old_steer")];
		const replacementGate = gate();
		promptDrainGate = null;
		scripts.push([init("cc-replacement-steer"), replacementGate.wait, done()]);
		// Discard rejects the ack synchronously, then installs B on the same context
		// before A's rejection continuation gets its microtask.
		const replacementStream = stream(sessionId, rewritten);
		const replacement = structuredClone(stateOf(sessionId));
		const reused = ctx() === originalCtx && ctx().activeQuery !== oldQuery;
		await delivery;
		const afterRejection = {
			missedSteer: ctx().missedSteer,
			mirror: structuredClone(stateOf(sessionId)),
			queuedOldResult: ctx().pendingResults.has("toolu_old_steer"),
		};
		oldGate.open();
		drainGate.open();
		replacementGate.open();
		await replacementStream.result();
		await settle();
		const afterCompletion = stateOf(sessionId);

		assert.ok(reused, "the replacement reused the originating QueryContext");
		assert.notEqual(replacement.sessionId, displaced.sessionId, "discard rotated the mirror");
		assert.deepEqual(afterRejection, { missedSteer: false, mirror: replacement, queuedOldResult: false },
			"obsolete delivery cannot mutate either replacement bookkeeping or its mirror");
		assert.equal(Boolean(afterCompletion.needsRebuild), false, "completion does not preserve an obsolete missed-steer signal");
	});

	it("fences a rotated live writer's delivery, completion, error and abort from the replacement mirror", async () => {
		for (const ending of ["success", "error", "abort", "abort-error"]) {
			const sessionId = `pi-displaced-${ending}`;
			const old = conversation(6, "DISPLACED");
			const first = [...old, user("go")];
			const delivered = [...first, call(`toolu_${ending}`), result(`toolu_${ending}`)];
			const g = gate();
			const controller = new AbortController();
			scripts.push([init("cc-displaced"), ...toolUse(`toolu_${ending}`), g.wait,
				...(ending.endsWith("error") ? [() => { throw new Error("displaced failure"); }] : [done()])]);
			await providerConfig.streamSimple(model, { messages: first, tools: [readTool] },
				{ sessionId, signal: controller.signal }).result();
			const displaced = stateOf(sessionId);

			// Another call rewrites the same-length history while the original query is live.
			const rewritten = [...conversation(6, "REPLACEMENT"), user("new go")];
			await plainTurn(sessionId, rewritten);
			const replacement = structuredClone(stateOf(sessionId));
			assert.notEqual(replacement.sessionId, displaced.sessionId, "the live writer's file was rotated");
			assert.deepEqual(replacement.priorDigests, priorDigests(rewritten.slice(0, -1)));
			assert.match(mirrorText(replacement.sessionId), /REPLACEMENT_5/);

			const continuation = stream(sessionId, delivered);
			const afterDelivery = structuredClone(stateOf(sessionId));
			if (ending.startsWith("abort")) controller.abort();
			g.open();
			await continuation.result();
			await settle();
			const afterCompletion = structuredClone(stateOf(sessionId));
			// Collect both snapshots before asserting: even the baseline completes its writer.
			assert.deepEqual({ afterDelivery, afterCompletion },
				{ afterDelivery: replacement, afterCompletion: replacement },
				`${ending}: displaced query cannot mutate or erase the replacement mirror`);

			const before = staleLines();
			await plainTurn(sessionId, [...rewritten, say("replacement reply"), user("next")]);
			assert.equal(calls.at(-1).resume, replacement.sessionId);
			assert.equal(staleLines(), before, "replacement fingerprints describe its own conversation");
		}
	});

	it("a first-query A-to-B rewrite rebuilds rather than fingerprinting the rewritten context as sent history", async () => {
		const sessionId = "pi-first-rewritten";
		const sent = [user("FIRST_SENT_A")];
		const rewritten = [user("FIRST_REWRITTEN_B"), call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, sent, rewritten);
		const before = staleLines();
		await plainTurn(sessionId, [...rewritten, say("reply"), user("next")]);
		assert.equal(staleLines(), before + 1, "the next turn detects history different from what CC received");
		assert.match(calls.at(-1).mirror, /FIRST_REWRITTEN_B/, "rebuilt from pi's current history");
		assert.doesNotMatch(calls.at(-1).mirror, /FIRST_SENT_A/);
	});

	it("a normal tool-using turn does not look stale to the next one", async () => {
		const sessionId = "pi-quiet";
		const base = conversation(8, "Q");
		await plainTurn(sessionId, [...base, user("first")]);
		const prefix = [...base, user("first"), say("a1"), user("go")];
		const atToolResult = [...prefix, call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, prefix, atToolResult);

		const before = staleLines();
		const state = __test.getSharedSession(sessionId);
		scripts.push([init("cc-next"), done()]);
		await stream(sessionId, [...atToolResult, say("final"), user("next")]).result();
		assert.equal(calls.at(-1).resume, state.sessionId, "resumes the same mirror");
		assert.equal(staleLines(), before, "and does not rebuild it");
	});

	it("a history compressed under a running query rebuilds the mirror from the compressed history", async () => {
		const sessionId = "pi-compress-midquery";
		const base = conversation(60, "OLD");
		await plainTurn(sessionId, [...base, user("first")]);
		const prefix = [...base, user("first"), say("a1"), user("go")];
		const compressed = [user("[compressed blocks b1-b9] SUMMARY"), say("noted"), user("go"), call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, prefix, compressed);

		scripts.push([init("cc-after"), done()]);
		await stream(sessionId, [...compressed, say("reply"), user("checkpoint")]).result();
		const resumed = calls.at(-1);
		assert.ok(resumed.resume, "the compressed conversation is mirrored, not sent history-less");
		assert.match(resumed.mirror, /SUMMARY/);
		assert.doesNotMatch(resumed.mirror, /OLD_59/, "the stale 60-message history is gone from the mirror");
	});

	it("a mirror created by its first query is recorded too, tool results included", async () => {
		const sessionId = "pi-first-mirror";
		// Turn 1 has no priors, so no mirror exists until the query completes.
		const first = [user("start")];
		const atToolResult = [...first, call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, first, atToolResult);
		const state = __test.getSharedSession(sessionId);
		assert.equal(state.priorDigests.length, atToolResult.length, "digests cover what the query saw through its last tool result");

		scripts.push([init("cc-after"), done()]);
		await stream(sessionId, [user("[summary]"), say("ok"), user("next")]).result();
		assert.ok(calls.at(-1).resume, "the shorter history rebuilds the mirror");
		assert.match(calls.at(-1).mirror, /summary/);
	});
});

describe("per-call user context that pi never stores (ACP nudges, herdsman's retired-context notice)", () => {
	// Extensions append a user-role message to the context of a call; it is the trailing run, so it
	// reaches Claude Code as part of the prompt, and the next call does not have it. Recording it
	// in the mirror's digests would make the next sync see a rewritten history and rebuild.
	const NUDGE = (n) => user(`<nudge ${n}>compress soon</nudge>`);

	it("a tool turn with a nudge on every call resumes the next turn without a rebuild", async () => {
		const sessionId = "pi-nudge-tool";
		const base = conversation(8, "N");
		await plainTurn(sessionId, [...base, user("first"), NUDGE(0)]);
		const p = [...base, user("first"), say("a1"), user("go")];
		const results = [...p, call("toolu_1"), result("toolu_1")];
		await toolTurn(sessionId, [...p, NUDGE(1)], [...results, NUDGE(2)]);

		const before = staleLines();
		const state = __test.getSharedSession(sessionId);
		scripts.push([init("cc-next"), done()]);
		await stream(sessionId, [...results, say("final"), user("next"), NUDGE(3)]).result();
		assert.equal(calls.at(-1).resume, state.sessionId, "resumes the same mirror");
		assert.equal(staleLines(), before, "no mirror_stale: the nudges were never part of pi's history");
	});

	it("a nudged turn that makes no tool call resumes the next turn without a rebuild", async () => {
		const sessionId = "pi-nudge-plain";
		const base = conversation(8, "P");
		await plainTurn(sessionId, [...base, user("first"), NUDGE(0)]);
		const state = __test.getSharedSession(sessionId);

		const before = staleLines();
		scripts.push([init("cc-next"), done()]);
		await stream(sessionId, [...base, user("first"), say("reply"), user("second"), NUDGE(1)]).result();
		assert.equal(calls.at(-1).resume, state.sessionId);
		assert.equal(staleLines(), before);

		scripts.push([init("cc-next2"), done()]);
		await stream(sessionId, [...base, user("first"), say("reply"), user("second"), say("reply2"), user("third"), NUDGE(2)]).result();
		assert.equal(calls.at(-1).resume, state.sessionId, "and keeps resuming it on later turns");
		assert.equal(staleLines(), before);
	});

	it("a real steer is tracked once it is no longer trailing, and a later rewrite of it rebuilds", async () => {
		const sessionId = "pi-steer";
		const base = conversation(6, "S");
		await plainTurn(sessionId, [...base, user("first")]);
		const p = [...base, user("first"), say("a1"), user("go")];
		const withCall = [...p, call("toolu_1")];
		// Tool result arrives with a steer trailing it.
		const atResult = [...withCall, result("toolu_1"), user("STEER_ONE")];
		await toolTurn(sessionId, p, atResult);
		const priors = [...atResult, say("final")];
		assert.equal(__test.getSharedSession(sessionId).priorDigests.length, atResult.length - 1,
			"the trailing steer is not recorded while it could still be a per-call message");

		const before = staleLines();
		scripts.push([init("cc-next"), done()]);
		await stream(sessionId, [...priors, user("next")]).result();
		assert.equal(calls.at(-1).resume, __test.getSharedSession(sessionId).sessionId, "resumed, not rebuilt");
		assert.equal(staleLines(), before);
		assert.equal(__test.getSharedSession(sessionId).priorDigests.length, priors.length, "the steer is tracked now that it is settled history");

		// Same-length rewrite of the steer: only detectable if it was recorded.
		const rewritten = priors.map((m) => (m.content === "STEER_ONE" ? { ...m, content: "STEER_TWO" } : m));
		scripts.push([init("cc-next2"), done()]);
		await stream(sessionId, [...rewritten, user("again")]).result();
		assert.equal(staleLines(), before + 1);
	});
});

describe("a history-less side call on a session whose mirror holds history", () => {
	it("never leaves the next normal turn resuming the side call's tiny session", async () => {
		const sessionId = "pi-side-call";
		const history = conversation(30, "HIST");
		await plainTurn(sessionId, [...history, user("first")]);
		const mirror = __test.getSharedSession(sessionId).sessionId;
		assert.match(mirrorText(mirror), /HIST_29/);

		// Same pi session id, no prior history (a one-off call that shares the session key).
		scripts.push([init("cc-tiny"), done()]);
		await stream(sessionId, [user("side question")]).result();
		await settle();
		stateOf(sessionId);

		// The conversation comes back.
		scripts.push([init("cc-back"), done()]);
		await stream(sessionId, [...history, user("first"), say("a1"), user("continue")]).result();
		const resumed = calls.at(-1);
		assert.ok(resumed.resume, "the conversation is mirrored");
		assert.notEqual(resumed.resume, "cc-tiny", "not the side call's one-message session");
		assert.match(resumed.mirror, /HIST_29/, "the resumed mirror holds the whole conversation");
	});

	it("persists the stale mark when the history is empty", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-empty-"));
		try {
			const PI = "pi-empty-stale";
			const first = __test.syncSharedSession([...conversation(6, "E"), user("go")], cwd, undefined, undefined, PI);
			ids.add(first.sessionId);
			const empty = __test.syncSharedSession([user("lonely")], cwd, undefined, undefined, PI);
			assert.equal(empty.sessionId, null);
			assert.equal(__test.getSharedSession(PI).needsRebuild, true, "saved, not only used for this one decision");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
