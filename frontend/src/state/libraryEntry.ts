/**
 * Shared `LibraryEntry` types. Kept in their own module so both the
 * Zustand `libraryStore` and the `StorageProvider` interface can import
 * them without circular-dependency pain.
 */

export interface LibraryEntry {
  id: string;
  title: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  /**
   * URL the browser can fetch/stream the audio from. Backed by the
   * configured storage provider (default: `/api/library/audio/<id>`).
   * No `audioBlob` field — bytes are fetched on demand via the provider.
   */
  audioUrl: string;
  audioFilename: string;
  fileSizeBytes: number;
  mimeType: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  source: 'generate' | 'studio' | 'import';
  chimeraSources?: string[];
  /** Persistent play counter, incremented when the track starts in the player. */
  playCount?: number;
  /** Unix seconds of the last play, or null when never played. */
  lastPlayedAt?: number | null;
  /**
   * Media kind. 'audio' is the default and original citizen. 'video' and
   * 'image' entries back the VJ video library + overlays; they carry
   * `mediaUrl` / `thumbUrl` / dimensions / `hasAlpha` instead of audio
   * analysis. `audioUrl` falls back to the media URL for these so generic
   * consumers never see an empty URL.
   */
  kind?: 'audio' | 'video' | 'image';
  mediaUrl?: string;
  thumbUrl?: string | null;
  width?: number | null;
  height?: number | null;
  /** True for transparent PNG/WebP or alpha WebM — overlay-capable media. */
  hasAlpha?: boolean;
  /**
   * Computed musical analysis attached by the backend list/get endpoints when
   * the entry has been analyzed: a FLAT scalar dict (bpm, key, scale,
   * loudness_lufs, rms_db, pitch_*, bars_estimated, genre, semantic_tags, plus
   * a few ffprobe technicals like sample_rate/codec). Undefined until the
   * background analyzer has run. The Catalogue inspector renders every key and
   * `libraryStore.getFiltered` folds the values into its search haystack — both
   * already read this field; it was simply never populated before.
   */
  analysis?: Record<string, unknown>;
  /**
   * Tags embedded INSIDE the audio file (ID3 / Vorbis / iTunes), parsed from
   * the stored analysis row's `embedded_tags_json`. Undefined when the source
   * file carried none (typical for freshly-generated tracks). Surfaced
   * key-by-key in the inspector's EMBEDDED TAGS section.
   */
  embeddedTags?: Record<string, unknown>;
}

/** Subset of fields a client is allowed to PATCH. Must match the
 * backend's USER_MUTABLE_FIELDS set in `backend/modules/library/store.py`. */
export interface LibraryEntryPatch {
  title?: string;
  favorite?: boolean;
  rating?: 'like' | 'dislike' | null;
  tags?: string[];
  notes?: string;
  chimeraSources?: string[];
}

/** Payload for uploading a new entry (studio output, bucket import, etc). */
export interface ImportRequest {
  blob: Blob;
  filename: string;
  mimeType?: string;
  metadata?: {
    title?: string;
    prompt?: string;
    negativePrompt?: string;
    model?: string;
    duration?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
    source?: 'generate' | 'studio' | 'import';
    tags?: string[];
    chimeraSources?: string[];
  };
}

