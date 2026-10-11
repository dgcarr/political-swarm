# Political Swarm readiness plan

Political Swarm should make run progress, connection health and required decisions clear while preserving its read-only role. This work qualifies local monitoring behavior; it does not establish doctrine effectiveness.

## Implementation

1. Separate event connection labels from run status. Show an idle state when no run is selected, identify completed records, and report request failures without implying that a run failed.
2. Explain pending approvals, independent acceptance, interruption and budget pauses. Show the relevant Claude Code command without preselecting a decision. Include interrupted and paused runs in Needs attention.
3. Close the previous event stream when changing runs and clear stale detail references while loading. Preserve automatic reconnect and replay behavior.
4. Verify dashboard tests, zero-cost engine streaming, and browser flows for attention guidance, hidden runs and playback. Use isolated scratch repositories for smoke work.
5. Reduce default information density. Keep status, progress and next action visible; put tasks, workers and detailed events behind navigation, and make live narration expandable. Use Political Swarm as the dashboard title.

## Acceptance checks

- A connected event stream never appears to mean a run is executing.
- An empty or fully hidden run list does not remain Connecting.
- Awaiting acceptance has a visible independent-review explanation and command.
- Each approval identifies the approval and provides a neutral decision command.
- Interrupted runs have resume guidance; completed runs are identified as saved records.
- Dashboard route, read-only security and reconnect replay tests pass.
- A real engine run with a no-op strategy emits events before reaching awaiting acceptance, without model spending.

## Evidence boundary

Automated fixtures and the no-op smoke test verify software behavior. A paid end-to-end doctrine run is a separate follow-up; it is not required to change these presentation and guidance features and is not claimed as completed here.

## Implemented and verified

- Connection labels distinguish event transport from run status, including the fully hidden list case. Switching runs closes the previous stream before loading the next record.
- Next action explains independent acceptance, interruption and paused states. Approval commands preserve the run and approval IDs without choosing a resolution.
- Needs attention includes paused and interrupted runs. Hidden runs cannot reappear in comparison panels through state events.
- Overview shows progress and required action. Work plan, Workers and Event log expose details separately; live narration and closing statements are expandable.
- Build and 550 dashboard tests passed, including five new UI guidance tests and existing reconnect replay tests.
- The no-op engine smoke test streamed 11 ledger events and 14 state frames, reached awaiting acceptance, and released its disconnected client.
- Recorded-run replay streamed all 1,135 entries, narrated 1,052, and delivered closing statements for each ended run without malformed narration.
- Chrome checks verified acceptance and interrupted-run guidance, attention filtering, detail tabs, and No run selected after hiding all runs. Test hiding was reversed afterward.
