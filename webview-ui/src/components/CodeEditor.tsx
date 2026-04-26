/* eslint-disable deepthix/no-inline-colors */
// CodeMirror-6 wrapper used by the FILES pane in place of the plain
// <textarea> for any file extension we recognise as code. Gives us
// syntax highlighting, line numbers, code folding, bracket matching,
// indent guides, and Cmd+S → onSave without dragging in Monaco's
// ~2MB worker bundle. The pixel UI keeps the surrounding chrome —
// only the editing surface is CodeMirror.
//
// Adding a new language: import the lang extension and map its file
// extensions in `extensionToLanguage()`.

import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

interface Props {
  /** File path — used to pick a language by extension. */
  path: string;
  /** Current text in the editor. Controlled. */
  value: string;
  /** Fired on every edit. */
  onChange: (next: string) => void;
  /** Cmd+S handler — wired through CodeMirror's keymap so it works
   *  even when the editor has focus (browser default would Save Page As). */
  onSave: () => void;
}

/**
 * Lightweight code editor based on CodeMirror 6. Picks the language
 * extension by file extension; falls back to plain text when unknown
 * (still nicer than a textarea — line numbers + monospaced font).
 */
export function CodeEditor({ path, value, onChange, onSave }: Props): React.JSX.Element {
  const langExtension = useMemo<Extension[]>(() => {
    const ext = extensionToLanguage(path);
    if (!ext) return [];
    return [ext];
  }, [path]);

  const allExtensions = useMemo<Extension[]>(
    () => [
      ...langExtension,
      // Keymap: Cmd+S (or Ctrl+S) saves. We register it via the editor
      // itself so it fires before the browser's default "Save Page".
      // The CodeMirror EditorView dispatches keys before the document
      // handler — preventing the browser Save dialog reliably.
      keymapForSave(onSave),
    ],
    [langExtension, onSave],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={allExtensions}
      theme={oneDark}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        indentOnInput: true,
        searchKeymap: true,
      }}
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        fontSize: '13px',
      }}
      // Important: the wrapper node has flex:1 above, but @uiw/react-codemirror
      // also needs an explicit height on the inner editor wrapper or it
      // collapses to ~50px. We pass it via the height prop.
      height="100%"
    />
  );
}

/**
 * Maps a file path to the right CodeMirror language extension.
 * Returns null for unknown extensions (caller falls back to plain text
 * editing, which is still a CodeMirror with no language plugin).
 */
function extensionToLanguage(path: string): Extension | null {
  const lower = path.toLowerCase();
  // JS / TS family — share the same lang plugin (jsx flag picks JSX).
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return javascript({ jsx: true, typescript: lower.endsWith('.tsx') });
  if (lower.endsWith('.ts')) return javascript({ typescript: true });
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return javascript();
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return json();
  if (lower.endsWith('.py')) return python();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return markdown();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return yaml();
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml')) return html();
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.sass') || lower.endsWith('.less')) return css();
  if (lower.endsWith('.rs')) return rust();
  if (lower.endsWith('.sql')) return sql();
  if (lower.endsWith('.go')) return go();
  return null;
}

/**
 * Build a CodeMirror keymap extension that maps Cmd+S / Ctrl+S to the
 * caller's onSave. Uses Prec.highest so it wins against the default
 * browser shortcut.
 */
function keymapForSave(onSave: () => void): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSave();
          return true; // prevent default
        },
      },
    ]),
  );
}
