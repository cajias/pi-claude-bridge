/**
 * An extension-triggered turn (sendMessage with triggerTurn on an idle session) skips
 * before_agent_start, so pi renders the transcript's *stored* sections (pi#5581). Those can
 * differ from every prompt the bridge recorded — after a restart, a reload that changed the
 * tool loadout, or an extension section that only the transcript carries — and exact-key
 * lookup then found nothing and failed the turn.
 *
 * The replayed sections say what to forward, so the stream call records them. These drive
 * the real provider entry (streamSimple) with transcript-shaped contexts, because the
 * resolver tests alone cannot see the order of the stream call's steps:
 *   - the three field failure shapes (tests/lib/prompt-fixtures.mjs) now resolve;
 *   - a sub-agent child embedding its parent verbatim still resolves by inheritance, with
 *     its own wrapper text forwarded (a replay record must never pre-empt that route);
 *   - what the resolver cannot account for — a tail-stripped child, a custom prompt, an
 *     opaque head — still fails the turn loudly;
 *   - the sendability guard still runs over replayed context.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonPrefix, extensionFixture, join as joinSections, leadFixture, loadoutFixture, section } from "./lib/prompt-fixtures.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-replay-capture-"));
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, "claude");
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const { PI_PREAMBLE, PromptCaptures } = await import("../src/prompt-capture.js");

/** One extension activation = one runtime: its own before_agent_start option stash. */
function activation() {
	let providerConfig;
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	return { handlers, providerConfig };
}
const { providerConfig } = activation();
const model = providerConfig.models[0];
const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const sys = (extra) => ({ role: "system", content: "", timestamp: 0, ...extra });
const transcript = (...head) => [...head, { role: "user", content: "checkpoint", timestamp: 1 }];
const replayHead = (sections, tools = [readTool]) => [...(tools.length ? [sys({ toolsAdded: tools })] : []), sys({ sections })];

