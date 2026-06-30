import React, { useState, useEffect } from 'react';
import { Settings, X, Package, RefreshCw, AlertTriangle, ToggleLeft, ToggleRight, Activity, Scissors, Music, Power, CheckCircle2, AlertCircle, PowerOff, ChevronRight, LayoutGrid, HardDrive, Heart, ExternalLink, Monitor, Globe, UserCircle, Plus, Eye, EyeOff, Download, Loader2 } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import {
  addCheckpoint, fetchCheckpoints, fetchHfCache, fetchLocations, fetchModelStatus, formatBytes,
  generateCheckpointConfig, inspectCheckpoint, openLocation, removeCheckpoint, setLocalOnly,
  type CheckpointInspection, type HfRepo, type ModelOptionStatus, type ModelProviderStatus,
  type RegisteredCheckpoint, type StorageLocation,
} from '../../lib/storageClient';
import { useLayoutPrefs, UI_SCALE_MIN, UI_SCALE_MAX } from '../../state/layoutPrefsStore';
import { SlideTrack } from '../audio/SlideTrack';
import { PathInput } from '../ui/PathInput';
import { InfoTip } from '../ui/Tooltip';
import { useSunoStore } from '../../suno/sunoStore';
import { useModuleStore, type ModuleConfig } from '../../state/moduleStore';
import { useDownloadStore } from '../../state/downloadStore';

/* Shared type scale — kept legible (nothing below 9px) and a touch brighter than
 * the old zinc-600/700 greys, which read as background noise. */
