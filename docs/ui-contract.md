# UI component contract

Written for the people (and agents) building `src/ui/`. It is a working note,
not part of the published documentation set.

Everything implements `Component<Props>` from `src/ui/components/component.ts`:

```ts
export interface Component<Props = void> {
  readonly el: HTMLElement;
  update(props: Props): void;
  destroy?(): void;
}
```

## Binding rules

- **No `innerHTML`.** ESLint fails the build. Use `el()` and `clear()` from
  `src/ui/a11y.ts`, or `document.createElement` plus `textContent`.
  The single exception is `src/ui/views/how-it-works.ts`, allowlisted for a
  hand-authored SVG with no interpolation.
- **No raw hex outside `src/ui/styles/tokens.css`.** `scripts/check-design-rules.mjs`
  greps for it and fails the build.
- **No gradients, no `blur()`, no coloured `box-shadow`, no `text-shadow`, no
  `border-radius` above 4px** outside the allowlist (`.talk-button`, `.avatar`,
  `.listening-indicator__dot`, `.mode-tag`). Same grep.
- **Nothing is communicated by colour alone** (plan §14). Every state carries an
  icon or a word as well.
- **Respect `prefers-reduced-motion`.** The duration tokens already collapse to
  `0ms` under it; anything driven by JavaScript must check
  `prefersReducedMotion()` from `src/ui/a11y.ts` itself.
- One CSS file per component, at `src/ui/styles/components/<name>.css`, imported
  from the component's own module so the bundler keeps them together.

## Factory signatures `src/main.ts` expects

| Module | Export | Props |
|---|---|---|
| `components/talk-button.ts` | `createTalkButton({ onPress, onInterrupt })` | `{ state: TalkState }` |
| `components/transcript.ts` | `createTranscript()` | `{ turns }` plus `addAgent(text)`, `addVisitor(text, isFinal)`, `setInterim(text)` |
| `components/slot-panel.ts` | `createSlotPanel({ onAnnounce })` | `{ slots, slotStates, today }` |
| `components/listening-indicator.ts` | `createListeningIndicator({ level })` | `{ active, state }` |
| `components/latency.ts` | `createLatencyReadout()` | `{ ms, source }` |
| `components/mode-tag.ts` | `createModeTag()` | `{ ruleMode, reason }` |
| `components/type-input.ts` | `createTypeInput({ onSubmit })` | `{ visible, disabled, label }` |
| `components/confirmation.ts` | `createConfirmationCard({ onViewDiary })` | `{ booking }` |
| `components/diary-table.ts` | `createDiaryTable()` | `{ bookings, highlightId, today }` |
| `components/fallback-panel.ts` | `createFallbackPanel({ repositoryUrl })` | `{ message }` |
| `views/diary.ts` | `createDiaryView({ repository, onBack })` | `{ bookings, transcripts, highlightId, today }` |
| `views/how-it-works.ts` | `createHowItWorks()` | `void` |

`TalkState` is `'idle' | 'warming' | 'listening' | 'thinking' | 'speaking'` from
`src/agent/orchestrator.ts`. `Booking`, `Slots`, `SlotStates` come from
`src/engine/index.ts`. `Transcript` comes from `src/agent/ports.ts`.

## Copy rules (plan §5.4)

Warm, brief, competent. Never apologetic, never chirpy, **no exclamation marks**.
Error copy states what happened and what to do, in that order, in one sentence.
Any line the agent *speaks* belongs in `src/config/phrases.ts`, not in a
component — components own labels and headings only.
