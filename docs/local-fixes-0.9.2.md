# Local safety fixes on v0.9.2

Base: `b2e7255ece0b8bfd3a6429fd5c147fd59984c785` (`v0.9.2`).
This is a source-only fork candidate, not a release or proof of live API behavior.
No package version, dependency constraint, provider or installer behavior is changed.

`package.json` remains version 0.9.2, ships `src` directly through `pi.extensions`, and has no
build/lifecycle script. Runtime constraints remain SDK `^0.3.293`, MCP SDK `^1.29.0`,
cc-session-io `^0.4.0`, change-case `^5.4.4`; Node `>=20`; pi-ai/pi-coding-agent/pi-tui
peers `>=0.86.1` and typebox `*`. The unchanged upstream lockfile pins SDK 0.3.293,
MCP 1.31.0, cc-session-io 0.4.0 and change-case 5.4.4. Its root version still says 0.9.1
(an inherited upstream metadata mismatch, not changed by this port).

Validation reuses existing SDK 0.3.296 / MCP 1.32.1 / cc-session-io 0.4.0 / pi 1.1.0,
with TypeScript 7.0.2, Node 25.2.1, and test-only pi-goal-x 0.32.3. Those installed inputs
are not the lockfile's exact dependency set; no claim of testing a fresh locked installation.
The upstream source and dependency manifests are untouched.

## Port map: retain, adapt, drop

| File / symbol | Local repair retained or adapted | Relationship to upstream 0.9.2 |
| --- | --- | --- |
| `src/transcript.ts`: `canonicalSections`, `replayedSections` | Read the complete structured replay, excluding opaque heads; use the same order as prompt rendering. | Retain #153's `stableRanked` custom-last ordering. Share the built-in classification through `isBuiltInPromptSection`; do not restore 0.9.1's predecessor-rank algorithm. |
| `src/prompt-capture.ts`: `recordFromReplay` | Exact full join, Pi preamble and tools-section guard; options/revived keys outrank replay. Project replayed context/skills with normal-turn byte layout. | Adapt to #153: preserve every custom section's full replayed bytes and order in `rendered.sections`. Normal recorded `sections` continue to be copied and wrapped as upstream specifies. Drop the old repair's unsupported-custom-section omission. |
| `PromptCaptures.record`, `projectCapture` | Re-recording updates the live node and clears replay fields; every projected part passes sendability checks. | Keep #153's copied recorded sections and their projection, including inherited sections. Raw replay sections are not unwrapped or normalized. |
| `PromptCaptures.resolveOrDerive`, `deriveAuxiliary` | exact → revived → default replay → inheritance → narrow auxiliary fallback / throw. Auxiliary requires exact ordered `[preamble, cwd]`, full join, nonblank non-Pi preamble, valid cwd. Recorded-key truncation and reachable recorded custom-text guards precede acceptance. | #153 does not replace replay recovery or auxiliary derivation. Auxiliary rejects extra custom sections; recorded/inherited custom-section support is unchanged. |
| `sharedPromptCaptures` | Adopt older capture-store prototypes in place without losing recorded nodes. | Reload fixture is now a verbatim v0.9.2 class (imports redirected), including #153 section data. |
| `src/index.ts`: `recordSystemPrompt` | Do not record optionless `turn_start` / `agent_start` keys that would shadow replay with empty context. | Preserve `options.sections` from #153. |
| `src/priors-fingerprint.ts` | Per-message content digests; canonical arguments; metadata excluded; preserve recorded prefixes when extending. | New file, not superseded by #153. |
| `src/index.ts`: `syncSharedSession`, `stableMessages`, `mirrorDigests` | Compare settled-history digests before resume; immediately persist `mirror_stale` / rebuild state even on empty-history early return. Rebuild in place, or rotate if a writer owns the old mirror. | No changes to #153 prompt ordering or #151 memory exclusions. Trailing per-call user notices are excluded from digests, not from cursor accounting. |
| `src/query-state.ts`: `preservesMirror`, `latestMessages`; provider delivery/completion | A history-less query never lowers a parked mirror's cursor/digests; completion records settled history from query-local messages. | Keep query-local result routing and abort/error ownership unchanged. |
| Upstream #151 / #162 / #164 | No replacement code. | Preserve AGENTS.md exclusions, synthetic failure-report suppression/abandoned-block handling, and lazy log paths. Do not reintroduce eager log constants from the 0.9.1 patch. |

