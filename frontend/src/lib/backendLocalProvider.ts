/**
 * StorageProvider implementation that talks to the backend's
 * `/api/library/*` endpoints. Audio lives on the server's filesystem
 * (default: `<project>/data/generations/`). This is the default for the
 * local-dev / self-hosted use case.
 *
 * A future cloud provider (S3 / R2 / Drive) plugs into the same
 * `StorageProvider` interface.
 */

import type {
  ImportRequest,
  LibraryEntry,
  LibraryEntryPatch,
} from '../state/libraryEntry';
import type { StorageProvider } from './storageProvider';
import { fetchBlobWithRetry } from './fetchRetry';

const DEFAULT_BASE = '/api/library';

interface ServerRecord {
  id: string;
  title: string;
  prompt: string;
  negative_prompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  audio_url: string;
  audio_filename: string;
  file_size_bytes: number;
  mime_type: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  source: string;
  chimera_sources?: string[];
  play_count?: number;
  last_played_at?: number | null;
  // Enrichment attached by the backend's `_attach_analysis` (only present once
  // the entry has been analyzed). Flat scalar analysis dict + parsed embedded
  // file tags — see LibraryEntry.analysis / .embeddedTags.
  analysis?: Record<string, unknown>;
  embedded_tags?: Record<string, unknown>;
}

const toEntry = (r: ServerRecord): LibraryEntry => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  negativePrompt: r.negative_prompt,
  model: r.model,
  duration: r.duration,
  steps: r.steps,
  cfg: r.cfg,
  seed: r.seed,
  audioUrl: r.audio_url,
  audioFilename: r.audio_filename,
  fileSizeBytes: r.file_size_bytes,
  mimeType: r.mime_type,
  timestamp: r.timestamp,
  favorite: r.favorite,
  rating: r.rating,
  tags: r.tags ?? [],
  notes: r.notes ?? '',
  source: (['generate', 'studio', 'import'].includes(r.source)
    ? r.source
    : 'generate') as LibraryEntry['source'],
  chimeraSources: r.chimera_sources ?? [],
  playCount: r.play_count ?? 0,
  lastPlayedAt: r.last_played_at ?? null,
  // Pass the backend analysis enrichment straight through (snake_case →
  // camelCase only). Left undefined when the entry hasn't been analyzed, which
  // the inspector + search treat as "no extra data" rather than empty objects.
  analysis: r.analysis,
  embeddedTags: r.embedded_tags,
});

const patchToServerKeys = (patch: LibraryEntryPatch): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.favorite !== undefined) body.favorite = patch.favorite;
  if (patch.rating !== undefined) body.rating = patch.rating;
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.chimeraSources !== undefined) body.chimera_sources = patch.chimeraSources;
  return body;
};

const errorText = async (r: Response): Promise<string> => {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    if (body?.detail) return JSON.stringify(body.detail);
  } catch {
    /* fall through */
  }
  return `HTTP ${r.status} ${r.statusText}`;
};

export class BackendLocalProvider implements StorageProvider {
  readonly name = 'backend-local';
  private readonly base: string;

  constructor(base: string = DEFAULT_BASE) {
    this.base = base.replace(/\/$/, '');
  }

  async list(): Promise<LibraryEntry[]> {
    const r = await fetch(`${this.base}/entries`);
    if (!r.ok) throw new Error(`library.list: ${await errorText(r)}`);
    const body = (await r.json()) as { entries: ServerRecord[] };
    return (body.entries ?? []).map(toEntry);
  }

  async get(id: string): Promise<LibraryEntry | null> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`library.get(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async import(req: ImportRequest): Promise<LibraryEntry> {
    const form = new FormData();
    form.append('file', req.blob, req.filename);
    const metaPayload: Record<string, unknown> = {};
    if (req.metadata) {
      const m = req.metadata;
      if (m.title !== undefined) metaPayload.title = m.title;
      if (m.prompt !== undefined) metaPayload.prompt = m.prompt;
      if (m.negativePrompt !== undefined) metaPayload.negative_prompt = m.negativePrompt;
      if (m.model !== undefined) metaPayload.model = m.model;
      if (m.duration !== undefined) metaPayload.duration = m.duration;
      if (m.steps !== undefined) metaPayload.steps = m.steps;
      if (m.cfg !== undefined) metaPayload.cfg = m.cfg;
      if (m.seed !== undefined) metaPayload.seed = m.seed;
      if (m.source !== undefined) metaPayload.source = m.source;
      if (m.tags !== undefined) metaPayload.tags = m.tags;
      if (m.chimeraSources !== undefined) metaPayload.chimera_sources = m.chimeraSources;
    }
    form.append('metadata', JSON.stringify(metaPayload));

    const r = await fetch(`${this.base}/import`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`library.import: ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async update(id: string, patch: LibraryEntryPatch): Promise<LibraryEntry> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchToServerKeys(patch)),
    });
    if (!r.ok) throw new Error(`library.update(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async delete(id: string): Promise<void> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok && r.status !== 404) {
      throw new Error(`library.delete(${id}): ${await errorText(r)}`);
    }
  }

  getAudioUrl(entry: LibraryEntry): string {
    return entry.audioUrl;
  }

  // Session-scoped blob cache so multiple consumers don't re-fetch the
  // same audio. Keyed by entry id. Cleared on page reload.
  private readonly blobCache = new Map<string, Promise<Blob>>();

  async fetchAudioBlob(entry: LibraryEntry): Promise<Blob> {
    const cached = this.blobCache.get(entry.id);
    if (cached) return cached;
    // Resilient fetch: the single-worker backend can stall mid-stream while it
    // loads a model, dropping a large audio response even after a 200. Short
    // retries ride over that window instead of surfacing "Failed to fetch".
    const promise = fetchBlobWithRetry(entry.audioUrl, { label: entry.title || entry.id });
    this.blobCache.set(entry.id, promise);
    try {
      return await promise;
    } catch (e) {
      this.blobCache.delete(entry.id);
      throw e;
    }
  }
}

let _provider: StorageProvider | null = null;

export const getStorageProvider = (): StorageProvider => {
  if (_provider === null) {
    _provider = new BackendLocalProvider();
  }
  return _provider;
};

/** Tests / future settings UI can swap the active provider. */
export const setStorageProvider = (provider: StorageProvider): void => {
  _provider = provider;
};

