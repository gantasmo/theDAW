export interface NotationArtifact {
  id: string;
  entry_id: string;
  kind: 'midi' | 'musicxml' | 'pdf' | 'svg' | 'alphatex' | 'guitarpro' | 'abc' | string;
  source_ref?: string | null;
  path: string;
  engine: string;
  engine_version: string;
  metadata_json?: string;
  created_at: number;
}

export async function listNotationArtifacts(entryId: string, kind?: string): Promise<NotationArtifact[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/artifacts${qs}`);
  if (!res.ok) throw new Error(`notation artifacts HTTP ${res.status}`);
  const payload = await res.json() as { artifacts?: NotationArtifact[] };
  return payload.artifacts ?? [];
}

export async function convertMidiToMusicXml(entryId: string, midiId: string): Promise<NotationArtifact | null> {
  const res = await fetch(
    `/api/notation/${encodeURIComponent(entryId)}/from-midi/${encodeURIComponent(midiId)}`,
    { method: 'POST' },
  );
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `notation conversion HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export interface NotationCapabilities {
  ok: boolean;
  music21: boolean;
  musescore: boolean;
  musescore_path?: string | null;
  formats: string[];
  tab_tunings?: string[];
  arrangement_styles?: string[];
  engines?: Record<string, unknown>;
}

export interface MakeTabsRequest {
  source_artifact_id?: string;
  midi_id?: string;
  instrument?: string;
  tuning_name?: string;
  tuning?: number[];
  capo?: number;
  difficulty?: string;
}

export interface MakeArrangementRequest {
  style: string;
  source_artifact_id?: string;
  source_artifact_ids?: string[];
  midi_id?: string;
}

export async function getNotationCapabilities(): Promise<NotationCapabilities> {
  const res = await fetch('/api/notation');
  if (!res.ok) throw new Error(`notation capabilities HTTP ${res.status}`);
  return await res.json() as NotationCapabilities;
}

export async function exportArtifact(
  entryId: string,
  sourceArtifactId: string,
  format: string,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_artifact_id: sourceArtifactId, format }),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `notation export HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export async function makeTabs(
  entryId: string,
  req: MakeTabsRequest,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `tab generation HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export async function makeArrangement(
  entryId: string,
  req: MakeArrangementRequest,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/arrange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `arrangement HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export function notationArtifactUrl(artifactId: string): string {
  return `/api/notation/file/${encodeURIComponent(artifactId)}`;
}

/** Download a score as a zip of the source + a PDF (PDF when MuseScore is
 *  installed; the MusicXML is always included). Use for musicxml sheets. */
export function notationPackUrl(artifactId: string): string {
  return `/api/notation/pack/${encodeURIComponent(artifactId)}`;
}