const SECTION_TITLE = 'text-[10px] font-black uppercase tracking-widest text-zinc-200';
const SECTION_META = 'text-[9px] font-mono text-zinc-400';
const FIELD_LABEL = 'text-[9px] font-mono uppercase tracking-wider text-zinc-300';

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  // Modules come from the shared store, preloaded on backend-ready (App.tsx).
  const modules = useModuleStore((s) => s.modules);
  const loading = useModuleStore((s) => s.loading && !s.loaded);
  const moduleError = useModuleStore((s) => s.error);
  const loadModules = useModuleStore((s) => s.load);
  const setModuleEnabled = useModuleStore((s) => s.setEnabled);
  const [dirty, setDirty] = useState(false);
  const [changedModules, setChangedModules] = useState<Set<string>>(() => new Set());
  const [toggling, setToggling] = useState<string | null>(null);
  const featureSettings = useFeatureToggleStore((s) => s.settings);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);
  const launchMode = featureSettings.app?.launch_mode ?? 'web';

  // Local mirror of the VJ export root so typing doesn't fire a PATCH per
  // keystroke — we commit on blur / Enter.
  const [vjExportRoot, setVjExportRoot] = useState('');
  useEffect(() => {
    setVjExportRoot(featureSettings.vj?.export_root ?? 'exports/vj');
  }, [featureSettings.vj?.export_root]);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    setChangedModules(new Set());
    void refreshFeatures();
    void loadModules();
  }, [open, refreshFeatures, loadModules]);

  const toggleModule = async (dirName: string, enabled: boolean) => {
    setToggling(dirName);
    try {
      const ok = await setModuleEnabled(dirName, enabled);
      if (ok) {
        setDirty(true);
        setChangedModules((prev) => new Set(prev).add(dirName));
      }
    } finally {
      setToggling(null);
    }
  };

  const commitVjExportRoot = () => {
    const v = vjExportRoot.trim() || 'exports/vj';
    if (v !== (featureSettings.vj?.export_root ?? 'exports/vj')) void patchFeatures({ vj: { export_root: v } });
  };

  // Artist/composer name (appended to songs + stamped on every sheet). Mirrored
  // locally so typing doesn't PATCH per keystroke; committed on blur / Enter.
  const artist = featureSettings.notation?.artist ?? 'GANTASMO';
  const [showName, setShowName] = useState(false);
  const [artistDraft, setArtistDraft] = useState('');
  useEffect(() => { setArtistDraft(featureSettings.notation?.artist ?? 'GANTASMO'); }, [featureSettings.notation?.artist]);
  const commitArtist = () => {
    const v = artistDraft.trim() || 'GANTASMO';
    if (v !== (featureSettings.notation?.artist ?? '')) void patchFeatures({ notation: { artist: v } });
  };

  // Icon-button styling shared by the header's launch-mode + profile toggles.
  const iconBtn = (active: boolean) =>
    `p-1 rounded border transition-colors ${active
      ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
      : 'border-transparent text-zinc-400 hover:text-white hover:bg-white/5'}`;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-120 max-h-[78vh] flex flex-col shadow-2xl">

        {/* Header — title + launch-mode + profile + restart/shutdown + close,
            all icon-only (hover tooltips name each one). */}
        <div className="relative flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <Settings className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 shrink-0">Settings</span>
          <div className="flex items-center gap-1 ml-auto">
            {/* Launch mode — Web vs Desktop next launch (run theDAW.bat). */}
            <button
              type="button"
              onClick={() => void patchFeatures({ app: { launch_mode: 'web' } })}
              title="Next launch: open in your browser (web)"
              aria-label="Web launch mode"
              aria-pressed={launchMode === 'web'}
              className={iconBtn(launchMode === 'web')}
            >
              <Globe className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void patchFeatures({ app: { launch_mode: 'desktop' } })}
              title="Next launch: open the desktop app"
              aria-label="Desktop launch mode"
              aria-pressed={launchMode === 'desktop'}
              className={iconBtn(launchMode === 'desktop')}
            >
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            {/* Profile — artist name appended to songs/scores. */}
            <button
              type="button"
              onClick={() => setShowName((v) => !v)}
              title={`Artist name: ${artist}`}
              aria-label="Set artist name"
              aria-expanded={showName}
              className={iconBtn(showName)}
            >
              <UserCircle className="w-3.5 h-3.5" />
            </button>
            <RestartServerButton compact iconOnly />
            <ShutdownServerButton compact iconOnly />
            <button onClick={onClose} aria-label="Close settings" className="p-1 text-zinc-400 hover:text-white transition-colors rounded hover:bg-white/5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Artist-name popover (toggled by the profile icon). */}
          {showName && (
            <div className="absolute right-4 top-full mt-1 z-10 flex items-center gap-2 rounded-md border border-purple-500/30 bg-[#0c0a14] p-2 shadow-xl">
              <label htmlFor="settings-artist" className="text-[8px] font-mono uppercase tracking-widest text-zinc-400 shrink-0">Artist</label>
              <input
                id="settings-artist"
                name="settings-artist"
                type="text"
                value={artistDraft}
                onChange={(e) => setArtistDraft(e.target.value)}
                onBlur={commitArtist}
                onKeyDown={(e) => { if (e.key === 'Enter') { commitArtist(); setShowName(false); } }}
                placeholder="GANTASMO"
                autoFocus
                className="w-44 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-purple-400/50"
              />
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">

          <StorageSettingsSection />

          {/* Autoprocesses */}
          <section>
            <SectionHeader icon={<Activity className="w-3.5 h-3.5 text-purple-400" />} title="Autoprocesses"
              tip="Opt-in enrichment that runs on its own when the app is idle. Toggle per import and per generate; default OFF, persists across reloads." meta="while idle" />
            <div className="grid grid-cols-2 grid-flow-row-dense gap-1.5">
              <FeatureToggleGroup
                icon={<Activity className="w-3 h-3 text-purple-400" />}
                title="Analyze"
                desc="Detect BPM, key, pitch, bars, codec, and embedded prompts. Local-only and CPU-friendly."
                onImport={featureSettings.analysis.auto_on_import}
                onGenerate={featureSettings.analysis.auto_on_generate}
                onPatchImport={(v) => void patchFeatures({ analysis: { auto_on_import: v } })}
                onPatchGenerate={(v) => void patchFeatures({ analysis: { auto_on_generate: v } })}
              />
              <FeatureToggleGroup
                icon={<Music className="w-3 h-3 text-purple-400" />}
                title="MIDI"
                desc="Transcribe tracks (and stems, when present) to MIDI via basic-pitch / piano-transcription."
                onImport={featureSettings.midi.auto_on_import}
                onGenerate={featureSettings.midi.auto_on_generate}
                onPatchImport={(v) => void patchFeatures({ midi: { auto_on_import: v } })}
                onPatchGenerate={(v) => void patchFeatures({ midi: { auto_on_generate: v } })}
              />
              <FeatureToggleGroup
                className="col-span-2"
                icon={<Scissors className="w-3 h-3 text-purple-400" />}
                title="Stem"
                desc="Split tracks into stems via the Demucs sidecar. Needs the stems module (+ LARSNET weights for 12-stem). Open Options for count, device, and quality."
                onImport={featureSettings.stems.auto_on_import}
                onGenerate={featureSettings.stems.auto_on_generate}
                onPatchImport={(v) => void patchFeatures({ stems: { auto_on_import: v } })}
                onPatchGenerate={(v) => void patchFeatures({ stems: { auto_on_generate: v } })}
                extra={<StemOptions />}
              />
            </div>
          </section>

          <LayoutSettingsSection />

          {/* Backend Modules */}
          <section>
            <SectionHeader icon={<Package className="w-3.5 h-3.5 text-purple-400" />} title="Modules"
              tip="Enable or disable backend modules (effects, stems, MIDI, VJ, and more). Changes take effect after a backend restart." meta="restart to apply" />
            {dirty && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded mb-1.5">
                <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="text-[9px] font-mono text-amber-300">Restart the backend for module changes to take effect.</span>
              </div>
            )}
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-zinc-400">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span className="text-[9px] font-mono">Loading modules...</span>
              </div>
            ) : moduleError ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-[9px] font-mono text-amber-300">Couldn't reach the backend ({moduleError}).</span>
                <button
                  onClick={() => void loadModules()}
                  className="mt-1 px-3 py-1 rounded border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 text-[9px] font-black uppercase tracking-widest"
                >
                  Retry
                </button>
              </div>
            ) : modules.length === 0 ? (
              <div className="text-center py-8 text-[9px] text-zinc-400 font-mono">No modules found in backend/modules/</div>
            ) : (
              <ModuleTree modules={modules} toggling={toggling} changedModules={changedModules} onToggle={(dir, en) => void toggleModule(dir, en)} />
            )}
          </section>

          {/* VJ recording */}
          <section>
            <SectionHeader icon={<Activity className="w-3.5 h-3.5 text-purple-400" />} title="VJ Folder"
              tip="Where VJ recordings are saved. A relative path sits inside the project; Browse fills an absolute folder. Each take adds its record-bar subfolder, then ffmpeg transcodes to the chosen codec." />
            <PathInput
              inline
              id="settings-vj-export-root"
              name="settings-vj-export-root"
              label="Folder"
              value={vjExportRoot}
              onChange={setVjExportRoot}
              kind="folder"
              onBlur={commitVjExportRoot}
              onEnter={commitVjExportRoot}
              placeholder="exports/vj"
              description="Where VJ recordings are saved. A relative path sits inside the project; Browse fills an absolute folder such as D:\Renders."
            />
          </section>

        </div>

        {/* Pinned Support — centered, prominent, always at the bottom */}
        <div className="shrink-0 border-t border-purple-500/20 bg-[#0a080f] px-4 py-2.5 flex flex-col items-center gap-1 text-center">
          <a
            href="https://github.com/sponsors/gantasmo"
            target="_blank"
            rel="noopener noreferrer"
            title="theDAW is independent and self-funded. A sponsorship keeps development going (food, coffee, and compute) and flows straight back into the software."
            className="group inline-flex items-center gap-2 rounded-md border border-purple-400/50 bg-purple-500/20 px-5 py-2 text-[10px] font-black uppercase tracking-widest text-purple-100 shadow-lg shadow-purple-900/30 hover:bg-purple-500/30 hover:border-purple-300/70 hover:text-white transition-colors"
          >
            <Heart className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
            Sponsor theDAW
            <ExternalLink className="w-3 h-3 opacity-70" />
          </a>
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">independent &amp; self-funded</span>
        </div>
      </div>
    </div>
  );
};

