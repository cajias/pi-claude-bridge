# Sourced only by verify-local-fixes.sh; no live execution.
  mutate "tools-section guard dropped"      src/prompt-capture.ts 's/ \|\| !byName\.has\("tools"\)\) return false;/) return false;/' tests/unit-replay-capture.mjs
  mutate "replay sections not checked"      src/prompt-capture.ts 's/if \(sections\.map.*!== systemPrompt\) return false;//' tests/unit-replay-capture.mjs
  mutate "no wrapper normalisation"         src/prompt-capture.ts 's/context: replayedContext\(byName\.get\("project_context"\)\), skills: replayedSkills\(byName\.get\("skills"\)\)/context: byName.get("project_context"), skills: byName.get("skills")/' tests/unit-replay-capture.mjs
  mutate "digest check disabled"            src/index.ts 's/if \(digests && sharedSession\?\.priorDigests/if (false \&\& digests \&\& sharedSession?.priorDigests/' tests/unit-mirror-resume-guard.mjs tests/unit-goal-checkpoint.mjs
  mutate "preserve query lowers the cursor" src/index.ts 's/if \(state && !resultCtx\.preservesMirror\) \{/if (state) {/' tests/unit-mirror-resume-guard.mjs
  mutate "ephemeral trailing user recorded" src/index.ts 's/return messages\.slice\(0, turnStart\(messages as unknown as Context\["messages"\]\)\);/return messages.slice();/' tests/unit-mirror-resume-guard.mjs tests/unit-goal-checkpoint.mjs
  mutate "replay route removed"             src/index.ts 's/promptCaptures\.resolveOrDerive\(context\.systemPrompt, replay\)/promptCaptures.resolveOrDerive(context.systemPrompt)/' tests/unit-goal-checkpoint.mjs
  mutate "stale mark not persisted"         src/index.ts 's/^\t\tsetSessionStateFor\(piSessionId, sharedSession\);$//' tests/unit-mirror-resume-guard.mjs
  mutate "store not adopted after reload"   src/prompt-capture.ts 's/Object\.setPrototypeOf\(existing, PromptCaptures\.prototype\)/void existing/' tests/unit-prompt-capture-reload.mjs
  # BR-AUX-1: each guard of the auxiliary fallback, its precedence, its isolation, and the rebuild accounting.
  AUXT="tests/unit-aux-capture.mjs"
  mutate "aux: section order not checked"      src/prompt-capture.ts 's/ \|\| sections\[1\]\[0\] !== "cwd"//; s/sections\[0\]\[0\] !== "preamble"/false/' $AUXT
  mutate "aux: section count not checked"      src/prompt-capture.ts 's/if \(sections\.length !== 2\) return undefined;//' $AUXT
  mutate "aux: exact join not required"        src/prompt-capture.ts 's/if \(sections\.map\(\(\[, text\]\) => text\)\.join\("\\n\\n"\) !== systemPrompt\) return undefined;//' $AUXT
  mutate "aux: blank preamble accepted"        src/prompt-capture.ts 's/if \(preamble\.trim\(\) === ""\) return undefined;//' $AUXT
  mutate "aux: pi preamble not refused"        src/prompt-capture.ts 's/if \(preambleAtLineStart\(preamble\) !== -1\) return undefined;//' $AUXT
  mutate "aux: cwd shape not validated"        src/prompt-capture.ts 's/if \(!CWD_SECTION\.test\(cwd\)\) return undefined;//' $AUXT
  mutate "aux: sendability guard removed"      src/prompt-capture.ts 's/^\t\tassertSendablePrompt\(parts, capture\);$//' $AUXT tests/unit-prompt-guard.mjs
  mutate "aux: preamble trimmed"               src/prompt-capture.ts 's/custom: preamble, contextFiles/custom: preamble.trim(), contextFiles/' $AUXT
  mutate "aux: cwd concatenated"               src/prompt-capture.ts 's/custom: preamble, contextFiles/custom: systemPrompt, contextFiles/' $AUXT
  mutate "aux: result written to the store"    src/prompt-capture.ts 's/if \(auxiliary\) return auxiliary;/if (auxiliary) { this.record(systemPrompt, { custom: auxiliary.custom, contextFiles: [], skills: [] }, "auxiliary"); return auxiliary; }/' $AUXT
  mutate "aux: pi#5581 truncated-key guard removed"  src/prompt-capture.ts 's/const auxiliary = !truncated \&\& replaySections/const auxiliary = replaySections/' $AUXT
  mutate "aux: recorded custom text not refused (#88)" src/prompt-capture.ts 's/^\tif \(recordedCustoms\.some\(\(custom\) => preamble\.includes\(custom\)\)\) return undefined;$//' $AUXT
  mutate "aux: tried before the exact lookup"  src/prompt-capture.ts 's/^\t\tconst exact = this\.captures\.get\(systemPrompt\);$/\t\tconst exact = (replaySections \&\& deriveAuxiliary(systemPrompt, replaySections, [])) || this.captures.get(systemPrompt);/' $AUXT
  mutate "aux: tried before inheritance"       src/prompt-capture.ts 's/if \(embedded\.length === 0\) \{/if (embedded.length === 0 || replaySections) {/' $AUXT
  mutate "aux: result routed to the first query" src/index.ts 's/if \(queryCtx\.pendingToolCalls\.has\(id\) \|\| queryCtx\.pendingResults\.has\(id\) \|\| queryCtx\.turnToolCallIds\.includes\(id\)\) \{/if (true) {/' tests/unit-aux-isolation.mjs
  mutate "aux: abort releases every query"     src/index.ts 's/^\tc\.releasePendingToolCalls\("Operation aborted"\);$/\tfor (const q of activeQueryContexts) q.releasePendingToolCalls("Operation aborted");/' tests/unit-aux-isolation.mjs
  mutate "aux: error drops every mirror"       src/index.ts 's/^\t\t\t\tsetSessionStateFor\(queryCtx\.piSessionId, null\);$/\t\t\t\tsharedSessions.clear();/' tests/unit-aux-isolation.mjs
  mutate "aux: stale rebuild hidden (no digest check)" src/index.ts 's/if \(digests && sharedSession\?\.priorDigests/if (false \&\& digests \&\& sharedSession?.priorDigests/' tests/unit-aux-retention.mjs tests/unit-aux-canary.mjs
  mutate "aux: stale rebuild hidden (not reported)"    src/index.ts 's/^\t\tdiagDump\("mirror_stale", .*$//' tests/unit-aux-retention.mjs tests/unit-aux-canary.mjs
