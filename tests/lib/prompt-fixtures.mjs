/**
 * Representative structured system prompts for the replay-capture tests.
 *
 * Reconstructed from the shape of three field failures, not copied from them: the
 * section sizes, total lengths and first-divergent offsets match what the bridge's diag
 * log recorded, while every character of content is synthetic (no project text, skills
 * or tool descriptions from a real session).
 *
 *   lead     59,251-char replay vs 57,756-char live key, diverging at 181 — the first tool
 *            name in the tools section. An idle custom-message turn (herdsman assignment)
 *            after a restart: the replay holds the stored tool list, the live render the
 *            restarted process's.
 *   extension  152,327-char replay vs 139,771-char forced-prompt key, diverging at 117,771 —
 *            the `agent_browser` extension section, which exists in the transcript but in
 *            no forced prompt (extensions appended text to the rendered prompt first).
 *   loadout 173,657-char replay vs 136,814-char live key, diverging at 2,281 — a
 *            tool-loadout drift: the replay still lists tools the reloaded process lost.
 */
export const PI_PREAMBLE_TEXT = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const TOOLS_TAIL = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";

export const section = (name, content) => `<${name}>\n${content}\n</${name}>`;

/** Wrapper overhead of `section(name, …)`. */
const overhead = (name) => 2 * name.length + 7;

/** A section of exactly `total` chars: `lead`, then deterministic filler. */
export function sized(name, total, lead) {
	const room = total - overhead(name) - lead.length;
	if (room < 0) throw new Error(`section ${name} cannot hold its lead in ${total} chars`);
	let filler = "";
	for (let i = 0; filler.length < room; i++) filler += `\n${name} filler ${i}: lorem ipsum dolor sit amet.`;
	return section(name, lead + filler.slice(0, room));
}

export const join = (sections) => Object.values(sections).join("\n\n");