/* ── Shared building blocks ───────────────────────────────────────────────── */

/** A section header: icon + terse title + an InfoTip carrying the long
 *  description + an optional right-aligned meta chip + optional extra controls. */
const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  tip?: string;
  meta?: string;
  border?: boolean;
  children?: React.ReactNode;
}> = ({ icon, title, tip, meta, border = true, children }) => (
  <div className={`flex items-center gap-1.5 mb-2 ${border ? 'pt-3 border-t border-white/8' : ''}`}>
    {icon}
    <span className={SECTION_TITLE}>{title}</span>
    {tip && <InfoTip title={title} body={tip} />}
    {children}
    {meta && <span className={`${SECTION_META} ml-auto`}>{meta}</span>}
  </div>
);

/** Segmented two-or-more option toggle (terse pill buttons). */
const Segmented: React.FC<{
  value: string;
  options: ReadonlyArray<readonly string[]>;
  onChange: (v: string) => void;
}> = ({ value, options, onChange }) => (
  <div className="flex items-center gap-1">
    {options.map(([v, lbl]) => (
      <button
        key={v}
        onClick={() => onChange(v)}
        className={`text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border transition-colors ${
          value === v ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
        }`}
      >
        {lbl}
      </button>
    ))}
  </div>
);

/* ── Models (providers, checkpoints, locations, HF cache) ─────────────────── */

const PROVIDERS_CACHE_KEY = 'thedaw-model-providers-cache';
function loadCachedProviders(): ModelProviderStatus[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveCachedProviders(p: ModelProviderStatus[]): void {
  try {
    localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(p));
  } catch {
    /* storage full / unavailable — caching is best-effort */
  }
}

/** Hover detail for a location's size: every model in the directory. */
const locationInventoryTitle = (loc: StorageLocation): string | undefined => {
  const models = loc.models ?? [];
  if (!models.length) return loc.files != null ? `${loc.files} files` : undefined;
  const lines = models.slice(0, 14).map((m) =>
    `${m.recommended ? '★ ' : ''}${m.name} — ${formatBytes(m.bytes)}\n    ${m.path}${m.note ? `\n    ${m.note}` : ''}`);
  if (models.length > 14) lines.push(`…and ${models.length - 14} more`);
  return lines.join('\n');
};

