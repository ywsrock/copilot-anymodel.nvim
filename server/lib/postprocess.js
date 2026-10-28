// Cleans raw model output into the exact text to insert at the cursor.

import { CURSOR, splitLines } from './prompt.js';

export function clean(raw, ctx, { maxLines = 8 } = {}) {
  let text = raw.replaceAll('\r\n', '\n');

  // Strip markdown fences the model may add despite instructions.
  text = text.replace(/^\s*```[\w+-]*\n/, '').replace(/\n?```\s*$/, '');
  text = text.replaceAll(CURSOR, '');

  // The model sometimes echoes the current line before continuing it.
  const typed = ctx.prefixLine.trimStart();
  if (typed && text.trimStart().startsWith(typed)) {
    text = text.trimStart().slice(typed.length);
  }

  let lines = splitLines(text);
  if (ctx.singleLine) lines = lines.slice(0, 1);
  lines = lines.slice(0, maxLines);

  // Cut where the completion runs into code that already follows the cursor.
  const next = ctx.nextLines.map((l) => l.trim()).find(Boolean);
  if (next) {
    const hit = lines.findIndex((l, i) => i > 0 && l.trim() === next);
    if (hit > 0) lines = lines.slice(0, hit);
  }
  text = lines.join('\n').replace(/\s+$/, '');

  // Mid-line: drop the overlap with the existing text after the cursor, e.g. ")".
  const suffix = ctx.suffixLine.trim();
  if (suffix) {
    for (let k = Math.min(suffix.length, text.length); k > 0; k--) {
      if (text.endsWith(suffix.slice(0, k))) {
        text = text.slice(0, -k).replace(/\s+$/, '');
        break;
      }
    }
  }
  return text;
}

// copilot.vim expects insertText to start at range.start (column 0 here) and
// compares it with what is already typed on the line.
export function toItem(completion, ctx, position) {
  const prefix = ctx.prefixLine;
  const insertText = prefix.trim() === '' && /^\s/.test(completion)
    ? completion // model supplied its own indentation for this line
    : prefix + completion;
  return {
    insertText,
    range: {
      start: { line: position.line, character: 0 },
      end: { line: position.line, character: position.character },
    },
  };
}
