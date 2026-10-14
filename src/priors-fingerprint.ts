/**
 * Content digests of the messages a Claude Code mirror holds, so `syncSharedSession` can
 * tell a mirror that still matches pi's history from one pi has rewritten since — a
 * different count, or the same count with different content.
 *
 * Covers what the conversion replays: roles, text, images, tool ids/names/arguments,
 * tool-result content and error flags. Leaves out timestamps, usage and other metadata
 * so a benign re-render of an unchanged conversation never forces a rebuild.
 *
 * Design after sonSunnoi's fingerprint in pi-claude-bridge PR #136, cut to what sync
 * needs: one digest per message, so a mirror that grew past its last sync (tool results
 * and the final assistant message CC wrote itself) extends its record instead of
 * re-hashing the rest.
 */
import { createHash } from "crypto";

type Block = Record<string, unknown>;

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
}

function blocks(content: unknown): unknown[] {
	if (typeof content === "string") return [{ text: content }];
	if (!Array.isArray(content)) return [];
	return (content as Block[]).map((block) => {
		switch (block.type) {
			case "text": return { text: block.text ?? "" };
			case "image": return { image: block.mimeType, data: block.data };
			case "toolCall": return { call: block.id, name: block.name, args: block.arguments ?? {} };
			case "thinking": return { thinking: block.thinking ?? "" };
			default: return { dropped: block.type };
		}
	});
}

/** One digest per message, in order. */
export function priorDigests(messages: ReadonlyArray<{ role: string }>): string[] {
	return messages.map((message) => {
		const m = message as Record<string, unknown>;
		const shape = { role: m.role, content: blocks(m.content), id: m.toolCallId, error: m.isError === true };
		return createHash("sha256").update(canonical(shape)).digest("hex").slice(0, 32);
	});
}

/** True when `digests` begins with exactly the messages `recorded` was taken over. */
export function startsWithDigests(digests: readonly string[], recorded: readonly string[]): boolean {
	return digests.length >= recorded.length && recorded.every((digest, i) => digests[i] === digest);
}

/**
 * `recorded` extended over `messages` it does not yet cover. The recorded prefix is kept
 * as is, never re-derived from `messages`: a history pi rewrote under a running query
 * must still disagree with what the mirror actually holds. A `messages` shorter than the
 * record leaves it untouched for the same reason.
 */
export function extendDigests(recorded: readonly string[] | undefined, messages: ReadonlyArray<{ role: string }>): string[] | undefined {
	if (!recorded) return undefined;
	return messages.length > recorded.length ? [...recorded, ...priorDigests(messages.slice(recorded.length))] : [...recorded];
}
