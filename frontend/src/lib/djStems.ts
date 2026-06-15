import { logError, logInfo } from '../state/logStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';

/* DJ live stems (D4) — list / separate / resolve URLs for the stems backend
 * (`backend/modules/stems`). Cached stems are served at
 * `/api/library/stems/{stem_id}/audio`; separation runs foreground via
 * `POST /api/stems/{entry}/run` (resolves when done). The djEngine then decodes
 * the returned URLs into per-stem live faders. */

export interface StemRef { name: string; url: string; }

interface StemRow { id?: string; stem_name?: string; name?: string }

/** List an entry's already-separated stems (empty if none cached yet). */
export async function listStems(entryId: string): Promise<StemRef[]> {
  try {
    const r = await fetch(`/api/stems/${encodeURIComponent(entryId)}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const rows: StemRow[] = Array.isArray(j?.stems) ? j.stems : [];
    return rows
      .filter((s) => !!s.id)
      .map((s) => ({ name: s.stem_name || s.name || 'stem', url: `/api/library/stems/${s.id}/audio` }));
  } catch {
    return [];
  }
}

export interface SeparateOpts { stems?: 2 | 4 | 6 | 12; device?: string; quality?: string }

/** Return cached stems, else run separation (foreground; resolves when done),
 *  polling progress for a % while the run is in flight, then list the result. */
export async function ensureStems(
  entryId: string,
  opts: SeparateOpts = {},
  onProgress?: (pct: number, phase: string) => void,
): Promise<StemRef[]> {
  const stems = opts.stems ?? 4;
  const device = opts.device ?? 'auto';
  const quality = opts.quality ?? 'fast';
  const existing = await listStems(entryId);
  if (existing.length >= stems) {
    onProgress?.(100, 'cached');
    return existing;
  }
  if (existing.length) {
    logInfo('dj-stems', `Upgrading ${entryId} from ${existing.length} cached stem(s) to ${stems} stem(s)…`);
  }
  logInfo('dj-stems', `Separating ${entryId} (${stems} stems, ${quality})…`);

  let polling = true;
  void (async () => {
    while (polling) {
      try {
        const pr = await fetch(`/api/stems/${encodeURIComponent(entryId)}/progress`);
        if (pr.ok) {
          const p = await pr.json();
          if (p && p.phase && p.phase !== 'idle') {
            const raw = typeof p.progress === 'number' ? p.progress : 0;
            onProgress?.(Math.round((raw <= 1 ? raw * 100 : raw)), String(p.phase));
          }
        }
      } catch { /* ignore poll error */ }
      await new Promise((res) => setTimeout(res, 1500));
    }
  })();

  try {
    const res = await fetch(
      `/api/stems/${encodeURIComponent(entryId)}/run?stems=${stems}&device=${device}&quality=${quality}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || `separation failed (${res.status})`);
    }
  } catch (e) {
    logError('dj-stems', `Separation failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    polling = false;
  }
  return listStems(entryId);
}

export async function prepareStems(
  entryId: string,
  opts: SeparateOpts = {},
  onProgress?: (pct: number, phase: string) => void,
): Promise<StemRef[]> {
  onProgress?.(0, 'analyzing');
  await useDjAnalysisStore.getState().ensureAnalyzed(entryId);

  const analysis = useDjAnalysisStore.getState().byId[entryId];
  if (analysis?.status === 'error') {
    throw new Error('analysis failed');
  }

  onProgress?.(0, 'checking_stems');
  return ensureStems(entryId, opts, onProgress);
}
