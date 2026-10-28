// Builds the model-agnostic completion context around the cursor.
//
// The text above the cursor is split into a "stable" part, whose boundaries
// are aligned to STEP-line chunks so it stays byte-identical while the user
// types nearby (this is what makes prompt caching hit), and a "near" part
// that changes on every keystroke.

const STEP = 32;

export const CURSOR = '<CURSOR>';

export const OPEN_TAG = '<completion>';
export const CLOSE_TAG = '</completion>';

export const SYSTEM_PROMPT = `You are a code completion engine embedded in a text editor.
The user message contains a source file with the marker ${CURSOR} at the cursor position.
Reply with exactly ${OPEN_TAG}TEXT${CLOSE_TAG}, where TEXT is inserted verbatim at ${CURSOR}:
- nothing outside the tags: no explanations, no markdown code fences
- do not repeat text that already exists before or after the cursor
- continue from the exact character before the cursor, matching the file's style and indentation
- prefer finishing the current statement or block and stop at a natural boundary
- complete only at ${CURSOR}; ignore unfinished code elsewhere in the file
If nothing should be inserted, reply ${OPEN_TAG}${CLOSE_TAG}.`;

// Text inside the completion tag; anything else the model says is discarded.
// The closing tag may be missing (stop sequence or early abort).
export function extractCompletion(raw) {
  const start = raw.indexOf(OPEN_TAG);
  if (start < 0) return '';
  const body = raw.slice(start + OPEN_TAG.length);
  const end = body.indexOf(CLOSE_TAG);
  return end < 0 ? body : body.slice(0, end);
}

export function splitLines(text) {
  return text.split(/\r\n|\n/);
}

export function buildContext(doc, position, { linesBefore = 200, linesAfter = 50 } = {}) {
  const lines = splitLines(doc.text);
  const row = Math.min(position.line, lines.length - 1);
  const line = lines[row] ?? '';
  // LSP positions are UTF-16 code units, which is what JS strings index by.
  const prefixLine = line.slice(0, position.character);
  const suffixLine = line.slice(position.character);

  const stableEnd = Math.floor(row / STEP) * STEP;
  const stableStart = Math.max(0, Math.floor((row - linesBefore) / STEP) * STEP);
  const afterEnd = Math.min(lines.length, row + 1 + linesAfter);

  const header = `<file path="${doc.path}" language="${doc.languageId || 'text'}">\n` +
    (stableStart > 0 ? '... (earlier lines omitted)\n' : '');
  const stableLines = lines.slice(stableStart, stableEnd);
  const nearLines = lines.slice(stableEnd, row);
  const afterLines = lines.slice(row + 1, afterEnd);

  return {
    languageId: doc.languageId,
    path: doc.path,
    row,
    prefixLine,
    suffixLine,
    // Mid-line completion: only finish the current line.
    singleLine: suffixLine.trim().length > 0,
    stable: stableLines.length ? header + stableLines.join('\n') + '\n' : '',
    volatile: (stableLines.length ? '' : header) +
      (nearLines.length ? nearLines.join('\n') + '\n' : '') +
      prefixLine + CURSOR + suffixLine +
      (afterLines.length ? '\n' + afterLines.join('\n') : '') +
      (afterEnd < lines.length ? '\n... (later lines omitted)' : '') +
      '\n</file>',
    // Full text around the cursor, used to recognise "user typed into the suggestion".
    before: lines.slice(0, row).join('\n') + (row > 0 ? '\n' : '') + prefixLine,
    after: suffixLine + '\n' + lines.slice(row + 1).join('\n'),
    nextLines: afterLines,
    // Same window as the chat prompt, as plain text for fill-in-the-middle models.
    fimPrefix: [...lines.slice(stableStart, row), prefixLine].join('\n'),
    fimSuffix: [suffixLine, ...afterLines].join('\n'),
  };
}

export function instructions(ctx, { variant = false } = {}) {
  const parts = [`${CURSOR} is on line ${ctx.row + 1}, after ${JSON.stringify(ctx.prefixLine)}.`];
  if (ctx.singleLine) parts.push(`Complete only the rest of the current line, up to the existing text after ${CURSOR}.`);
  if (variant) parts.push('Give a different plausible completion than the most obvious one.');
  return parts.join('\n');
}
