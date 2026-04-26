/* eslint-disable deepthix/no-inline-colors */
// PDF viewer based on react-pdf (which wraps pdfjs-dist). Replaces the
// previous data-URL <iframe> in FilesPane:
//   - works inside Tauri's webview without needing a custom asset
//     protocol or external Reader
//   - gives us pagination + zoom controls instead of relying on
//     whatever the OS PDF plugin happens to ship
//   - no external network — pdfjs ships its worker as a static asset
//     served from /node_modules/pdfjs-dist/build/pdf.worker.min.mjs
//     via Vite's bundling (worker import below)
//
// We accept a base64 string + mime so we can keep using the existing
// `read_file` Tauri command path instead of inventing a streamed
// transport just for PDFs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

// Wire up pdfjs's worker. Vite's `?url` import gives us the bundled
// asset URL at build time — no fetching from a CDN, fully offline.
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
// Prefer the bundled worker so the Reader works offline + with strict
// CSPs. The .mjs file exists in pdfjs-dist@4+.
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface Props {
  /** Base64-encoded PDF bytes (no data: prefix). */
  base64: string;
}

/**
 * Renders a single PDF page at a time with prev/next + zoom controls.
 * Designed to fit inside FilesPane's content area which sets
 * `flex:1, minHeight:0` on its parent — we mirror that.
 */
export function PdfViewer({ base64 }: Props): React.JSX.Element {
  // react-pdf accepts either a URL, a binary Uint8Array, or an object
  // with `data: Uint8Array`. We decode the base64 once and memoise so
  // changing pages/zoom doesn't re-decode the whole blob.
  const data = useMemo<Uint8Array>(() => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }, [base64]);

  // react-pdf v9+ requires that the `file` prop be a stable reference
  // OR object-equal across renders, otherwise it tears down + reloads
  // the document on every parent render. We wrap our Uint8Array in a
  // memoised `{ data }` object so the identity is stable for as long
  // as the source bytes don't change.
  const fileObj = useMemo(() => ({ data }), [data]);

  const [numPages, setNumPages] = useState<number>(0);
  const [pageNum, setPageNum] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [pageWidth, setPageWidth] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-fit page width to the container so the PDF doesn't render at
  // its native size (~600px wide for a US Letter, looks tiny in the
  // pane). Recomputed on resize via ResizeObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      // Subtract padding + scrollbar. 32 chosen to match the wrapper
      // padding (16px each side); the result feels right empirically.
      setPageWidth(Math.max(200, el.clientWidth - 32));
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset to page 1 when a new file is loaded.
  useEffect(() => {
    setPageNum(1);
    setNumPages(0);
  }, [fileObj]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-dark)',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '4px 8px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          fontSize: '12px',
        }}
      >
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <ToolbarButton
            disabled={pageNum <= 1}
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            title="Previous page"
          >
            ‹
          </ToolbarButton>
          <span style={{ minWidth: 64, textAlign: 'center' }}>
            {numPages > 0 ? `${pageNum} / ${numPages}` : '— / —'}
          </span>
          <ToolbarButton
            disabled={pageNum >= numPages}
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            title="Next page"
          >
            ›
          </ToolbarButton>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <ToolbarButton
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            title="Zoom out"
          >
            −
          </ToolbarButton>
          <span style={{ minWidth: 48, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <ToolbarButton onClick={() => setZoom((z) => Math.min(4, z + 0.25))} title="Zoom in">
            +
          </ToolbarButton>
          <ToolbarButton onClick={() => setZoom(1)} title="Reset zoom">
            1×
          </ToolbarButton>
        </div>
      </div>

      {/* Page area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        <Document
          file={fileObj}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          onLoadError={(err) => {
            console.warn('[Deepthix][PdfViewer] load failed', err);
          }}
          loading={<div style={{ opacity: 0.7 }}>Loading PDF…</div>}
          error={<div style={{ color: 'var(--color-danger)' }}>Failed to load PDF.</div>}
        >
          {pageWidth > 0 && (
            <Page
              pageNumber={pageNum}
              width={pageWidth * zoom}
              renderAnnotationLayer
              renderTextLayer
              loading={<div style={{ opacity: 0.7 }}>Rendering page {pageNum}…</div>}
            />
          )}
        </Document>
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '2px 10px',
        background: disabled ? 'transparent' : 'var(--color-accent)',
        color: disabled ? 'inherit' : 'var(--color-bg-dark)',
        border: '2px solid var(--color-border)',
        boxShadow: disabled ? 'none' : 'var(--shadow-pixel)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
        minWidth: 28,
      }}
    >
      {children}
    </button>
  );
}