No runtime repair component is dropped as redundant with #153. Only conflicting old custom-section
omission, old transcript ranking and eager-path assumptions are discarded. Replay, auxiliary and
mirror guards remain necessary on plain v0.9.2.

## Offline verification

Requires existing Node 25+ (the guard uses synchronous loader hooks), `tsx`, TypeScript,
package dependencies, pi-ai/pi-coding-agent, and test-only `pi-goal-x` modules for the retention
mechanism. These are external test inputs, not new package dependencies. Do not install them
as part of this verifier. Live `int-*` tests are deliberately excluded because they require
Claude Code requests; the provider/MCP integration coverage here uses mocked SDK queries.

```sh
EVIDENCE_DIR=/external/local/evidence MUTATE=1 bash tests/verify-local-fixes.sh all
```

Alternatively execute its bounded stages: `prepare`, `typecheck`, `unit`, `repair`, `mutations`,
`stability`, `finish`. Mutation groups accept `MUTATION_START` (inclusive) / `MUTATION_END`
(exclusive). Stability groups accept `STABILITY_START` / `STABILITY_END` (both inclusive).
`NPM_ROOT` and `LIVE_BRIDGE` can select existing read-only dependency/source inputs.
Evidence and disposable trees are retained; no process signalling or recursive shell cleanup.

Every execution redirects HOME, CLAUDE_CONFIG_DIR and TMPDIR before imports. The guard traps
actual SDK `query`, HTTP/fetch and TCP calls, shell/non-test subprocesses. The exact existing
esbuild transform service and tsx's exact parent IPC pipe inside redirected TMPDIR are permitted.
The installed bridge is only hashed; execution and mutations occur in disposable trees.

Current validation: pristine package suite 296 tests, 295 pass / 1 fail; fork suite 408 tests,
407 pass / 1 fail. Both have only `tests/unit-models.mjs`, `applyLongContext` / `haiku shortcut
and no-match still resolve`, expected `claude-haiku-4-5` vs actual `claude-haiku-5-5`, strictEqual.
Both typechecks pass. Repair suite: baseline 47 pass / 65 fail; fork 112/112 pass.
All 28 safety mutations are detected (result misrouting produces two test-timeout cancellations);
20 repeated repair-suite runs pass 112/112 with zero cancellations.
The exact 89-entry baseline pin includes parent suites: prior 85 entries retained under sanitized
names, plus three custom-replay regressions and their parent suite. No prior failure was masked
or removed; custom-section projection expectations now preserve #153.

## Limits

- Shape is not authenticated provenance. Auxiliary fallback only proves that all instruction-bearing
  preamble bytes are forwarded. Capture-store guards cannot recognize unrelated evicted captures;
  recorded custom-text substring checks can conservatively reject a legitimate request.
- The 297/330-length fixtures have synthetic paths/text; 330 is only a length stand-in for an unknown
  prompt, not a diagnosis or live reproduction.
- Checkpoint/tool identifiers and message text are synthetic. Retention tests reuse the real
  retention mechanism with modelled request-only tails, not an exact historical canary replay.
- Two unstored trailing notices can still force a history-less turn by cursor arithmetic. The
  existing characterization passes on both baseline and fork; this port does not broaden scope
  to repair it.
- Mocks do not prove live subscription, cache, provider or recovery behavior. No installation,
  restart, reload, canary or release is implied by passing this verifier.