let appendSent;
let queries;
let seq = 0;
beforeEach(() => {
	appendSent = undefined;
	queries = 0;
	__test.resetSharedSession();
	__test.setQuery(({ options }) => {
		queries++;
		appendSent = options.systemPrompt.append;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: "cc-replay" };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => __test.setQuery(null));

const turn = (messages) =>
	providerConfig.streamSimple(model, { messages, tools: [] }, { sessionId: `pi-replay-${seq++}` }).result();

const HARNESS = [PI_PREAMBLE, "HARNESS_RULE", "HARNESS_DOCS", "<tools>", "<rules>", "<docs>", "<cwd>"];
function assertNoHarness(append) {
	for (const text of HARNESS) assert.ok(!append.includes(text), `pi's harness text stays out: ${text}`);
}

describe("replay capture: the three field failure shapes", () => {
	it("lead — restart + idle assignment turn: stale tool list in the replay, restarted live render recorded", async () => {
		const f = leadFixture();
		assert.equal(joinSections(f.replay).length, f.replayChars);
		assert.equal(joinSections(f.live).length, f.liveChars);
		assert.equal(commonPrefix(joinSections(f.replay), joinSections(f.live)), f.divergesAt);

		// A fresh runtime: turn_start fires, but no before_agent_start has run to stash options.
		const { handlers } = activation();
		handlers.get("turn_start")({}, { getSystemPrompt: () => joinSections(f.live) });
		assert.equal(__test.promptCaptures.resolve(joinSections(f.live)), undefined,
			"no options, no key: an empty-option key would shadow the replay and forward no context");

		const result = await turn(transcript(...replayHead(f.replay)));

		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, new RegExp(f.marker));
		assert.match(appendSent, /SKILL_LEAD_RULES/);
		assertNoHarness(appendSent);
	});

	it("extension — the replay carries an extension section no forced prompt had; the recorded key is untouched", async () => {
		const f = extensionFixture();
		assert.equal(joinSections(f.replay).length, f.replayChars);
		assert.equal(f.forced.length, f.forcedChars);
		assert.equal(commonPrefix(joinSections(f.replay), f.forced), f.divergesAt);

		const { handlers } = activation();
		const contextFiles = [{ path: "/work/AGENTS.md", content: "RECORDED_EXTENSION_RULES" }];
		handlers.get("before_agent_start")({ systemPrompt: f.forced, systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] } });
		handlers.get("agent_start")({}, { getSystemPrompt: () => f.forced });

		const result = await turn(transcript(...replayHead(f.replay)));

		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, new RegExp(f.marker), "the replay's own context block is forwarded");
		assert.match(appendSent, /SKILL_EXTENSION_RULES/);
		assert.ok(appendSent.endsWith(f.replay.agent_browser), "#153 replay custom section forwarded verbatim");
		assertNoHarness(appendSent);
		assert.deepEqual(__test.promptCaptures.resolve(f.forced).contextFiles, contextFiles,
			"the forced-prompt key keeps the options pi gave it");
	});

	it("loadout — tool loadout drifted since the transcript's sections were written", async () => {
		const f = loadoutFixture();
		assert.equal(joinSections(f.replay).length, f.replayChars);
		assert.equal(joinSections(f.live).length, f.liveChars);
		assert.equal(commonPrefix(joinSections(f.replay), joinSections(f.live)), f.divergesAt);

		// An earlier turn of this process recorded the (shorter) live render with real options.
		const { handlers } = activation();
		const contextFiles = [{ path: "/work/AGENTS.md", content: "LIVE_LOADOUT_RULES" }];
		handlers.get("before_agent_start")({ systemPrompt: joinSections(f.live), systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] } });
		handlers.get("turn_start")({}, { getSystemPrompt: () => joinSections(f.live) });

		const result = await turn(transcript(...replayHead(f.replay)));

		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, new RegExp(f.marker));
		assertNoHarness(appendSent);
	});

	it("forwards a replayed append (addendum) exactly, without pi's wrapper tags", async () => {
		const f = leadFixture();
		const sections = { ...f.replay, addendum: section("addendum", "APPENDED_BY_USER\nsecond line") };
		const result = await turn(transcript(...replayHead(sections)));
		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, /APPENDED_BY_USER\nsecond line/);
		assert.ok(!appendSent.includes("<addendum>"));
	});

	it("honours a read-less loadout: no skills are forwarded", async () => {
		const f = leadFixture();
		const result = await turn(transcript(...replayHead(f.replay, [])));
		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, new RegExp(f.marker));
		assert.ok(!appendSent.includes("SKILL_LEAD_RULES"));
	});

	it("lets a key recorded from pi's options win over the replay", async () => {
		const f = leadFixture();
		const { handlers } = activation();
		const text = joinSections(f.replay);
		handlers.get("before_agent_start")({
			systemPrompt: text,
			systemPromptOptions: { contextFiles: [{ path: "/work/AGENTS.md", content: "RECORDED_RULES" }], skills: [] },
		});
		await turn(transcript(...replayHead(f.replay)));
		assert.match(appendSent, /RECORDED_RULES/);
		assert.ok(!appendSent.includes(f.marker), "the replay did not overwrite the recorded options");
	});
});