const StorageSettingsSection: React.FC = () => {
  const [registered, setRegistered] = useState<RegisteredCheckpoint[]>([]);
  const [localOnly, setLocalOnlyState] = useState(true);
  // Cards render immediately from the last known set, so they never pop into
  // existence while you're reading elsewhere; a background refresh updates them.
  const [modelProviders, setModelProviders] = useState<ModelProviderStatus[]>(() => loadCachedProviders());
  const [modelStatusLoading, setModelStatusLoading] = useState(false);
  const [modelStatusError, setModelStatusError] = useState<string | null>(null);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [hfRepos, setHfRepos] = useState<HfRepo[]>([]);
  const [hfTotal, setHfTotal] = useState(0);
  const [hfOpen, setHfOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sizesLoading, setSizesLoading] = useState(false);
  const [inspection, setInspection] = useState<CheckpointInspection | null>(null);
  const [generating, setGenerating] = useState(false);

  // The MAKE no-model warning opens Settings with {section:'models'}; pulse it.
  const sectionRef = React.useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    const onFocusModels = (e: Event) => {
      if ((e as CustomEvent).detail?.section !== 'models') return;
      setHighlight(true);
      setTimeout(() => sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
      setTimeout(() => setHighlight(false), 2600);
    };
    window.addEventListener('thedaw:open-settings', onFocusModels);
    return () => window.removeEventListener('thedaw:open-settings', onFocusModels);
  }, []);

  const reload = React.useCallback(() => {
    fetchCheckpoints()
      .then((d) => { setRegistered(d.registered); setLocalOnlyState(d.local_only); })
      .catch(() => undefined);
  }, []);

  const reloadModelStatus = React.useCallback(() => {
    setModelStatusLoading(true);
    setModelStatusError(null);
    fetchModelStatus()
      .then((d) => {
        setModelProviders(d.providers);
        saveCachedProviders(d.providers);
        setLocalOnlyState(d.local_only);
      })
      .catch((e) => {
        setModelStatusError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setModelStatusLoading(false));
  }, []);

  useEffect(() => {
    reload();
    reloadModelStatus();
    setSizesLoading(true);
    fetchLocations().then(setLocations).catch(() => setLocations([])).finally(() => setSizesLoading(false));
    fetchHfCache().then((d) => { setHfRepos(d.repos); setHfTotal(d.total_bytes); }).catch(() => setHfRepos([]));
  }, [reload, reloadModelStatus]);

  const onAdd = async () => {
    const path = addPath.trim();
    if (!path) return;
    setAdding(true);
    setAddError(null);
    setInspection(null);
    try {
      await addCheckpoint(path, addName.trim() || undefined);
      setAddPath('');
      setAddName('');
      reload();
      reloadModelStatus();
    } catch (e) {
      const info = await inspectCheckpoint(path).catch(() => null);
      setInspection(info);
      setAddError(info?.problem ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setAdding(false);
    }
  };

  const onGenerateConfig = async () => {
    const path = addPath.trim();
    if (!path) return;
    setGenerating(true);
    try {
      const r = await generateCheckpointConfig(path);
      if (r.created) {
        setAddError(null);
        setInspection(null);
        await onAdd();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const toggleDownload = () => {
    // "Download missing" is the inverse of local-only; local-only is the safe
    // default, so downloading is what you opt INTO.
    void setLocalOnly(!localOnly)
      .then((enabled) => { setLocalOnlyState(enabled); reloadModelStatus(); })
      .catch(() => undefined);
  };
  const downloadMissing = !localOnly;

  return (
    <section ref={sectionRef} className={highlight ? 'rounded ring-2 ring-purple-500/60 transition-shadow' : undefined}>
      {/* Header: title + tip + refresh, then Download toggle + Add on the right */}
      <SectionHeader icon={<HardDrive className="w-3.5 h-3.5 text-purple-400" />} title="Models"
        tip="Models load on demand at the first CREATE. Safe default is local-only: theDAW never downloads weights until you turn on Download. Register checkpoints you already have, or connect a cloud API.">
        <button type="button" onClick={reloadModelStatus} title="Re-check local models and APIs"
          className="text-zinc-400 hover:text-zinc-100 transition-colors">
          <RefreshCw className={`w-3 h-3 ${modelStatusLoading ? 'animate-spin' : ''}`} />
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={toggleDownload} aria-pressed={downloadMissing}
            title="On: missing models download on first use. Off: local-only (safe default) — missing models warn instead."
            className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white transition-colors">
            {downloadMissing
              ? <ToggleRight className="w-4 h-4 text-amber-400" />
              : <ToggleLeft className="w-4 h-4 text-emerald-400" />}
            Download
          </button>
          <button type="button" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}
            title="Register a checkpoint you already have on disk"
            className={`flex items-center gap-1 text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
              addOpen ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-purple-500/40 text-purple-200 bg-purple-500/10 hover:bg-purple-500/20'
            }`}>
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </SectionHeader>

      {modelStatusError && <p className="mb-1.5 text-[9px] text-rose-300">Model status failed: {modelStatusError}</p>}
      {modelStatusLoading && modelProviders.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-3 text-[9px] font-mono text-zinc-400">
          <RefreshCw className="w-3 h-3 animate-spin" /> Checking local models and APIs…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 mb-1">
          {modelProviders.map((provider) => (
            <ModelProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      )}

      {/* Add-a-checkpoint form (collapsed; opened from the header) */}
      {addOpen && (
        <div className="flex flex-col gap-1.5 mb-1 p-2 rounded border border-purple-500/20 bg-purple-500/5">
          <PathInput
            descriptionHover
            id="settings-ckpt-path"
            name="settings-ckpt-path"
            label="Checkpoint"
            value={addPath}
            onChange={setAddPath}
            kind="folder"
            onEnter={() => void onAdd()}
            placeholder="D:\models\my-finetune"
            description="Browse or paste a folder (or .safetensors) path. The folder needs a model config JSON next to one .safetensors file. Get the config JSON from the matching Hugging Face repo or the training/export artifact. The entry appears in the MAKE model picker."
          />
          <div className="flex gap-1.5">
            <label htmlFor="settings-ckpt-name" className="sr-only">Display name (optional)</label>
            <input
              id="settings-ckpt-name"
              name="settings-ckpt-name"
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onAdd(); }}
              spellCheck={false}
              placeholder="Name (optional)"
              className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none"
            />
            <button
              onClick={() => void onAdd()}
              disabled={adding || !addPath.trim()}
              className="text-[9px] font-black uppercase tracking-widest px-3 rounded border border-purple-500/40 text-purple-200 bg-purple-500/15 hover:bg-purple-500/25 transition-colors disabled:opacity-40"
            >
              {adding ? 'Checking…' : 'Add'}
            </button>
          </div>
          {addError && <p className="text-[9px] text-red-300">{addError}</p>}
          {inspection && !inspection.resolves && inspection.recognized?.config_available && (
            <button
              onClick={() => void onGenerateConfig()}
              disabled={generating}
              className="self-start text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-amber-500/40 text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
              title={`Copies the official ${inspection.recognized.config_name} from your local/cached copy next to the checkpoint. Nothing is guessed and nothing downloads.`}
            >
              {generating ? 'Generating…' : `Generate config (${inspection.recognized.model})`}
            </button>
          )}
        </div>
      )}

      {/* Registered local checkpoints */}
      {registered.length > 0 && (
        <div className="flex flex-col gap-1 mb-1.5">
          {registered.map((ck) => (
            <div key={ck.id} className={`flex items-center gap-2 px-2.5 py-1 rounded border ${ck.resolves ? 'border-white/10 bg-white/3' : 'border-red-500/30 bg-red-500/5'}`}>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold text-zinc-200 truncate">{ck.name}</div>
                <div className="text-[9px] font-mono text-zinc-500 truncate" title={ck.path}>{ck.path}</div>
              </div>
              {!ck.resolves && <span className="text-[9px] font-mono text-red-300 shrink-0">missing</span>}
              <button
                onClick={() => { void openLocation(ck.path).catch(() => undefined); }}
                className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 transition-colors shrink-0"
                aria-label={`Open ${ck.name} in Explorer`}
              >
                Open
              </button>
              <button
                onClick={() => { void removeCheckpoint(ck.id).then(() => { reload(); reloadModelStatus(); }).catch(() => undefined); }}
                className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
                aria-label={`Remove ${ck.name} from the list (files stay on disk)`}
                title="Removes the dropdown entry only — the files stay on disk."
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Locations (HF cache is a row here, expandable on click) */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className={FIELD_LABEL}>Locations</span>
        {sizesLoading && <RefreshCw className="w-2.5 h-2.5 animate-spin text-zinc-400" />}
        <button
          onClick={() => { setSizesLoading(true); fetchLocations(true).then(setLocations).catch(() => undefined).finally(() => setSizesLoading(false)); }}
          className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors ml-auto"
        >
          Refresh
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {locations.map((loc) => (
          <div key={loc.key} className="flex items-center gap-2 px-2.5 py-1 rounded border border-white/5 bg-white/3">
            <div className="min-w-0 flex-1">
              <div className="text-[9px] text-zinc-200 truncate">{loc.label}</div>
              <div className="text-[9px] font-mono text-zinc-500 truncate" title={loc.path ?? undefined}>{loc.path ?? 'not found'}</div>
            </div>
            <span
              className={`text-[9px] font-mono text-zinc-300 tabular-nums shrink-0 ${loc.models?.length ? 'cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2' : ''}`}
              title={locationInventoryTitle(loc)}
            >
              {loc.exists ? formatBytes(loc.bytes) : '—'}
            </span>
            {loc.exists && loc.path && (
              <button
                onClick={() => { void openLocation(loc.path as string).catch(() => undefined); }}
                className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 transition-colors shrink-0"
                aria-label={`Open ${loc.label} in Explorer`}
              >
                Open
              </button>
            )}
          </div>
        ))}

        {/* Hugging Face cache — an expandable Locations row */}
        <div className="rounded border border-white/5 bg-white/3">
          <button
            onClick={() => setHfOpen((v) => !v)}
            aria-expanded={hfOpen}
            className="w-full flex items-center gap-2 px-2.5 py-1 text-left"
          >
            <ChevronRight className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform ${hfOpen ? 'rotate-90' : ''}`} />
            <span className="text-[9px] text-zinc-200 flex-1 min-w-0 truncate">Hugging Face cache</span>
            <span className="text-[9px] font-mono text-zinc-300 tabular-nums shrink-0">{formatBytes(hfTotal)}</span>
          </button>
          {hfOpen && (
            <div className="flex flex-col gap-0.5 px-2 pb-1.5">
              {hfRepos.map((r) => (
                <div key={r.repo_id} className="flex items-center gap-2 px-1.5 py-0.5 rounded border border-white/5">
                  <span className="text-[9px] font-mono text-zinc-300 truncate flex-1" title={r.path}>{r.repo_id}</span>
                  <span className="text-[9px] font-mono text-zinc-400 tabular-nums shrink-0">{formatBytes(r.bytes)}</span>
                  <button
                    onClick={() => { void openLocation(r.path).catch(() => undefined); }}
                    className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 transition-colors shrink-0"
                    aria-label={`Open ${r.repo_id} in Explorer`}
                  >
                    Open
                  </button>
                </div>
              ))}
              {hfRepos.length === 0 && <p className="text-[9px] text-zinc-400 px-1.5 py-0.5">The cache is empty.</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};


const MODEL_STATE_LABELS: Record<string, string> = {
  active: 'Active',
  ready: 'Ready',
  cached: 'Cached',
  local: 'Local',
  needs_setup: 'Setup',
  needs_key: 'Needs key',
  missing_config: 'No config',
  download_blocked: 'Blocked',
  unavailable: 'Unavailable',
};

const modelStateClass = (state: string) => {
  if (state === 'active' || state === 'ready' || state === 'local' || state === 'cached') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (state === 'needs_key' || state === 'needs_setup' || state === 'missing_config' || state === 'download_blocked') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  }
  return 'border-zinc-600/40 bg-white/3 text-zinc-300';
};

const modelSourceClass = (source: string) => {
  if (source === 'local' || source === 'registered' || source === 'api') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (source === 'cached') return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
  if (source === 'download') return 'border-zinc-600/40 bg-white/3 text-zinc-300';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
};

const modelTooltip = (model: ModelOptionStatus) => [
  model.label,
  model.repo_id ? `repo: ${model.repo_id}` : null,
  model.path ? `path: ${model.path}` : null,
  model.reason || null,
].filter(Boolean).join('\n');

/** A provider card — two lines max: name + state, then model chips (or, for
 *  Suno, an inline API-key input). The long summary lives in the hover title. */
const ModelProviderCard: React.FC<{ provider: ModelProviderStatus }> = ({ provider }) => {
  const isSuno = provider.id === 'suno';
  const models = provider.models ?? [];
  const ordered = [...models].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  const visible = ordered.slice(0, 3);
  const hidden = Math.max(0, ordered.length - visible.length);
  // Stable Audio "download" chips become live download triggers. The dock owns
  // all progress/error state — these chips only fire the request and read job
  // status for a compact in-place indicator.
  const downloadJobs = useDownloadStore((s) => s.jobs);
  const startDownload = useDownloadStore((s) => s.startDownload);
  return (
    <article className={`min-w-0 rounded border border-white/8 bg-white/3 px-1.5 py-1 ${isSuno ? 'col-span-2' : ''}`} title={provider.summary}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-bold text-zinc-100 truncate flex-1 min-w-0">{provider.label}</span>
        <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-mono uppercase tracking-wide ${modelStateClass(provider.state)}`}>
          {MODEL_STATE_LABELS[provider.state] ?? provider.state}
        </span>
      </div>
      {isSuno ? (
        <div className="mt-1"><SunoKeyInput /></div>
      ) : visible.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {visible.map((model) => {
            const isDownloadable = provider.id === 'stable' && model.source === 'download';
            if (isDownloadable) {
              const job = downloadJobs.find((j) => j.name === model.id);
              const downloading = job?.status === 'downloading' || job?.status === 'queued';
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => void startDownload(model.id)}
                  disabled={downloading}
                  aria-label={`Download ${model.label} model`}
                  title={modelTooltip(model)}
                  className={`inline-flex items-center gap-1 max-w-full truncate rounded border px-1 py-px text-[9px] font-mono transition-colors ${modelSourceClass(model.source)} hover:bg-purple-500/15 hover:border-purple-400/50 hover:text-purple-100 disabled:cursor-default disabled:opacity-80`}
                >
                  {downloading ? <Loader2 className="w-2 h-2 animate-spin shrink-0" /> : <Download className="w-2 h-2 shrink-0" />}
                  <span className="truncate">{model.recommended ? '★ ' : ''}{model.label}</span>
                </button>
              );
            }
            return (
              <span
                key={model.id}
                title={modelTooltip(model)}
                className={`max-w-full truncate rounded border px-1 py-px text-[9px] font-mono ${modelSourceClass(model.source)}`}
              >
                {model.recommended ? '★ ' : ''}{model.label}
              </span>
            );
          })}
          {hidden > 0 && <span className="rounded border border-white/10 px-1 py-px text-[9px] font-mono text-zinc-400">+{hidden}</span>}
        </div>
      ) : null}
    </article>
  );
};

/** Inline Suno API-key field, rendered inside the Suno provider card. */
const SunoKeyInput: React.FC = () => {
  const [configured, setConfigured] = useState(false);
  const [keyPrefix, setKeyPrefix] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch('/api/suno/status');
      const d = await r.json();
      setConfigured(!!d.configured);
      setKeyPrefix(d.key_prefix ?? null);
    } catch {
      setConfigured(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!val.trim()) return;
    setBusy(true);
    setSaved(false);
    try {
      const r = await fetch('/api/suno/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: val.trim() }),
      });
      if (r.ok) {
        setVal('');
        setSaved(true);
        await refresh();
        void useSunoStore.getState().checkStatus();
        window.setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label htmlFor="suno-api-key" className="sr-only">Suno API key</label>
      <div className="relative flex-1 min-w-0">
        <input
          id="suno-api-key"
          name="suno-api-key"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={configured ? `Connected · ${keyPrefix ?? ''} — paste to replace` : 'sk_live_…  (platform.suno.com)'}
          className="w-full bg-black/40 border border-white/10 rounded px-1.5 py-1 pr-6 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
        />
        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide key' : 'Show key'}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
          {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
      </div>
      <button type="submit" disabled={busy || !val.trim()}
        title="Save the key to the backend and reconnect cloud generation"
        className="shrink-0 px-2 rounded border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 text-purple-200 text-[9px] font-black uppercase tracking-widest flex items-center gap-1">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3" /> : 'Save'}
      </button>
    </form>
  );
};

/* ── Edit Layout (global surface prefs) ───────────────────────────────────── */
const LayoutSettingsSection: React.FC = () => {
  const fillMode = useLayoutPrefs((s) => s.fillMode);
  const gapPx = useLayoutPrefs((s) => s.gapPx);
  const snapPx = useLayoutPrefs((s) => s.snapPx);
  const showGuides = useLayoutPrefs((s) => s.showGuides);
  const matchSizes = useLayoutPrefs((s) => s.matchSizes);
  const setFillMode = useLayoutPrefs((s) => s.setFillMode);
  const setGapPx = useLayoutPrefs((s) => s.setGapPx);
  const setSnapPx = useLayoutPrefs((s) => s.setSnapPx);
  const setShowGuides = useLayoutPrefs((s) => s.setShowGuides);
  const setMatchSizes = useLayoutPrefs((s) => s.setMatchSizes);
  const uiScale = useLayoutPrefs((s) => s.uiScale);
  const setUiScale = useLayoutPrefs((s) => s.setUiScale);
  const scalePct = Math.round(uiScale * 100);
  return (
    <section>
      <SectionHeader icon={<LayoutGrid className="w-3.5 h-3.5 text-purple-400" />} title="Layout"
        tip="Scale grows controls to fill empty space; Compact keeps them natural. Gap sets spacing between panels. Snap sets the drag increment for margins. Per-panel padding, mirror, and placement are edited inside each workspace's Edit Layout mode."
        meta="every workspace" />
      <div className="border border-white/5 rounded px-2 py-2 bg-white/3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={`${FIELD_LABEL} w-10 shrink-0`}>Text</span>
          <SlideTrack
            min={Math.round(UI_SCALE_MIN * 100)}
            max={Math.round(UI_SCALE_MAX * 100)}
            step={5}
            value={scalePct}
            onChange={(v) => setUiScale(v / 100)}
            className="flex-1"
            ariaLabel="App-wide text and UI size"
          />
          <span className="text-[9px] font-mono text-zinc-300 w-9 text-right tabular-nums">{scalePct}%</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <span className={`${FIELD_LABEL} shrink-0`}>Gap</span>
            <SlideTrack min={0} max={24} step={1} value={gapPx} onChange={(v) => setGapPx(v)} className="flex-1" ariaLabel="Gap between panels" />
            <span className="text-[9px] font-mono text-zinc-300 w-8 text-right tabular-nums">{gapPx}px</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`${FIELD_LABEL} shrink-0`}>Snap</span>
            <SlideTrack min={0} max={24} step={1} value={snapPx} onChange={(v) => setSnapPx(v)} className="flex-1" ariaLabel="Snap step when dragging margins" />
            <span className="text-[9px] font-mono text-zinc-300 w-8 text-right tabular-nums">{snapPx === 0 ? 'off' : `${snapPx}px`}</span>
          </div>
        </div>
        <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Fill</span>
            <Segmented value={fillMode} options={[['scale', 'Scale'], ['natural', 'Compact']]} onChange={(v) => setFillMode(v as 'scale' | 'natural')} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Guides</span>
            <Segmented value={showGuides ? 'on' : 'off'} options={[['on', 'On'], ['off', 'Off']]} onChange={(v) => setShowGuides(v === 'on')} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Match</span>
            <Segmented value={matchSizes ? 'on' : 'off'} options={[['on', 'On'], ['off', 'Off']]} onChange={(v) => setMatchSizes(v === 'on')} />
          </div>
          <button
            onClick={() => setUiScale(1)}
            disabled={scalePct === 100}
            className="ml-auto text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-default transition-colors"
            title="Reset text size to 100%"
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  );
};

/* ── Modules as compact grouped tiles ─────────────────────────────────────── */
const MODULE_GROUPS: Record<string, string> = {
  chimera: 'Generation',
  analysis: 'Audio', effects: 'Audio', stems: 'Audio', midi: 'Audio',
  library: 'Library', ytimport: 'Library',
  vj: 'Performance', controllervision: 'Performance',
  settings: 'System',
};
const GROUP_ORDER = ['Generation', 'Audio', 'Library', 'Performance', 'System', 'Other'];

const ModuleTree: React.FC<{
  modules: ModuleConfig[];
  toggling: string | null;
  changedModules: Set<string>;
  onToggle: (dir: string, enabled: boolean) => void;
}> = ({ modules, toggling, changedModules, onToggle }) => {
  const groups: Record<string, ModuleConfig[]> = {};
  for (const m of Array.isArray(modules) ? modules : []) {
    const g = MODULE_GROUPS[m.name] ?? 'Other';
    (groups[g] ??= []).push(m);
  }
  const names = GROUP_ORDER.filter((g) => groups[g]?.length);
  return (
    // Dense 2-col grid: single-tile groups pack side by side; multi-tile groups span full width.
    <div className="grid grid-cols-2 grid-flow-row-dense gap-1.5">
      {names.map((name) => {
        const mods = groups[name];
        const onCount = mods.filter((m) => m.enabled).length;
        const wide = mods.length > 1;
        return (
          <section key={name} className={`rounded border border-white/5 bg-white/3 px-2 py-1.5 ${wide ? 'col-span-2' : ''}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[9px] font-black uppercase tracking-widest text-purple-300">{name}</span>
              <span className="text-[9px] font-mono text-zinc-400 ml-auto">{onCount}/{mods.length}</span>
            </div>
            <div className={`grid ${wide ? 'grid-cols-2' : 'grid-cols-1'} gap-1`}>
              {mods.map((mod) => (
                <ModuleTile
                  key={mod._dir || mod.name}
                  mod={mod}
                  toggling={toggling}
                  changed={changedModules.has(mod._dir || mod.name)}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};

const ModuleTile: React.FC<{
  mod: ModuleConfig;
  toggling: string | null;
  changed: boolean;
  onToggle: (dir: string, enabled: boolean) => void;
}> = ({ mod, toggling, changed, onToggle }) => {
  const key = mod._dir || mod.name;
  const isToggling = toggling === key;
  const hoverInfo = [mod.description, mod.api_prefix].filter(Boolean).join('  ·  ');
  return (
    <article
      title={hoverInfo || undefined}
      className={`min-w-0 rounded border px-2 py-1 flex items-center gap-1.5 transition-colors ${mod.enabled ? 'bg-black/25 border-white/10' : 'bg-black/15 border-white/5 opacity-70'}`}
    >
      <span className="text-[10px] font-bold text-zinc-100 truncate min-w-0 flex-1">{mod.label || mod.name}</span>
      {mod._loaded && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-green-400" title="Running" aria-label="Running" />}
      {changed && <span className="text-[9px] font-mono uppercase tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1 rounded shrink-0">Restart</span>}
      <button
        onClick={() => onToggle(key, !mod.enabled)}
        disabled={isToggling}
        className="shrink-0 transition-opacity disabled:opacity-50"
        title={mod.enabled ? 'Disable module' : 'Enable module'}
        aria-label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.label || mod.name}`}
      >
        {isToggling ? (
          <RefreshCw className="w-4 h-4 text-zinc-400 animate-spin" />
        ) : mod.enabled ? (
          <ToggleRight className="w-5 h-5 text-purple-400" />
        ) : (
          <ToggleLeft className="w-5 h-5 text-zinc-500" />
        )}
      </button>
    </article>
  );
};

/** Restarts the backend by hitting POST /api/admin/restart and then polling
 *  /api/health until the new process answers. */
const RestartServerButton: React.FC<{ compact?: boolean; iconOnly?: boolean }> = ({ compact = false, iconOnly = false }) => {
  type Status = 'idle' | 'restarting' | 'success' | 'error';
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState<string>('');

  const handle = async () => {
    if (status === 'restarting') return;
    setStatus('restarting');
    setDetail('Sending restart signal…');
    try {
      const r = await fetch('/api/admin/restart', { method: 'POST' });
      if (r.status === 412) {
        const body = await r.json().catch(() => ({ detail: '' }));
        setStatus('error');
        setDetail(body.detail || 'Supervisor not detected. Launch via theDAW.bat to enable restart.');
        setTimeout(() => { setStatus('idle'); setDetail(''); }, 10_000);
        return;
      }
      if (!r.ok) throw new Error(`restart endpoint returned ${r.status}`);
      setDetail('Waiting for backend to come back…');
      const deadline = Date.now() + 90_000;
      await new Promise((res) => setTimeout(res, 1500));
      while (Date.now() < deadline) {
        try {
          const h = await fetch('/api/health', { cache: 'no-store' });
          if (h.ok) {
            setStatus('success');
            setDetail('Backend restarted.');
            setTimeout(() => { setStatus('idle'); setDetail(''); }, 4000);
            return;
          }
        } catch {
          // expected during the offline window
        }
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        setDetail(`Waiting for backend to come back… ${remaining}s left`);
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error("backend didn't respond within 90s — it may still be loading; try refreshing the page");
    } catch (e) {
      setStatus('error');
      setDetail(e instanceof Error ? e.message : 'restart failed');
      setTimeout(() => { setStatus('idle'); setDetail(''); }, 10_000);
    }
  };

  const baseCls = iconOnly
    ? 'flex items-center justify-center p-1 rounded border transition-colors'
    : compact
    ? 'flex items-center justify-center gap-1 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors'
    : 'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-[10px] font-black uppercase tracking-widest transition-colors';
  const stateCls: Record<Status, string> = {
    idle: 'border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 hover:border-purple-400/60',
    restarting: 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 cursor-default',
    error: 'border-rose-500/40 bg-rose-500/10 text-rose-200 cursor-default',
  };

  const icon =
    status === 'restarting' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
    : status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" />
    : status === 'error' ? <AlertCircle className="w-3.5 h-3.5" />
    : <Power className="w-3.5 h-3.5" />;

  const label =
    status === 'restarting' ? 'Restarting…'
    : status === 'success' ? 'Back online'
    : status === 'error' ? 'Restart failed'
    : 'Restart';

  return (
    <button type="button" onClick={handle} disabled={status === 'restarting'} className={`${baseCls} ${stateCls[status]}`} title={detail || label} aria-label={label}>
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
};

/** Cleanly stops the theDAW backend (rc=0). */
const ShutdownServerButton: React.FC<{ compact?: boolean; iconOnly?: boolean }> = ({ compact = false, iconOnly = false }) => {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const handle = async () => {
    if (pending || done) return;
    const electron = (window as unknown as {
      electronAPI?: { isElectron?: boolean; quitApp?: () => Promise<void> };
    }).electronAPI;
    const isDesktop = !!electron?.isElectron;
    const ok = window.confirm(
      isDesktop
        ? 'Shut down theDAW?\n\nThis closes the window and stops the backend.'
        : 'Shut down the theDAW backend?\n\nThe browser will lose its connection. Relaunch via theDAW.bat to bring it back.',
    );
    if (!ok) return;
    setPending(true);
    try {
      if (isDesktop && electron?.quitApp) {
        // Closes the window AND kills the backend (main's before-quit handler).
        await electron.quitApp();
      } else {
        await fetch('/api/admin/shutdown', { method: 'POST' });
      }
      setDone(true);
    } catch {
      setDone(true);
    } finally {
      setPending(false);
    }
  };

  const baseCls = iconOnly
    ? 'flex items-center justify-center p-1 rounded border transition-colors'
    : compact
    ? 'flex items-center justify-center gap-1 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors'
    : 'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-[10px] font-black uppercase tracking-widest transition-colors';
  const cls = done
    ? 'border-rose-500/50 bg-rose-500/15 text-rose-200 cursor-default'
    : pending
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:border-rose-400/60';

  const icon = done ? <PowerOff className="w-3.5 h-3.5" /> : pending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <PowerOff className="w-3.5 h-3.5" />;
  const label = done ? 'Offline' : pending ? 'Shutting down…' : 'Shutdown';

  return (
    <button type="button" onClick={handle} disabled={pending || done} className={`${baseCls} ${cls}`} title="Stop the backend entirely (supervisor exits, no respawn)." aria-label={label}>
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
};


interface FeatureToggleGroupProps {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onImport: boolean;
  onGenerate: boolean;
  onPatchImport: (next: boolean) => void;
  onPatchGenerate: (next: boolean) => void;
  /** Optional extra controls, revealed by an Options chevron (kept off the
   *  card's default two lines). */
  extra?: React.ReactNode;
  className?: string;
}

const FeatureToggleGroup: React.FC<FeatureToggleGroupProps> = ({
  icon, title, desc, onImport, onGenerate, onPatchImport, onPatchGenerate, extra, className = '',
}) => {
  const [showExtra, setShowExtra] = useState(false);
  return (
    <div className={`border border-white/5 rounded px-2 py-1.5 bg-white/3 ${className}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] font-bold text-zinc-100">{title}</span>
        <InfoTip title={title} body={desc} />
        {extra && (
          <button
            type="button"
            onClick={() => setShowExtra((v) => !v)}
            aria-expanded={showExtra}
            title="Options"
            className="ml-auto flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Options
            <ChevronRight className={`w-3 h-3 transition-transform ${showExtra ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-4">
        <ToggleRow label="import" enabled={onImport} onToggle={() => onPatchImport(!onImport)} />
        <ToggleRow label="generate" enabled={onGenerate} onToggle={() => onPatchGenerate(!onGenerate)} />
      </div>
      {extra && showExtra && <div className="mt-1.5 pt-1.5 border-t border-white/5">{extra}</div>}
    </div>
  );
};

interface ToggleRowProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, enabled, onToggle }) => (
  <button
    onClick={onToggle}
    className="flex items-center gap-1.5 group"
    title={enabled ? `Disable: ${label}` : `Enable: ${label}`}
  >
    {enabled ? (
      <ToggleRight className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
    ) : (
      <ToggleLeft className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400" />
    )}
    <span className={`text-[9px] font-mono uppercase tracking-widest ${enabled ? 'text-purple-200' : 'text-zinc-400'}`}>
      {label}
    </span>
  </button>
);

/** The stems Autoprocess Options (count / device / quality), revealed on demand. */
const StemOptions: React.FC = () => {
  const stems = useFeatureToggleStore((s) => s.settings.stems);
  const patch = useFeatureToggleStore((s) => s.patch);
  const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center gap-2">
      <span className={`${FIELD_LABEL} w-14 shrink-0`}>{label}</span>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
  const Pill: React.FC<{ active: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }> = ({ active, disabled, title, onClick, children }) => (
    <button
      onClick={() => { if (!disabled) onClick(); }}
      disabled={disabled}
      title={title}
      className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
        active ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
        : disabled ? 'border-white/5 text-zinc-600 cursor-not-allowed line-through'
        : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <Row label="Count">
        {[{ v: 2, h: 'vocals + accompaniment' }, { v: 4, h: 'vocals, drums, bass, other' }, { v: 6, h: '+ guitar, piano' }, { v: 12, h: '+ LARSNET drum sub-stems' }].map((o) => (
          <Pill key={o.v} active={stems.default_count === o.v} title={o.h} onClick={() => void patch({ stems: { default_count: o.v } })}>{o.v}</Pill>
        ))}
      </Row>
      <Row label="Device">
        {[{ v: 'cuda', l: 'GPU', e: true }, { v: 'cpu', l: 'CPU', e: true }, { v: 'cloud-runpod', l: 'RunPod', e: false }, { v: 'cloud-cloudflare', l: 'Cloudflare', e: false }, { v: 'cloud-colab', l: 'Colab', e: false }].map((o) => (
          <Pill key={o.v} active={stems.device === o.v} disabled={!o.e} title={o.e ? o.l : `${o.l} — coming soon`} onClick={() => void patch({ stems: { device: o.v } })}>{o.l}</Pill>
        ))}
      </Row>
      <Row label="Quality">
        {[{ v: 'fast', l: 'Fast', h: 'shifts=1, overlap=0.25 — ~30s/track' }, { v: 'balanced', l: 'Balanced', h: 'shifts=2, overlap=0.5 — ~1-2 min/track' }, { v: 'hq', l: 'HQ', h: 'shifts=10, overlap=0.9 — 5-15 min/track' }].map((o) => (
          <Pill key={o.v} active={stems.quality === o.v} title={o.h} onClick={() => void patch({ stems: { quality: o.v } })}>{o.l}</Pill>
        ))}
      </Row>
    </div>
  );
};
