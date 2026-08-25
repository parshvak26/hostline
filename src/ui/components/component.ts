/**
 * The component contract.
 *
 * There is no framework here (ADR-0001), so this is the whole of it: a factory
 * returns an element and a way to update it. No lifecycle, no diffing, no
 * reactivity — with nine components and one page, a convention is enough, and a
 * convention does not have a default look to fight.
 *
 * Two rules every component follows:
 *
 *   - **Build the element once, then mutate it.** Re-rendering by replacing
 *     nodes would break focus, restart CSS transitions, and make the slot panel
 *     animate every turn instead of only when something changed.
 *   - **Text goes through `textContent`.** `innerHTML` is banned by lint, with a
 *     single audited exception for the hand-authored diagram (plan §13).
 */

export interface Component<Props = void> {
  readonly el: HTMLElement;
  /** Apply new props. Must be safe to call with unchanged props. */
  update(props: Props): void;
  /** Release timers, observers and listeners. Optional. */
  destroy?(): void;
}

/** A component that owns no props and only exposes imperative methods. */
export type StaticComponent = Omit<Component<void>, 'update'> & Partial<Pick<Component<void>, 'update'>>;
