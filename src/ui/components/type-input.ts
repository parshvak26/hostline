/**
 * The typed path (T-048, plan §14).
 *
 * "Voice is never required" is a requirement, not a fallback: the whole booking
 * completes here, through the same orchestrator, with no microphone and no
 * pointer. That is why this is a real `<form>` with a real `<label>` rather
 * than a styled div — submission on Enter, a named field, and a submit button
 * are all free that way, and free is what survives a refactor.
 *
 * Visually secondary, structurally first-class. It is present from the start
 * and only hidden when the composition root says so.
 */

import { el } from '../a11y.js';
import type { Component } from './component.js';

export interface TypeInputProps {
  readonly visible: boolean;
  readonly disabled: boolean;
  /** Overrides the field label, for example while the agent asks for a name. */
  readonly label?: string;
}

export interface TypeInputOptions {
  /** Receives the trimmed text. Never called with an empty string. */
  onSubmit(text: string): void;
}

const DEFAULT_LABEL = 'Type your reply';

/** Ids must be unique for `for`/`id` to mean anything if two are ever mounted. */
let sequence = 0;

export function createTypeInput(options: TypeInputOptions): Component<TypeInputProps> {
  sequence += 1;
  const fieldId = `type-input-field-${sequence}`;

  const field = el('input', {
    className: 'type-input__field',
    attrs: {
      id: fieldId,
      type: 'text',
      name: 'reply',
      autocomplete: 'off',
      autocapitalize: 'sentences',
      enterkeyhint: 'send',
    },
  });

  const label = el('label', {
    className: 'type-input__label',
    text: DEFAULT_LABEL,
    attrs: { for: fieldId },
  });

  const send = el('button', { className: 'type-input__send', text: 'Send', attrs: { type: 'submit' } });

  const hint = el('p', {
    className: 'type-input__hint small',
    text: 'The whole booking works by typing, with no microphone.',
  });

  const form = el('form', {
    className: 'type-input',
    attrs: { novalidate: '' },
    children: [label, el('div', { className: 'type-input__row', children: [field, send] }), hint],
  });

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const text = field.value.trim();
    // A stray Enter on an empty field is the commonest accident here; silence
    // is the right response, not an error the visitor has to dismiss.
    if (text === '') return;
    field.value = '';
    options.onSubmit(text);
  };

  form.addEventListener('submit', onSubmit);

  return {
    el: form,

    update(props: TypeInputProps): void {
      form.hidden = !props.visible;
      field.disabled = props.disabled;
      send.disabled = props.disabled;
      label.textContent = props.label ?? DEFAULT_LABEL;
    },

    destroy(): void {
      form.removeEventListener('submit', onSubmit);
    },
  };
}