describe("replay capture: what must keep resolving the old way", () => {
	const PARENT = leadFixture();
	const parentText = joinSections(PARENT.replay);
	const wrapper = `<sub_agent_context>CHILD_WRAPPER_TEXT: answer only about the diff</sub_agent_context>\n\n<active_agent name="worker"/>`;

	/** The transcript a pi-subagents child produces: its override becomes the whole preamble, and no
	 *  tools, rules or docs section is rendered for it. */
	const childHead = (preamble) => replayHead({
		preamble,
		project_context: section("project_context", "Project-specific instructions and guidelines:\n\n<project_instructions path=\"/child/AGENTS.md\">\nCHILD_OWN_RULES\n</project_instructions>"),
		cwd: section("cwd", "/child"),
	});

	function recordParent() {
		const { handlers } = activation();
		const contextFiles = [{ path: "/work/AGENTS.md", content: "PARENT_RULES" }];
		handlers.get("before_agent_start")({ systemPrompt: parentText, systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] } });
		handlers.get("agent_start")({}, { getSystemPrompt: () => parentText });
	}

	it("a child embedding its parent verbatim resolves by inheritance and its wrapper is forwarded", async () => {
		recordParent();
		const result = await turn(transcript(...childHead(`${parentText}\n\n${wrapper}`)));

		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.match(appendSent, /CHILD_WRAPPER_TEXT: answer only about the diff/, "the child's own instructions are not dropped");
		assert.match(appendSent, /PARENT_RULES/, "the parent's portable parts are substituted for the embedded prompt");
		assert.match(appendSent, /CHILD_OWN_RULES/);
		assert.ok(!appendSent.includes(PI_PREAMBLE), "pi's preamble is replaced by the parent's portable parts");
	});

	it("a child embedding a tail-stripped parent still fails the turn (#88)", async () => {
		recordParent();
		const stripped = joinSections(Object.fromEntries(Object.entries(PARENT.replay).filter(([name]) => name !== "skills" && name !== "cwd")));
		const result = await turn(transcript(...childHead(`${stripped}\n\n${wrapper}`)));

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries, 0, "no query started: the instructions would have been silently lost");
	});

	it("a custom prompt (no tools section) is left to the resolver", async () => {
		const result = await turn(transcript(...replayHead({ preamble: `${PI_PREAMBLE}-like custom agent prompt.`, cwd: section("cwd", "/work") })));
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries, 0);
	});

	it("an opaque head (forced text, no structured sections) still fails", async () => {
		const result = await turn(transcript(sys({ content: "forced text nobody recorded" })));
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries, 0);
	});

	it("replayed context still passes the sendability guard", async () => {
		const f = leadFixture();
		const risky = {
			...f.replay,
			project_context: section("project_context", `Project-specific instructions and guidelines:\n\n<project_instructions path="/work/AGENTS.md">\n${PI_PREAMBLE} (quoted verbatim)\n</project_instructions>`),
		};
		const result = await turn(transcript(...replayHead(risky)));
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /refusing to send this prompt/);
		assert.equal(queries, 0);
	});

	it("re-recording the replay keeps one key, however many turns resolve through it", async () => {
		const sections = { ...leadFixture().replay, cwd: section("cwd", "/somewhere-else") };
		await turn(transcript(...replayHead(sections)));
		const size = __test.promptCaptures.size;
		await turn(transcript(...replayHead(sections)));
		assert.equal(__test.promptCaptures.size, size);
		assert.equal(__test.promptCaptures.resolve(joinSections(sections)).source, "replay");
	});
});

