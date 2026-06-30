/**
 * Client for the backend generic FFmpeg convert module (`/api/convert`).
 *
 * The catalog (target formats + source-kind -> target-kind rules) is fetched
 * once and cached. Converting a library entry streams the result back as bytes
 * and triggers a download. Large media is read via arrayBuffer() rather than
 * blob() (the latter spills to a disk-backed store that fails under disk
 * pressure — see fetchRetry.ts).
 */

export interface ConvertFormat {
  id: string;
  ext: string;
  kind: 'audio' | 'video' | 'image';
  label: string;
  mime: string;
}

export interface ConvertCatalog {
  formats: ConvertFormat[];
  rules: Record<string, string[]>;
}

let _catalog: ConvertCatalog | null = null;
let _inflight: Promise<ConvertCatalog> | null = null;

export async function loadConvertFormats(): Promise<ConvertCatalog> {
  if (_catalog) return _catalog;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const res = await fetch('/api/convert/formats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as ConvertCatalog;
    _catalog = catalog;
    _inflight = null;
    return catalog;
  })().catch((e) => {
    _inflight = null;
    throw e;
  });
  return _inflight;
}

/** The target formats that make sense for a given source media kind. */
export function formatsForKind(catalog: ConvertCatalog, kind: string): ConvertFormat[] {
  const allowed = new Set(catalog.rules[kind] ?? ['audio', 'video', 'image']);
  return catalog.formats.filter((f) => allowed.has(f.kind));
}

/**
 * Convert a library entry to the given format and download the result.
 * Resolves when the download has been triggered; rejects with a readable
 * message on failure.
 */
export async function convertLibraryEntry(
  entryId: string,
  format: ConvertFormat,
  title: string,
): Promise<void> {
  const res = await fetch(`/api/convert/library/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: format.id }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* response had no JSON body */
    }
    throw new Error(detail);
  }

  const buf = await res.arrayBuffer();
  const blob = new Blob([buf], { type: res.headers.get('content-type') ?? format.mime });
  const url = URL.createObjectURL(blob);
  const safeTitle = (title || 'converted').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeTitle}.${format.ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
