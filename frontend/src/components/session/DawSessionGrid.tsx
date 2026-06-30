import React from 'react';
import {
  Circle,
  Headphones,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
} from 'lucide-react';
import { dawImportAudioUrl } from '../../lib/dawImportClient';
import type { DawClip, DawProject, DawTrack } from '../../lib/dawImportClient';

type ClipLookup = Map<string, DawClip>;

interface SessionPlayer {
  audio: HTMLAudioElement;
  source?: MediaElementAudioSourceNode;
  analyser?: AnalyserNode;
  gain?: GainNode;
  trackIndex: number;
}

const CLIP_COLORS = [
  {
    clip: 'bg-[#7864ff] border-[#9f91ff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#7864ff]',
  },
  {
    clip: 'bg-[#ff3232] border-[#ff7474] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#ff3232]',
  },
  {
    clip: 'bg-[#11c6aa] border-[#5af5dc] text-black',
    header: 'bg-[#c1aa31] text-black',
    scene: 'bg-[#11c6aa]',
  },
  {
    clip: 'bg-[#d9d9d9] border-white/80 text-black',
    header: 'bg-[#ff3232] text-black',
    scene: 'bg-[#d9d9d9]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
  {
    clip: 'bg-[#66ff50] border-[#a2ff92] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#66ff50]',
  },
  {
    clip: 'bg-[#28f0b8] border-[#84ffe1] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#28f0b8]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
];

const clipKey = (trackIndex: number, sceneIndex: number) => `${trackIndex}:${sceneIndex}`;

const dbToVolume = (db: number): number => {
  if (!Number.isFinite(db)) return 1;
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
};

const linearToDb = (value: number): number => {
  if (value <= 0.0001) return -72;
  return Math.max(-72, Math.min(6, 20 * Math.log10(value)));
};

const meterHeight = (level: number): string => `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;

const stopSessionPlayers = (players: SessionPlayer[]) => {
  players.forEach((player) => {
    player.audio.pause();
    player.audio.currentTime = 0;
    player.audio.removeAttribute('src');
    player.audio.load();
    player.source?.disconnect();
    player.analyser?.disconnect();
    player.gain?.disconnect();
  });
};

interface DawSessionGridProps {
  project: DawProject;
  fill?: boolean;
}

export const DawSessionGrid: React.FC<DawSessionGridProps> = ({ project, fill = false }) => {
  const [activeScene, setActiveScene] = React.useState<number | null>(null);
  const [lastScene, setLastScene] = React.useState(0);
  const [launchError, setLaunchError] = React.useState<string | null>(null);
  const [trackLevels, setTrackLevels] = React.useState<number[]>([]);
  const [masterLevel, setMasterLevel] = React.useState(0);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const playersRef = React.useRef<SessionPlayer[]>([]);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const animationRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef<number | null>(null);
  const meterDataRef = React.useRef(new Uint8Array(0));

  const tracks = React.useMemo(
    () => project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi'),
    [project.tracks],
  );

  React.useEffect(() => {
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

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

  const stopMeters = React.useCallback(() => {
    if (animationRef.current != null) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    startedAtRef.current = null;
    setElapsedSeconds(0);
    setMasterLevel(0);
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

  const stopScene = React.useCallback(() => {
    stopSessionPlayers(playersRef.current);
    playersRef.current = [];
    setActiveScene(null);
    stopMeters();
  }, [stopMeters]);

  React.useEffect(() => stopScene, [stopScene]);

  const sceneClips = React.useCallback(
    (sceneIndex: number) =>
      tracks.flatMap((track, fallbackTrackIndex) => {
        const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
        const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
        return clip && clip.file_path ? [{ clip, track, trackIndex }] : [];
      }),
    [clipLookup, tracks],
  );

  const tickMeters = React.useCallback(() => {
    const players = playersRef.current;
    const next = Array.from({ length: tracks.length }, () => 0);
    players.forEach((player) => {
      const analyser = player.analyser;
      if (!analyser) return;
      if (meterDataRef.current.length !== analyser.fftSize) {
        meterDataRef.current = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(meterDataRef.current);
      let sum = 0;
      for (let i = 0; i < meterDataRef.current.length; i += 1) {
        const centered = (meterDataRef.current[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / meterDataRef.current.length);
      next[player.trackIndex] = Math.max(next[player.trackIndex] ?? 0, Math.min(1, rms * 5.5));
    });
    setTrackLevels((previous) => next.map((level, index) => Math.max(level, (previous[index] ?? 0) * 0.72)));
    setMasterLevel((previous) => {
      const peak = Math.max(0, ...next);
      return Math.max(peak, previous * 0.76);
    });
    if (startedAtRef.current != null) setElapsedSeconds((performance.now() - startedAtRef.current) / 1000);
    animationRef.current = window.requestAnimationFrame(tickMeters);
  }, [tracks.length]);

  const ensureAudioContext = React.useCallback(() => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!audioContextRef.current && AudioContextCtor) {
      audioContextRef.current = new AudioContextCtor();
    }
    return audioContextRef.current;
  }, []);

  const launchScene = React.useCallback(
    (sceneIndex: number) => {
      stopScene();
      setLaunchError(null);
      setLastScene(sceneIndex);
      const clips = sceneClips(sceneIndex);
      const context = ensureAudioContext();
      const nextPlayers = clips.map(({ clip, track, trackIndex }) => {
        const audio = new Audio(dawImportAudioUrl(clip.file_path ?? ''));
        audio.preload = 'auto';
        audio.volume = dbToVolume(track.volume_db);
        const sessionPlayer: SessionPlayer = { audio, trackIndex };
        if (context) {
          const source = context.createMediaElementSource(audio);
          const gain = context.createGain();
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.62;
          gain.gain.value = dbToVolume(track.volume_db);
          source.connect(gain);
          gain.connect(analyser);
          analyser.connect(context.destination);
          sessionPlayer.source = source;
          sessionPlayer.gain = gain;
          sessionPlayer.analyser = analyser;
        }
        return sessionPlayer;
      });
      playersRef.current = nextPlayers;
      setActiveScene(sceneIndex);
      startedAtRef.current = performance.now();
      if (animationRef.current == null) animationRef.current = window.requestAnimationFrame(tickMeters);
      void context?.resume();
      void Promise.allSettled(nextPlayers.map((player) => player.audio.play())).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          setLaunchError('Some clips could not be played.');
        }
      });
    },
    [ensureAudioContext, sceneClips, stopScene, tickMeters],
  );

  const launchPreviousScene = () => {
    if (scenes.length === 0) return;
    const next = Math.max(0, (activeScene ?? lastScene) - 1);
    launchScene(next);
  };

  const launchNextScene = () => {
    if (scenes.length === 0) return;
    const next = Math.min(scenes.length - 1, (activeScene ?? lastScene) + 1);
    launchScene(next);
  };

  if (tracks.length === 0 || scenes.length === 0) return null;

  const activeSceneName = activeScene == null ? 'Stopped' : scenes[activeScene];
  const masterDb = linearToDb(masterLevel);
  const masterMeterLabel = masterDb <= -71 ? '-inf' : masterDb.toFixed(1);

  return (
    <div className={`border border-white/10 bg-[#2f3238] overflow-hidden ${fill ? 'h-full flex flex-col' : ''}`}>
      <div className="shrink-0 flex items-center gap-1 border-b border-black/70 bg-[#202329] px-2 py-1 text-[10px] font-bold text-zinc-200">
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          4 / 4
        </div>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          1 Bar
        </div>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          {project.tempo.toFixed(2)}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={launchPreviousScene}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch previous scene"
            title="Previous scene"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => launchScene(activeScene ?? lastScene)}
            className="h-7 w-8 grid place-items-center border border-emerald-900/70 bg-[#113525] text-emerald-300 hover:bg-[#185239]"
            aria-label="Play session"
            title="Play selected scene"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
          <button
            type="button"
            onClick={stopScene}
            className="h-7 w-8 grid place-items-center border border-red-900/70 bg-[#3a1719] text-red-200 hover:bg-[#5a2024]"
            aria-label="Stop session"
            title="Stop all clips"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
          <button
            type="button"
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-400"
            aria-label="Record arm"
            title="Record arm placeholder"
          >
            <Circle className="h-3.5 w-3.5 fill-current text-zinc-500" />
          </button>
          <button
            type="button"
            onClick={launchNextScene}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch next scene"
            title="Next scene"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-2 h-7 min-w-32 px-2 flex items-center justify-between border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span>{elapsedSeconds.toFixed(1)}</span>
          <span className="text-zinc-500">sec</span>
        </div>
        <div className="h-7 min-w-48 px-2 flex items-center border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span className={activeScene == null ? 'text-zinc-500' : 'text-emerald-200'}>{activeSceneName}</span>
        </div>
      </div>

      <div className={`overflow-auto ${fill ? 'flex-1 min-h-0' : 'max-h-[560px]'}`}>
        <div
          className="grid min-w-[980px]"
          style={{
            gridTemplateColumns: `118px repeat(${tracks.length}, minmax(116px, 1fr)) 86px`,
          }}
        >
          <div className="sticky left-0 z-20 bg-[#202329] border-r-2 border-black/70 border-b-2 border-black/70 px-2 py-1.5 text-[9px] font-bold text-zinc-300">
            Scenes
          </div>
          {tracks.map((track, trackIndex) => {
            const color = CLIP_COLORS[trackIndex % CLIP_COLORS.length];
            return (
              <div
                key={`${track.name}-${trackIndex}`}
                className={`${color.header} border-r-2 border-black/70 border-b-2 border-black/70 px-1.5 py-1 min-w-0`}
              >
                <div className="text-[10px] font-black truncate">{String(trackIndex + 1).padStart(2, '0')} {track.name}</div>
                <div className="text-[8px] font-mono opacity-70 uppercase">{track.type}</div>
              </div>
            );
          })}
          <div className="bg-[#afd4dc] text-black border-b-2 border-black/70 px-1.5 py-1 text-[10px] font-black">
            Main
          </div>

          {scenes.map((sceneName, sceneIndex) => {
            const sceneColor = CLIP_COLORS[sceneIndex % CLIP_COLORS.length].scene;
            const hasClips = sceneClips(sceneIndex).length > 0;
            return (
              <React.Fragment key={`${sceneName}-${sceneIndex}`}>
                <button
                  type="button"
                  onClick={() => launchScene(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'sticky left-0 z-10 min-h-7 border-r-2 border-b border-black/70 px-1.5 text-left',
                    activeScene === sceneIndex ? 'bg-[#2affb0] text-black' : 'bg-[#3b3f47] text-zinc-200 hover:bg-[#4a4f59]',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch ${sceneName}`}
                  title="Launch scene"
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <Play className="h-3 w-3 fill-current shrink-0" />
                    <span className="truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                  </div>
                </button>
                {tracks.map((track, fallbackTrackIndex) => {
                  const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
                  const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
                  const color = CLIP_COLORS[sceneIndex % CLIP_COLORS.length];
                  return (
                    <div
                      key={`${trackIndex}-${sceneIndex}`}
                      className={[
                        'border-r-2 border-b border-black/70 min-h-7 bg-[#30343b]',
                        activeScene === sceneIndex ? 'ring-1 ring-inset ring-emerald-200' : '',
                      ].join(' ')}
                    >
                      {clip ? (
                        <button
                          type="button"
                          onClick={() => launchScene(sceneIndex)}
                          disabled={!clip.file_path}
                          className={[
                            'h-7 w-full px-1.5 flex items-center gap-1 border text-left',
                            color.clip,
                            !clip.file_path ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110',
                          ].join(' ')}
                          title={clip.name}
                        >
                          <Play className="h-3 w-3 fill-current shrink-0" />
                          <span className="min-w-0 truncate text-[10px] font-bold">{clip.name}</span>
                        </button>
                      ) : (
                        <div className="h-7 bg-[#262a31] border border-black/20" />
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => launchScene(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'min-h-7 border-b border-black/70 px-1.5 flex items-center gap-1 text-black',
                    sceneColor,
                    activeScene === sceneIndex ? 'brightness-125' : 'hover:brightness-110',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch main scene ${sceneName}`}
                >
                  <Play className="h-3 w-3 fill-current shrink-0" />
                  <span className="min-w-0 truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                </button>
              </React.Fragment>
            );
          })}

          <div className="sticky left-0 z-10 bg-[#3b3f47] border-r-2 border-t-2 border-black/70 px-2 py-2 text-[9px] font-bold text-zinc-200">
            Mixer
          </div>
          {tracks.map((track, trackIndex) => (
            <TrackMixer
              key={`mixer-${track.name}-${trackIndex}`}
              track={track}
              trackNumber={trackIndex + 1}
              level={trackLevels[trackIndex] ?? 0}
            />
          ))}
          <div className="bg-[#454a54] border-t-2 border-black/70 px-2 py-2">
            <div className="flex items-end justify-center gap-2">
              <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
                <div className="w-full bg-gradient-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(masterLevel) }} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 rounded bg-[#202329] px-1 py-0.5 text-center text-[9px] font-mono text-zinc-100">
                  {masterMeterLabel}
                </div>
                <div className="text-[10px] font-black text-zinc-100">Main</div>
                <div className="text-[8px] font-mono text-zinc-400">1 / 2</div>
              </div>
            </div>
            <button
              type="button"
              onClick={stopScene}
              className="mt-2 h-7 w-full border border-red-900/70 bg-[#3a1719] text-[9px] font-black uppercase tracking-wider text-red-100 hover:bg-[#5a2024]"
            >
              Stop All
            </button>
          </div>
        </div>
      </div>

      {launchError && (
        <div className="shrink-0 border-t border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[8px] font-mono text-amber-100">
          {launchError}
        </div>
      )}
    </div>
  );
};

const TrackMixer: React.FC<{ track: DawTrack; trackNumber: number; level: number }> = ({
  track,
  trackNumber,
  level,
}) => {
  const db = linearToDb(level);
  const label = db <= -71 ? '-inf' : db.toFixed(1);
  return (
    <div className="bg-[#343841] border-r-2 border-t-2 border-black/70 px-2 py-2 min-w-0">
      <div className="h-16 border border-black/80 bg-[#1b1e23] px-1 py-1 text-[8px] font-bold text-zinc-200">
        <div className="flex items-center justify-between gap-1">
          <span>Audio From</span>
          <span className="text-zinc-500">Ext. In</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Monitor</span>
          <span className="text-zinc-500">Auto</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Audio To</span>
          <span className="text-zinc-500">Main</span>
        </div>
      </div>
      <div className="mt-2 flex items-end justify-center gap-2">
        <div className="flex flex-col items-center gap-1">
          <div className="rounded bg-[#15171b] px-1 py-0.5 text-[9px] font-mono text-zinc-100">
            {label}
          </div>
          <div className="h-7 w-7 rounded-full border-2 border-black/80 bg-[#242832] grid place-items-center">
            <div className="h-3 w-px bg-zinc-300" style={{ transform: `rotate(${track.pan * 55}deg)`, transformOrigin: '50% 100%' }} />
          </div>
          <div className="h-6 w-6 grid place-items-center bg-pink-300 text-[11px] font-black text-black">
            {trackNumber}
          </div>
          <div className="flex gap-1">
            <button type="button" className="h-5 w-6 bg-[#202329] text-[9px] font-bold text-zinc-300">
              S
            </button>
            <button type="button" className="h-5 w-6 bg-[#202329] text-[9px] font-bold text-zinc-300">
              {track.mute ? 'M' : <Headphones className="mx-auto h-3 w-3" />}
            </button>
          </div>
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
          <div className="w-full bg-gradient-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(level) }} />
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#15171b] relative">
          <div className="absolute inset-x-1 bg-zinc-300" style={{ top: `${Math.round((1 - dbToVolume(track.volume_db)) * 76 + 16)}%`, height: 6 }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[8px] font-mono text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <Volume2 className="h-3 w-3" />
          {track.volume_db.toFixed(1)} dB
        </span>
        <span>{track.type}</span>
      </div>
    </div>
  );
};
