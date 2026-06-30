import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  FileDown,
  FolderInput,
  Layers,
  Loader2,
  PackagePlus,
  Play,
  Square,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDawImportStore } from '../../state/dawImportStore';
import { useProjectStore } from '../../state/projectStore';
import { PathInput } from '../ui/PathInput';
import { DAW_LABELS, dawImportAudioUrl } from '../../lib/dawImportClient';
import type { DawClip, DawProject } from '../../lib/dawImportClient';
import { dawProjectToTasmo } from '../../lib/projectClient';
import { DAW_PROJECT_FILTER } from '../../lib/fileFilters';

export const DawImportModal: React.FC = () => {
  const { isOpen, sourcePath, detected, project, hint, busy, error } = useDawImportStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      sourcePath: s.sourcePath,
      detected: s.detected,
      project: s.project,
      hint: s.hint,
      busy: s.busy,
      error: s.error,
    })),
  );
  const close = useDawImportStore((s) => s.close);
  const setSourcePath = useDawImportStore((s) => s.setSourcePath);
  const detectAndImport = useDawImportStore((s) => s.detectAndImport);
  const openProject = useProjectStore((s) => s.open);

  if (!isOpen) return null;

  const saveAsTasmo = () => {
    if (!project) return;
    openProject('save', dawProjectToTasmo(project));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative bg-[#0c0a14] border border-sky-500/30 rounded-lg w-[min(1100px,94vw)] max-h-[86vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <FolderInput className="w-3.5 h-3.5 text-sky-300 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-sky-200">
            Import DAW Project
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="ml-auto p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-3">
          <PathInput
            id="daw-import-path"
            name="daw_import_path"
            label="Project file"
            kind="file"
            fileFilter={DAW_PROJECT_FILTER}
            value={sourcePath}
            onChange={setSourcePath}
            onEnter={() => void detectAndImport()}
            placeholder=".als .RPP .flp .aup3 .sesx .bwproject .avc .logicx"
            description="Ableton, Reaper, FL Studio, Audacity, Audition, Bitwig and Resolume import directly. Logic / Cubase / Pro Tools show an export-to-audio guide."
          />

          <button
            type="button"
            onClick={() => void detectAndImport()}
            disabled={busy || !sourcePath.trim()}
            className="btn-primary inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
            Detect &amp; Import
          </button>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
              <span className="text-[9px] font-mono text-red-200">{error}</span>
            </div>
          )}

          {detected && (
            <div className="text-[9px] font-mono text-zinc-400">
              Detected:{' '}
              <span className="text-sky-200">{DAW_LABELS[detected.daw] ?? detected.daw}</span>{' '}
              <span className="text-zinc-600">(.{detected.format})</span>
            </div>
          )}

          {/* Parsed project preview */}
          {project && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-300">
                <Layers className="w-3.5 h-3.5 text-sky-300" />
                <span className="font-bold text-zinc-100">{project.name}</span>
                <span className="text-zinc-600">
                  {project.tempo} BPM · {project.tracks.length} track(s)
                </span>
              </div>

              {project.warnings.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 flex flex-col gap-1">
                  {project.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 text-amber-300 shrink-0 mt-px" />
                      <span className="text-[8px] font-mono text-amber-100 leading-relaxed">{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="border border-white/5 rounded max-h-56 overflow-y-auto divide-y divide-white/5">
                {project.tracks.length === 0 ? (
                  <p className="px-2 py-2 text-[9px] text-zinc-600 italic">No tracks parsed.</p>
                ) : (
                  project.tracks.map((t, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1">
                      <span className="mono-tag shrink-0">{t.type}</span>
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">
                        {t.name}
                      </span>
                      <span className="text-[8px] font-mono text-zinc-600 shrink-0">
                        {t.clips.length} clip · {t.devices.length} fx
                      </span>
                    </div>
                  ))
                )}
              </div>

              <DawSessionGrid project={project} />

              <button
                type="button"
                onClick={saveAsTasmo}
                className="btn-ghost inline-flex items-center justify-center gap-1.5"
              >
                <PackagePlus className="w-3 h-3" />
                Save as .tasmo…
              </button>
            </div>
          )}

          {/* Export-only DAWs */}
          {hint && (
            <div className="bg-white/3 border border-white/10 rounded px-3 py-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[9px] font-mono text-zinc-300">
                <FileDown className="w-3 h-3 text-sky-300" />
                <span>{hint.limitation}</span>
              </div>
              <ol className="list-decimal list-inside flex flex-col gap-0.5">
                {hint.recommended_workflow.map((step, i) => (
                  <li key={i} className="text-[8px] font-mono text-zinc-500 leading-relaxed">
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

type ClipLookup = Map<string, DawClip>;

const CLIP_COLORS = [
  'bg-emerald-500/75 border-emerald-200/30 text-emerald-50',
  'bg-cyan-500/75 border-cyan-200/30 text-cyan-50',
  'bg-amber-500/75 border-amber-200/30 text-amber-50',
  'bg-rose-500/75 border-rose-200/30 text-rose-50',
  'bg-lime-500/75 border-lime-200/30 text-lime-50',
  'bg-blue-500/75 border-blue-200/30 text-blue-50',
  'bg-fuchsia-500/75 border-fuchsia-200/30 text-fuchsia-50',
  'bg-orange-500/75 border-orange-200/30 text-orange-50',
];

const clipKey = (trackIndex: number, sceneIndex: number) => `${trackIndex}:${sceneIndex}`;

const dbToVolume = (db: number): number => {
  if (!Number.isFinite(db)) return 1;
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
};

const stopPlayers = (players: HTMLAudioElement[]) => {
  players.forEach((player) => {
    player.pause();
    player.currentTime = 0;
    player.removeAttribute('src');
    player.load();
  });
};

const DawSessionGrid: React.FC<{ project: DawProject }> = ({ project }) => {
  const [activeScene, setActiveScene] = React.useState<number | null>(null);
  const [launchError, setLaunchError] = React.useState<string | null>(null);
  const playersRef = React.useRef<HTMLAudioElement[]>([]);

  const tracks = React.useMemo(
    () => project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi'),
    [project.tracks],
  );

  const clipLookup = React.useMemo<ClipLookup>(() => {
    const lookup: ClipLookup = new Map();
    tracks.forEach((track, fallbackTrackIndex) => {
      track.clips.forEach((clip) => {
        const trackIndex = clip.track_index ?? fallbackTrackIndex;
        const sceneIndex = clip.scene_index ?? clip.slot_index;
        if (sceneIndex == null) return;
        lookup.set(clipKey(trackIndex, sceneIndex), clip);
      });
    });
    return lookup;
  }, [tracks]);

  const sceneCount = React.useMemo(() => {
    const maxClipScene = tracks.reduce((max, track) => {
      return Math.max(
        max,
        ...track.clips.map((clip) => clip.scene_index ?? clip.slot_index ?? -1),
      );
    }, -1);
    return Math.max(project.scenes.length, maxClipScene + 1);
  }, [project.scenes.length, tracks]);

  const scenes = React.useMemo(
    () =>
      Array.from({ length: sceneCount }, (_, index) => project.scenes[index] ?? `Scene ${index + 1}`),
    [project.scenes, sceneCount],
  );

  const stopScene = React.useCallback(() => {
    stopPlayers(playersRef.current);
    playersRef.current = [];
    setActiveScene(null);
  }, []);

  React.useEffect(() => stopScene, [stopScene]);

  const sceneClips = React.useCallback(
    (sceneIndex: number) =>
      tracks.flatMap((track, fallbackTrackIndex) => {
        const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
        const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
        return clip && clip.file_path ? [{ clip, track }] : [];
      }),
    [clipLookup, tracks],
  );

  const launchScene = React.useCallback(
    (sceneIndex: number) => {
      stopScene();
      setLaunchError(null);
      const clips = sceneClips(sceneIndex);
      const nextPlayers = clips.map(({ clip, track }) => {
        const player = new Audio(dawImportAudioUrl(clip.file_path ?? ''));
        player.preload = 'auto';
        player.volume = dbToVolume(track.volume_db);
        return player;
      });
      playersRef.current = nextPlayers;
      setActiveScene(sceneIndex);
      void Promise.allSettled(nextPlayers.map((player) => player.play())).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          setLaunchError('Some clips could not be played.');
        }
      });
    },
    [sceneClips, stopScene],
  );

  if (tracks.length === 0 || scenes.length === 0) return null;

  return (
    <div className="border border-white/10 rounded bg-[#15151a] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/10 bg-[#202027]">
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-200">
          Session
        </span>
        <span className="text-[8px] font-mono text-zinc-500">
          {scenes.length} scenes · {tracks.length} tracks
        </span>
        <button
          type="button"
          onClick={stopScene}
          className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded border border-white/10 bg-black/20 text-zinc-300 hover:text-white hover:bg-white/10"
          aria-label="Stop session"
          title="Stop"
        >
          <Square className="h-3 w-3" />
        </button>
      </div>

      <div className="overflow-auto max-h-[420px]">
        <div
          className="grid min-w-[760px]"
          style={{
            gridTemplateColumns: `128px repeat(${tracks.length}, minmax(104px, 1fr)) 42px`,
          }}
        >
          <div className="sticky left-0 z-20 bg-[#202027] border-r border-b border-white/10 px-2 py-2 text-[8px] font-mono text-zinc-500">
            Scenes
          </div>
          {tracks.map((track, trackIndex) => (
            <div
              key={`${track.name}-${trackIndex}`}
              className="bg-[#202027] border-r border-b border-white/10 px-2 py-2 min-w-0"
            >
              <div className="text-[9px] font-bold text-zinc-100 truncate">{track.name}</div>
              <div className="text-[8px] font-mono text-zinc-500">{track.type}</div>
            </div>
          ))}
          <div className="bg-[#202027] border-b border-white/10" />

          {scenes.map((sceneName, sceneIndex) => (
            <React.Fragment key={`${sceneName}-${sceneIndex}`}>
              <div
                className={[
                  'sticky left-0 z-10 border-r border-b border-white/10 px-2 py-1.5 min-h-14 bg-[#1b1b21]',
                  activeScene === sceneIndex ? 'text-emerald-100' : 'text-zinc-300',
                ].join(' ')}
              >
                <div className="text-[8px] font-mono text-zinc-600">{String(sceneIndex + 1).padStart(2, '0')}</div>
                <div className="text-[9px] font-bold truncate">{sceneName}</div>
              </div>
              {tracks.map((track, fallbackTrackIndex) => {
                const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
                const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
                const color = CLIP_COLORS[trackIndex % CLIP_COLORS.length];
                return (
                  <div
                    key={`${trackIndex}-${sceneIndex}`}
                    className={[
                      'border-r border-b border-white/10 p-1 min-h-14 bg-[#111116]',
                      activeScene === sceneIndex ? 'ring-1 ring-inset ring-emerald-300/40' : '',
                    ].join(' ')}
                  >
                    {clip ? (
                      <div
                        className={[
                          'h-full min-h-11 rounded border px-1.5 py-1 flex flex-col justify-between shadow-sm',
                          color,
                          !clip.file_path ? 'opacity-45' : '',
                        ].join(' ')}
                        title={clip.name}
                      >
                        <span className="text-[9px] font-bold leading-tight line-clamp-2">{clip.name}</span>
                        <span className="text-[7px] font-mono opacity-75">{clip.file_path ? 'audio' : 'missing'}</span>
                      </div>
                    ) : (
                      <div className="h-full min-h-11 rounded border border-white/[0.04] bg-black/10" />
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => launchScene(sceneIndex)}
                disabled={sceneClips(sceneIndex).length === 0}
                className={[
                  'border-b border-white/10 min-h-14 inline-flex items-center justify-center',
                  activeScene === sceneIndex
                    ? 'bg-emerald-500/25 text-emerald-100'
                    : 'bg-[#1b1b21] text-zinc-300 hover:bg-white/10',
                  sceneClips(sceneIndex).length === 0 ? 'opacity-30 cursor-not-allowed' : '',
                ].join(' ')}
                aria-label={`Launch ${sceneName}`}
                title="Launch"
              >
                <Play className="h-3 w-3" />
              </button>
            </React.Fragment>
          ))}

          <div className="sticky left-0 z-10 bg-[#202027] border-r border-white/10 px-2 py-2 text-[8px] font-mono text-zinc-500">
            Mixer
          </div>
          {tracks.map((track, trackIndex) => (
            <div
              key={`mixer-${track.name}-${trackIndex}`}
              className="bg-[#202027] border-r border-white/10 px-2 py-2 min-w-0"
            >
              <div className="h-1.5 rounded bg-black/30 overflow-hidden">
                <div
                  className="h-full bg-sky-300/80"
                  style={{ width: `${Math.round(dbToVolume(track.volume_db) * 100)}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-1 text-[7px] font-mono text-zinc-500">
                <span>{track.mute ? 'mute' : 'on'}</span>
                <span>{track.pan.toFixed(2)}</span>
              </div>
            </div>
          ))}
          <div className="bg-[#202027]" />
        </div>
      </div>

      {launchError && (
        <div className="border-t border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[8px] font-mono text-amber-100">
          {launchError}
        </div>
      )}
    </div>
  );
};