/** Longest shared prefix of two strings. */
export function commonPrefix(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

const CONTEXT_LEAD = (marker) =>
	`Project-specific instructions and guidelines:\n\n<project_instructions path="/work/AGENTS.md">\n${marker}`;
const SKILLS_LEAD = (marker) =>
	`The following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n  <skill>\n    <name>${marker}</name>\n  </skill>\n</available_skills>`;

/** tools section: one line per [name, description], then pi's fixed trailer, sized to `total`. */
function toolsSection(lines, total) {
	const body = lines.map(([name, description]) => `- ${name}: ${description}`).join("\n");
	const room = total - overhead("tools") - TOOLS_TAIL.length - body.length;
	if (room < 0) throw new Error("tools section too small");
	return section("tools", body + " ".repeat(room) + TOOLS_TAIL);
}

/** The built-in sections of a default pi prompt; the context section is sized by the caller. */
function builtIns({ marker, tools, context }) {
	return {
		preamble: PI_PREAMBLE_TEXT,
		tools,
		rules: sized("rules", 4848, "- HARNESS_RULE"),
		docs: sized("docs", 1403, "Pi documentation: docs/custom-provider.md docs/packages.md HARNESS_DOCS"),
		project_context: context,
		skills: section("skills", SKILLS_LEAD(`SKILL_${marker}`)),
		cwd: section("cwd", "/work"),
	};
}

/** Solve the context section's size so the joined prompt is exactly `target` chars. */
function fitContext(target, marker, build) {
	const probe = build(sized("project_context", 200, CONTEXT_LEAD(marker)));
	const missing = target - join(probe).length;
	return build(sized("project_context", 200 + missing, CONTEXT_LEAD(marker)));
}

const withExtras = (sections, extras) => ({ ...sections, ...extras });

/** Lead: stale tool list in the replay, restarted process's list in the live render. */
export function leadFixture() {
	const marker = "LEAD_RULES";
	const replay = fitContext(59_251, marker, (context) => builtIns({
		marker, context,
		tools: toolsSection([["agent_list", "Delegate work"]], 191),
	}));
	// The live render lists another first tool and 1,495 fewer chars of context.
	const live = builtIns({
		marker,
		tools: toolsSection([["bash", "Run commands"]], 191),
		context: sized("project_context", replay.project_context.length - 1_495, CONTEXT_LEAD(marker)),
	});
	return { name: "lead", marker, replay, live, replayChars: 59_251, liveChars: 57_756, divergesAt: 181 };
}

/** Extension: an `agent_browser` section the forced prompts never carried. */
export function extensionFixture() {
	const marker = "EXTENSION_RULES";
	const base = fitContext(117_769, marker, (context) => builtIns({
		marker, context,
		tools: toolsSection([["read", "Read a file"], ["bash", "Run commands"]], 400),
	}));
	const agentBrowser = sized("agent_browser", 34_556, "BROWSER_RULES");
	const replay = withExtras(base, { agent_browser: agentBrowser });
	// A forced prompt: the rendered base plus 22,000 chars the extensions appended.
	const forced = `${join(base)}\n\n${"EXTENSION_CHARTER ".repeat(1_223).slice(0, 22_000)}`;
	return { name: "extension", marker, replay, forced, replayChars: 152_327, forcedChars: 139_771, divergesAt: 117_771 };
}

/** Loadout: the replay still lists tools the reloaded process no longer registers. */
export function loadoutFixture() {
	const marker = "LOADOUT_RULES";
	// 2,100 chars of tool lines precede the first stale one, which then starts at offset 2,281.
	const head = [["read", "Read a file"], ["bash", "Run commands"], ["grep", "x".repeat(2_050)]];
	const stale = [["subagent", "d".repeat(2_285 - "- subagent: ".length - 1)]];
	const trailer = [["write", "Write a file"]];
	const replayTools = (total) => toolsSection([...head, ...stale, ...trailer], total);
	const base = fitContext(139_099, marker, (context) => builtIns({ marker, context, tools: replayTools(5_000) }));
	const replay = withExtras(base, { agent_browser: sized("agent_browser", 34_556, "BROWSER_RULES") });
	// The live render lacks exactly the stale lines (2,285 chars) and the extension section.
	const liveTools = toolsSection([...head, ...trailer], 5_000 - 2_285);
	const live = { ...base, tools: liveTools };
	return { name: "loadout", marker, replay, live, replayChars: 173_657, liveChars: 136_814, divergesAt: 2_281 };
}

/**
 * BR-AUX-1: the standalone auxiliary agent, as pi 1.1.0 renders it. pi-goal-x's completion auditor
 * runs an in-memory AgentSession whose resource loader supplies this as the whole system prompt
 * (makeAuditorResourceLoader's default, goal-auditor.ts) and no context files, skills or append.
 * pi then renders exactly two sections: the custom prompt as `preamble` and `<cwd>`. No capture
 * boundary sees such a session, so nothing was ever recorded for it.
 *
 * Length/divergence pins use synthetic paths (297 chars, offset 9). The 330-char fixture
 * is a LENGTH-ONLY stand-in, not a reproduction of unknown live prompts.
 */
export const AUDITOR_PREAMBLE = [
	"You are a read-only completion auditor running in an isolated pi agent session.",
	"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
	"Never modify files. Never approve unless the actual user objective is complete.",
].join("\n");

export const auxSections = (preamble, cwd) => ({ preamble, cwd: section("cwd", cwd) });

export function auxFixture297() {
	const cwd = "/work/synthetic-audit".padEnd(29, "x");
	const sections = auxSections(AUDITOR_PREAMBLE, cwd);
	return { name: "aux297", preamble: AUDITOR_PREAMBLE, cwd, sections, chars: 297, divergesFromDefault: 9 };
}

export function auxFixtureLength330() {
	const cwd = "/work/synthetic-audit-long-".padEnd(62, "x");
	const sections = auxSections(AUDITOR_PREAMBLE, cwd);
	return { name: "length-330 stand-in", preamble: AUDITOR_PREAMBLE, cwd, sections, chars: 330, divergesFromDefault: 9, liveDivergence: 0 };
}