describe("replay custom sections coexist with #153", () => {
	beforeEach(() => __test.promptCaptures.captures.clear());
	it("replay and options paths forward custom sections identically in order", async () => {
		const f = leadFixture();
		const sections = { ...f.replay, mcp_servers: section("mcp_servers", "  MCP instructions 🧪\n"), extension_policy: section("extension_policy", "SECOND_POLICY") };
		await turn(transcript(...replayHead(sections)));
		const replayAppend = appendSent;
		assert.ok(replayAppend.endsWith(`${sections.mcp_servers}\n\n${sections.extension_policy}`));
		const stored = __test.promptCaptures.resolve(joinSections(sections));
		__test.promptCaptures.record(joinSections(sections), {
			contextFiles: [], skills: [], append: "EXACT_OPTIONS",
			sections: { mcp_servers: "  MCP instructions 🧪\n", extension_policy: "SECOND_POLICY" },
		}, "before_agent_start");
		await turn(transcript(...replayHead(sections)));
		assert.equal(__test.promptCaptures.resolve(joinSections(sections)), stored, "live node replaced in place");
		assert.equal(stored.rendered, undefined, "re-recording clears replay fields");
		assert.equal(appendSent, `EXACT_OPTIONS\n\n${sections.mcp_servers}\n\n${sections.extension_policy}`);
	});

	it("custom replay bytes are not unwrapped or normalized", async () => {
		const sections = { ...leadFixture().replay, opaque_extension: "  custom text without a wrapper\n\n🧪  " };
		const result = await turn(transcript(...replayHead(sections)));
		assert.notEqual(result.stopReason, "error", result.errorMessage);
		assert.ok(appendSent.endsWith(sections.opaque_extension));
	});

	it("unsafe custom replay sections are refused before SDK acquisition", async () => {
		for (const text of [section("mcp_servers", `${PI_PREAMBLE} harness`), section("mcp_servers", "docs/custom-provider.md docs/packages.md")]) {
			const result = await turn(transcript(...replayHead({ ...leadFixture().replay, mcp_servers: text })));
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage, /refusing to send/);
			assert.equal(queries, 0);
		}
	});
});

describe("recordFromReplay", () => {
	it("refuses sections that are not what the key was rendered from", () => {
		const f = leadFixture();
		const sections = Object.entries(f.replay);
		const captures = new PromptCaptures();
		assert.equal(captures.recordFromReplay(`${joinSections(f.replay)} drifted`, sections), false);
		assert.equal(captures.size, 0);
		assert.equal(captures.recordFromReplay(joinSections(f.replay), sections), true);
		assert.equal(captures.size, 1);
	});
});

describe("replayed context is byte-identical to a normal turn's", () => {
	// A switch between replay and normal turns would otherwise change the cached system prompt.
	// Equivalence is proven against pi's own section builder, not a hand-written copy of it.
	let build;
	before(async () => {
		const { dirname, join: j } = await import("node:path");
		const { fileURLToPath, pathToFileURL } = await import("node:url");
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		build = (await import(pathToFileURL(j(dirname(entry), "core", "system-prompt.js")).href)).buildSystemPromptSections;
	});

	const files = [
		[{ path: "/w/AGENTS.md", content: "one" }],
		[{ path: "/a", content: "" }, { path: "/b", content: "multi\nline\n\n</project_instructions> tricky\n" }],
		[{ path: "/a", content: "x" }, { path: "/b", content: "y" }, { path: "/c", content: "z" }],
	];
	const skill = (name) => ({ name, description: `d <${name}> & more`, filePath: `/s/${name}/SKILL.md`, baseDir: `/s/${name}`, source: "user", disableModelInvocation: false });

	for (const [i, contextFiles] of files.entries()) {
		for (const skills of [[], [skill("a")], [skill("a"), skill("b")]]) {
			it(`context files #${i} with ${skills.length} skill(s): replay forwards exactly what the options path does`, async () => {
				const sections = build({ cwd: "/w", selectedTools: ["read", "bash"], toolSnippets: { read: "Read" }, contextFiles, skills });
				const text = Object.values(sections).join("\n\n");

				const { handlers: viaOptions } = activation();
				viaOptions.get("before_agent_start")({ systemPrompt: text, systemPromptOptions: { contextFiles, skills, selectedTools: ["read", "bash"] } });
				await turn(transcript(...replayHead(sections)));
				const fromOptions = appendSent;

				// Same store: drop the recorded key, then replay.
				const store = __test.promptCaptures;
				for (const key of [...store.captures.keys()]) store.captures.delete(key);
				await turn(transcript(...replayHead(sections)));
				assert.equal(store.resolve(text).source, "replay");
				assert.equal(appendSent, fromOptions);
				assert.match(appendSent, /Project-specific instructions/);
				for (const { name } of skills) assert.ok(appendSent.includes(`<name>${name}</name>`));
			});
		}
	}
});
