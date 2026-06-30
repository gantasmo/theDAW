/**
 * SLIDE tab — the control surface.
 *
 * Mirrors a connected MIDI controller's physical layout (knobs / faders /
 * buttons) and binds each on-screen control to a catalog item:
 *   VISUAL ← VJ effects / plugins      AUDIO ← interfaces / stems / tracks
 *
 * Three views (toolbar segmented switch):
 *   ROW        — every item as a fader, left→right, paged (page light below)
 *   FOCUS      — infinite center-weighted carousel; centered ~page is full
 *                size, off-center shrink (horizontal fisheye)
 *   CONTROLLER — the device's exact grid (KNOBS → FADERS → BUTTONS)
 *
 * Slots auto-fill from the catalog; a 🔒 lock pins an item so auto-fill skips
 * it, and the ⠿ grip drag-reorders. All wired to slideStore (persisted).
 *
 * The AUDIO/VISUAL toggle lives UP in the bottom-panel tab row
 * (BottomMultiTabPanel) — not here — so the lanes get the full height.
 *
 * Phase 1 (this pass): visuals + local state. Phase 2 will bridge values to a
 * control-sync bus + the VJ iframe for real-time two-way sync.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Rows3, Crosshair, LayoutGrid, RotateCcw, ChevronLeft, ChevronRight, Plus, Settings2, X, Trash2, Film, Target, Wand2, Sliders, Sparkles, Radio, Crosshair as MapPin, Check } from 'lucide-react';
import './track-controls.css';
import { TrackFader, TrackKnob, TrackPad } from './TrackControls';
import WorldsCollidePanel from './WorldsCollidePanel';
import {
  useSlideStore,
  resolveItem,
  isSlotLocked,
  STACK_PREFIX,
  stackIdFromLabel,
  type SlideContent,
  type SlideView,
  type StackBinding,
  type StackMedia,
} from '../../state/slideStore';
import { useMediaBucketStore } from '../../state/mediaBucketStore';
import { loadStackMedia, refreshStack } from '../../state/controlSyncBus';
import {
  CONTROLLER_PROFILES,
  profileById,
  profileControlCount,
  profileKindCount,
  detectProfileFromNames,
  GANTASMO_WORLDS_COLLIDE_ID,
  AUDIMA_SWAY_ID,
  type ControlKind,
} from '../../state/controllerProfiles';
import { useEditorStore } from '../../state/editorStore';
import { audioCatalog, startAudioMixerSync, PAN_SUFFIX } from '../../state/audioMixerBus';
import { subscribeToMidi } from '../../state/midiBus';
import { useMidiDevicesStore } from '../../state/midiDevicesStore';
import { useLearnedProfilesStore } from '../../state/learnedProfilesStore';
import { ControllerVisionModal } from './ControllerVisionModal';
import { enableMidi } from '../../state/midiTriggerStore';
import {
  useControllerMapStore,
  getProfileBindings,
  bindingLabel,
  type MidiBinding,
} from '../../state/controllerMapStore';
import type { ControllerProfile } from '../../state/controllerProfiles';
import type { RGB } from '../../lib/trackColor';

/** One resolved device position in the controller layout, for the CURRENT
 *  bank + content: which widget kind it is, and the slideStore item key its
 *  value/pad lives under (audio knobs get the PAN suffix). */
interface DeviceSlot {
  pos: number;
  kind: ControlKind;
  item: string | null;
  /** store item key (PAN-suffixed for audio knobs); null for empty slots */
  storeItem: string | null;
}

/* ============================ catalogs ================================== */
// VISUAL fallback — shown only BEFORE the VJ iframe connects. Once it does,
// slideStore.visualControls (the real manifest) drives the VISUAL catalog so
// labels / count / ranges always match the live VJ build.
const VISUAL_CATALOG: string[] = [
  'CROSSFADE', 'BLACK', 'AUTOSWITCH', 'VIDEOS', 'IMAGES', 'PICTURES', 'ASPECT', 'MASTER FX',
  'BRIGHTNESS', 'HUE ROTATE', 'SATURATION', 'CONTRAST', 'GRID TILING', 'RADIAL MIRROR', 'RGB GHOST', 'CHROMA AB',
  'FEEDBACK', 'GLITCH', 'STROBE', 'PIXELATE', 'WAVE WARP', 'RGB SPLIT', 'TIME GLITCH', 'SEPIA',
  'GRAYSCALE', 'SOFT BLUR', 'BPM', 'PLAYBACK SPD', 'ECHO TRAILS', 'SLIT SCAN', 'TIME DISPLACE', 'POSTERIZE',
  'RADIAL KALEIDO', 'DROSTE TUNNEL', 'REACT-DIFFUSE', 'SDF PORTAL', 'CHROMA REFRACT', 'HOLOGRAM', 'TOPOGRAPHIC', 'FLUID DISPLACE',
  'DEPTH FOG', 'DEPTH RELIGHT', 'CAMERA DOLLY', 'DEPTH PARTICLES', 'Z-PLANES', 'COMIC OUTLINE', 'POINT CLOUD', 'OCCLUSION AR',
  'TILT SHIFT', 'RGBD RECON', 'RVM KEYER', 'BIREFNET', 'CONCEPT MASK', 'EXEMPLAR WAND', 'PER-INST GLITCH', 'OBJECT REMOVAL',
  'OBJECT LIGHT', 'ROTOSCOPE', 'CUTOUT WORLD', 'STREAMDIFFUSION', 'FLOW RESTYLE', 'WORLD SWAP', 'POSE CHARACTER', 'MASKED GEN',
  'DREAM FEEDBACK', 'LIQUID SMEAR', 'REAL DATAMOSH', 'ADVECTION FIELD',
];

// pad accent palette (cycles per column)
const PAD_COLORS: RGB[] = [
  [255, 64, 129], [0, 229, 255], [124, 252, 0], [255, 170, 0],
  [170, 100, 255], [255, 90, 90], [0, 200, 180], [255, 220, 0],
];

// Both catalogs are resolved live in the component:
//   VISUAL ← slideStore.visualControls (the VJ manifest), VISUAL_CATALOG fallback
//   AUDIO  ← audioMixerBus.audioCatalog() (MASTER + editorStore tracks)

// a stable mapping label for a slot (CC/NOTE-style placeholder until the
// MIDI-learn phase assigns real bindings)
const mappingFor = (kind: ControlKind, idx: number): string =>
  kind === 'fader' ? `CC ${19 + (idx % 8)}` : kind === 'knob' ? `CC ${46 + (idx % 24)}` : `NOTE ${1 + (idx % 16)}`;

/* ============================ slot wrapper ============================= */
interface SlotProps {
  index: number;
  kind: ControlKind;
  content: SlideContent;
  item: string | null;
  locked: boolean;
  colColor: RGB;
  onDropItem: (from: number, to: number) => void;
  /** real catalog index stamped on the DOM for FOCUS page tracking */
  dataIdx?: number;
  /** CONTROLLER view: render an unmapped slot as a greyed widget (showing the
   *  full hardware layout) instead of a dashed placeholder. */
  muteUnmapped?: boolean;
}

// memo: with `onDropItem` / `colColor` stable, a Slot only re-renders when its
// own item / locked / kind actually change — so a view or page switch doesn't
// rebuild the slots that didn't move.
const Slot: React.FC<SlotProps> = React.memo(({ index, kind, content, item, locked, colColor, onDropItem, dataIdx, muteUnmapped }) => {
  const toggleLock = useSlideStore((s) => s.toggleLock);

  // CONTROLLER view: an unmapped physical control renders greyed + chrome-less
  // so the device layout is always complete (nothing mapped yet = dimmed).
  if (!item && muteUnmapped) {
    return (
      <div className="sl-slot" data-idx={dataIdx}>
        {kind === 'knob' ? (
          <TrackKnob item="" content={content} muted />
        ) : kind === 'pad' ? (
          <TrackPad item="" content={content} color={colColor} muted />
        ) : (
          <TrackFader item="" content={content} muted />
        )}
      </div>
    );
  }

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
  };
  const onDragLeave = (e: React.DragEvent) => e.currentTarget.classList.remove('dragover');
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(from)) onDropItem(from, index);
  };

  const stackId = stackIdFromLabel(item);

  let widget: React.ReactNode;
  if (stackId) {
    // custom stack lane — looks itself up from the store (keeps Slot props stable)
    widget = <StackLane stackId={stackId} />;
  } else if (!item) {
    widget = (
      <div className="sl-ph" title="Open slot — auto-fills as effects/stems become available">
        <div className={kind === 'knob' ? 'sl-ph-ring' : kind === 'pad' ? 'sl-ph-pad' : 'sl-ph-cap'} />
        <div className="sl-ph-label">EMPTY</div>
      </div>
    );
  } else if (kind === 'knob') {
    // AUDIO knobs drive track PAN — suffix the store key so a track's pan
    // (knob) and volume (fader) never collide on the same audio/<name> key.
    const knobItem = content === 'audio' ? `${item}${PAN_SUFFIX}` : item;
    widget = <TrackKnob item={knobItem} content={content} mapping={content === 'audio' ? 'PAN' : mappingFor('knob', index)} />;
  } else if (kind === 'pad') {
    widget = <TrackPad item={item} content={content} color={colColor} />;
  } else {
    widget = <TrackFader item={item} content={content} mapping={mappingFor('fader', index)} />;
  }

  return (
    <div className="sl-slot" data-idx={dataIdx} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <span className="sl-grip" draggable title="Drag to rearrange" onDragStart={onDragStart}>⠿</span>
      <button
        className={`sl-lock${locked ? ' on' : ''}`}
        title={locked ? 'Locked — auto-fill skips this slot' : 'Unlocked — auto-fill may use this slot'}
        onClick={() => toggleLock(index, item)}
      >
        {locked ? '🔒' : '🔓'}
      </button>
      {widget}
    </div>
  );
});
Slot.displayName = 'Slot';

/* ============================ stack lane =============================== */
const kindOfMime = (mime: string): StackMedia['kind'] =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'video';

// A custom stack lane: a fader (keyed `stack:<id>`, so controlSyncBus fans it
// out to the bound targets) titled by the stack name, with a media chip + a
// gear that opens the binding editor. Looks itself up from the store so the
// parent Slot's props stay stable (memo-friendly).
const StackLane: React.FC<{ stackId: string }> = ({ stackId }) => {
  const stack = useSlideStore((s) => s.stacks.find((x) => x.id === stackId));
  const [editing, setEditing] = useState(false);
  if (!stack) return null;

  const summary = stack.media ? stack.media.label : `${stack.targets.length} FX`;
  return (
    <div className="sl-stack" style={{ position: 'relative' }}>
      <span className="sl-stack-badge" title="Custom stack — one slider drives bound media + effects">STACK</span>
      <button
        className="sl-stack-gear"
        title="Edit this stack (media + effect targets)"
        onClick={() => setEditing((v) => !v)}
        aria-label="Edit stack"
      >
        <Settings2 className="w-3 h-3" />
      </button>
      <TrackFader
        item={`${STACK_PREFIX}${stack.id}`}
        content="visual"
        displayLabel={stack.name}
        mapping={summary}
      />
      {stack.media && (
        <button
          className="sl-stack-media"
          title={`Load "${stack.media.label}" into the VJ`}
          onClick={() => loadStackMedia(stack)}
        >
          <Film className="w-2.5 h-2.5" /> {stack.media.label}
        </button>
      )}
      {editing && <StackEditor stack={stack} onClose={() => setEditing(false)} />}
    </div>
  );
};

const StackEditor: React.FC<{ stack: StackBinding; onClose: () => void }> = ({ stack, onClose }) => {
  const updateStack = useSlideStore((s) => s.updateStack);
  const removeStack = useSlideStore((s) => s.removeStack);
  const visualControls = useSlideStore((s) => s.visualControls);
  const bucket = useMediaBucketStore((s) => s.items);

  const setName = (name: string) => updateStack(stack.id, { name });

  const assignMedia = (id: string) => {
    const item = bucket.find((b) => b.id === id);
    if (!item) return;
    if (stack.media?.url) URL.revokeObjectURL(stack.media.url);
    const media: StackMedia = {
      kind: kindOfMime(item.mimeType),
      url: URL.createObjectURL(item.blob),
      label: item.name,
      entryId: item.id,
    };
    updateStack(stack.id, { media });
  };
  const clearMedia = () => {
    if (stack.media?.url) URL.revokeObjectURL(stack.media.url);
    updateStack(stack.id, { media: null });
  };

  const addTarget = () => {
    const firstKey = visualControls[0]?.key ?? '';
    updateStack(stack.id, { targets: [...stack.targets, { key: firstKey, fromPct: 0, toPct: 100 }] });
    refreshStack(stack.id);
  };
  const updateTarget = (i: number, patch: Partial<StackBinding['targets'][number]>) => {
    const targets = stack.targets.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    updateStack(stack.id, { targets });
    refreshStack(stack.id);
  };
  const removeTarget = (i: number) => {
    updateStack(stack.id, { targets: stack.targets.filter((_, idx) => idx !== i) });
    refreshStack(stack.id);
  };

  return (
    <div className="sl-stack-editor" role="dialog" aria-label="Stack editor">
      <div className="sl-se-head">
        <span>EDIT STACK</span>
        <button onClick={onClose} aria-label="Close"><X className="w-3 h-3" /></button>
      </div>

      <label htmlFor="slide-stack-name" className="sl-se-label">Name</label>
      <input
        id="slide-stack-name"
        name="slide-stack-name"
        className="sl-se-input"
        value={stack.name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Stack name"
      />

      <label htmlFor="slide-stack-media" className="sl-se-label">Media</label>
      <div className="sl-se-row">
        <select
          id="slide-stack-media"
          name="slide-stack-media"
          className="sl-se-input"
          value={stack.media?.entryId ?? ''}
          onChange={(e) => (e.target.value ? assignMedia(e.target.value) : clearMedia())}
        >
          <option value="">— none —</option>
          {bucket.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {stack.media && (
          <button className="sl-se-icon" onClick={clearMedia} title="Clear media"><X className="w-3 h-3" /></button>
        )}
      </div>
      {bucket.length === 0 && (
        <div className="sl-se-hint">No media in the bucket yet — add files in the Media tab.</div>
      )}

      <label className="sl-se-label">Effect targets (slider fans out to each)</label>
      {stack.targets.length === 0 && (
        <div className="sl-se-hint">No targets yet. Add one — the slider will drive it across its range.</div>
      )}
      {stack.targets.map((t, i) => (
        <div className="sl-se-target" key={i}>
          <select
            name={`slide-target-key-${i}`}
            className="sl-se-input sl-se-key"
            value={t.key}
            onChange={(e) => updateTarget(i, { key: e.target.value })}
            title="Which VJ control this target drives"
          >
            {visualControls.length === 0 && <option value={t.key}>{t.key || '(connect VJ)'}</option>}
            {visualControls.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <input
            name={`slide-target-from-pct-${i}`}
            className="sl-se-num"
            type="number" min={0} max={100}
            value={t.fromPct ?? 0}
            onChange={(e) => updateTarget(i, { fromPct: Number(e.target.value) })}
            title="Range start % at slider 0"
          />
          <input
            name={`slide-target-to-pct-${i}`}
            className="sl-se-num"
            type="number" min={0} max={100}
            value={t.toPct ?? 100}
            onChange={(e) => updateTarget(i, { toPct: Number(e.target.value) })}
            title="Range end % at slider 100"
          />
          <button className="sl-se-icon" onClick={() => removeTarget(i)} title="Remove target"><X className="w-3 h-3" /></button>
        </div>
      ))}
      <button className="sl-se-add" onClick={addTarget}><Plus className="w-3 h-3" /> Add target</button>

      <button className="sl-se-delete" onClick={() => { removeStack(stack.id); onClose(); }}>
        <Trash2 className="w-3 h-3" /> Delete stack
      </button>
    </div>
  );
};

/* ============================ page light =============================== */
const PageLight: React.FC<{ count: number; active: number; color: string; onPick: (p: number) => void }> = ({
  count, active, color, onPick,
}) => (
  <div className="sl-pagelight" style={{ ['--pl' as string]: color }}>
    {Array.from({ length: count }, (_, p) => (
      <div
        key={p}
        className={`sl-pageseg${p === active ? ' on' : ''}`}
        title={`Page ${p + 1}`}
        onClick={() => onPick(p)}
      />
    ))}
    <div className="sl-pagenum">PAGE {active + 1} / {count}</div>
  </div>
);

/* ============================ focus strip ============================= */
// Infinite, center-weighted carousel. Items are triplicated so scrolling wraps
// seamlessly; a scroll listener applies the horizontal fisheye + tracks the
// centered page — all imperative so per-frame work never re-renders React.
const FocusStrip: React.FC<{
  content: SlideContent;
  items: Array<{ index: number; item: string | null; locked: boolean }>;
  pageSize: number;
  startPage: number;
  pageColor: string;
  pageCount: number;
  onDropItem: (from: number, to: number) => void;
  onPickPage: (p: number) => void;
}> = ({ content, items, pageSize, startPage, pageColor, pageCount, onDropItem, onPickPage }) => {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const numRef = useRef<HTMLDivElement | null>(null);
  const segRefs = useRef<HTMLDivElement[]>([]);
  const COPIES = 3;

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const N = items.length;
    if (!N) return;

    let raf = 0;
    let lastPage = -1;
    const blockW = strip.scrollWidth / COPIES;
    const itemW = blockW / N;

    const setPage = (pg: number) => {
      if (pg === lastPage) return;
      lastPage = pg;
      if (numRef.current) numRef.current.textContent = `PAGE ${pg + 1} / ${pageCount}`;
      segRefs.current.forEach((el, i) => el && el.classList.toggle('on', i === pg));
    };

    // Two-phase to avoid layout thrash: READ every element's geometry first,
    // THEN WRITE every style. Interleaving read/write (offsetLeft after a style
    // change) forces a synchronous reflow PER element — ~200 reflows/frame was
    // the 281ms "Forced reflow" violation. Margins shift layout, so geometry is
    // sampled from the PRIOR frame; it converges within a frame or two and the
    // eye never catches the difference.
    const fisheye = () => {
      const els = strip.children as HTMLCollectionOf<HTMLElement>;
      const n = els.length;
      const vc = strip.scrollLeft + strip.clientWidth / 2;
      const REACH = strip.clientWidth * 0.5;
      // READ phase
      let bestIdx = 0;
      let best = Infinity;
      const dist = new Float64Array(n);
      const widths = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const el = els[i];
        const ic = el.offsetLeft + el.offsetWidth / 2;
        const d = Math.abs(ic - vc);
        dist[i] = d;
        widths[i] = el.offsetWidth || 96;
        if (d < best) { best = d; bestIdx = i; }
      }
      // WRITE phase
      for (let i = 0; i < n; i++) {
        const el = els[i];
        const p = Math.max(0, 1 - dist[i] / REACH);
        const s = p * p * (3 - 2 * p);
        const scale = 0.72 + s * 0.28;
        const m = (-widths[i] * (1 - scale)) / 2;
        el.style.transform = `scale(${scale})`;
        el.style.marginLeft = `${m.toFixed(2)}px`;
        el.style.marginRight = `${m.toFixed(2)}px`;
        el.style.opacity = (0.5 + s * 0.5).toFixed(3);
        el.style.zIndex = String(Math.round(s * 10));
      }
      const realIdx = Number(els[bestIdx].dataset.idx ?? 0);
      setPage(Math.floor(realIdx / pageSize));
    };

    // center the requested page within the middle copy
    const center = strip.clientWidth / 2;
    strip.scrollLeft = blockW + (startPage * pageSize + pageSize / 2) * itemW - center;
    fisheye();

    const onScroll = () => {
      if (strip.scrollLeft < blockW * 0.5) strip.scrollLeft += blockW;
      else if (strip.scrollLeft > blockW * 1.5) strip.scrollLeft -= blockW;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; fisheye(); });
    };
    strip.addEventListener('scroll', onScroll, { passive: true });

    // drag-to-pan on empty strip area (slower gain = calmer); widgets keep
    // their own pointer handling.
    const PAN_GAIN = 0.09; // ~1/5th of the old 0.42 — heavier, slower FOCUS drag-pan
    let panning = false;
    let panX = 0;
    let panStart = 0;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.ts-body, .tk-dial, .tp-btn, .sl-grip, .sl-lock')) return;
      panning = true; panX = e.clientX; panStart = strip.scrollLeft;
    };
    const onMove = (e: PointerEvent) => { if (panning) strip.scrollLeft = panStart - (e.clientX - panX) * PAN_GAIN; };
    const onUp = () => { panning = false; };
    strip.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      cancelAnimationFrame(raf);
      strip.removeEventListener('scroll', onScroll);
      strip.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [items, pageSize, pageCount, startPage]);

  const nudge = (dir: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    // gentler step (1.5 lanes) so the carousel eases through rather than lurching
    const itemW = strip.scrollWidth / COPIES / Math.max(1, items.length);
    strip.scrollBy({ left: dir * itemW * 1.5, behavior: 'smooth' });
  };

  return (
    <div className="sl-section" style={{ position: 'relative' }}>
      <div className="sl-section-head">SLIDERS · {content.toUpperCase()} · FOCUS — centered, infinite L/R</div>
      <div className="sl-strip focus" ref={stripRef}>
        {Array.from({ length: COPIES }).map((_, c) =>
          items.map(({ index, item, locked }) => (
            <Slot
              key={`${c}:${index}`}
              dataIdx={index}
              index={index}
              kind="fader"
              content={content}
              item={item}
              locked={locked}
              colColor={PAD_COLORS[index % PAD_COLORS.length]}
              onDropItem={onDropItem}
            />
          )),
        )}
      </div>
      <button className="sl-nav prev" onClick={() => nudge(-1)}>◀</button>
      <button className="sl-nav next" onClick={() => nudge(1)}>▶</button>
      <div className="sl-pagedock">
        <div className="sl-pagelight" style={{ ['--pl' as string]: pageColor }}>
          {Array.from({ length: pageCount }, (_, p) => (
            <div
              key={p}
              className="sl-pageseg"
              ref={(el) => { if (el) segRefs.current[p] = el; }}
              title={`Page ${p + 1}`}
              onClick={() => onPickPage(p)}
            />
          ))}
          <div className="sl-pagenum" ref={numRef}>PAGE 1 / {pageCount}</div>
        </div>
      </div>
    </div>
  );
};

/* ============================ toolbar bits ============================ */
const VIEW_DEFS: Array<{ id: SlideView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'row', label: 'Row', icon: Rows3 },
  { id: 'focus', label: 'Focus', icon: Crosshair },
  { id: 'controller', label: 'Controller', icon: LayoutGrid },
];

/* ============================ main panel ============================== */
export const SlidePanel: React.FC = () => {
  const content = useSlideStore((s) => s.content);
  const view = useSlideStore((s) => s.view);
  const profileId = useSlideStore((s) => s.profileId);
  const bankByContent = useSlideStore((s) => s.bank);
  const assignments = useSlideStore((s) => s.assignments[content]);
  const pageNavBinding = useSlideStore((s) => s.pageNavBinding);
  const autoDetect = useSlideStore((s) => s.autoDetect);
  const setView = useSlideStore((s) => s.setView);
  const setProfileId = useSlideStore((s) => s.setProfileId);
  const setAutoDetect = useSlideStore((s) => s.setAutoDetect);
  const setBank = useSlideStore((s) => s.setBank);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  // Learned (capture-built) profiles — the universal path for custom rigs that
  // no name-detected preset can match (e.g. a 92-control combined setup).
  const learnedProfiles = useLearnedProfilesStore((s) => s.profiles);
  const learnPhase = useLearnedProfilesStore((s) => s.phase);
  const capturedCount = useLearnedProfilesStore((s) => Object.keys(s.captured).length);
  const startLearn = useLearnedProfilesStore((s) => s.start);
  const cancelLearn = useLearnedProfilesStore((s) => s.cancel);
  const commitLearn = useLearnedProfilesStore((s) => s.commit);
  const [cvOpen, setCvOpen] = useState(false);
  // Controller-view zoom — lets a big device (e.g. a 92-control rig) be seen
  // whole (the view OPENS fitted to the window) or a section worked up close.
  const [ctrlZoom, setCtrlZoom] = useState(1);
  const clampZoom = (z: number) => Math.max(0.25, Math.min(2.5, Math.round(z * 20) / 20));
  const ctrlSurfaceRef = useRef<HTMLDivElement | null>(null);
  const ctrlContentRef = useRef<HTMLDivElement | null>(null);
  // Natural (unscaled) size of the rendered device; sizes the scale wrapper so
  // zooming never leaves ghost scroll space.
  const [ctrlNat, setCtrlNat] = useState<{ w: number; h: number } | null>(null);

  const fitZoom = useCallback(() => {
    const surf = ctrlSurfaceRef.current;
    const content = ctrlContentRef.current;
    const scrollport = surf?.parentElement;
    if (!surf || !content || !scrollport) return;
    const natW = content.offsetWidth;
    const natH = content.offsetHeight;
    if (!natW || !natH) return;
    setCtrlNat({ w: natW, h: natH });
    const fit = Math.min(
      (scrollport.clientWidth - 28) / natW,
      (scrollport.clientHeight - 28) / natH,
    );
    setCtrlZoom(clampZoom(fit));
  }, []);

  // Open fitted: whenever the controller view activates or the device changes,
  // size the whole rig into the window. (deviceSize derives from profileId, so
  // profileId is the change signal.)
  useEffect(() => {
    if (view !== 'controller') return;
    const t = setTimeout(fitZoom, 60);
    return () => clearTimeout(t);
  }, [view, profileId, fitZoom]);

  // Mouse-wheel zoom over the controller surface. React's delegated onWheel is
  // passive, so preventDefault (to stop the panel scrolling) needs a native
  // non-passive listener bound while the controller view is active.
  useEffect(() => {
    if (view !== 'controller') return;
    const el = ctrlSurfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setCtrlZoom((z) => clampZoom(z + dir * 0.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view]);

  // Left-click drag on the background pans the view (controls keep their own
  // pointer handling; panning only starts from empty surface).
  useEffect(() => {
    if (view !== 'controller') return;
    const el = ctrlSurfaceRef.current;
    const scrollport = el?.parentElement as HTMLElement | null;
    if (!el || !scrollport) return;
    let panning = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('.ts-body, .tk-dial, .tp-btn, .sl-grip, .sl-lock, button, input, select, [role="slider"]')) return;
      panning = true;
      sx = e.clientX;
      sy = e.clientY;
      sl = scrollport.scrollLeft;
      st = scrollport.scrollTop;
      el.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      scrollport.scrollLeft = sl - (e.clientX - sx);
      scrollport.scrollTop = st - (e.clientY - sy);
    };
    const onUp = () => {
      panning = false;
      el.style.cursor = 'grab';
    };
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.style.cursor = '';
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [view]);
  const setPageNavBinding = useSlideStore((s) => s.setPageNavBinding);
  const swapSlots = useSlideStore((s) => s.swapSlots);
  const resetAssignments = useSlideStore((s) => s.resetAssignments);
  const addStack = useSlideStore((s) => s.addStack);

  const visualControls = useSlideStore((s) => s.visualControls);
  const stacks = useSlideStore((s) => s.stacks);
  // AUDIO catalog is MASTER + live editor tracks; subscribe to tracks so the
  // lanes track add/remove/rename. (audioCatalog() reads editorStore.)
  const editorTracks = useEditorStore((s) => s.tracks);
  const profile = profileById(profileId);
  // VISUAL catalog = user stacks first (custom macro lanes), then the live VJ
  // manifest controls (fallback to the static list pre-connect). AUDIO comes
  // from the live mixer.
  const catalog = useMemo(
    () =>
      content === 'visual'
        ? [
            ...stacks.map((s) => `${STACK_PREFIX}${s.id}`),
            ...(visualControls.length > 0 ? visualControls.map((c) => c.label) : VISUAL_CATALOG),
          ]
        : audioCatalog(),
    // editorTracks drives audioCatalog()'s output
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, visualControls, stacks, editorTracks],
  );

  // Mirror the live mixer (editorStore + playbackStore) onto the SLIDE audio
  // namespace so AUDIO lanes open at the right positions and follow the EDIT
  // tab's own faders. One subscription for the panel's lifetime.
  useEffect(() => startAudioMixerSync(), []);

  // Auto-detect the controller profile from connected MIDI device names.
  // Scored match (specific device name beats a family token). Only runs while
  // autoDetect is on; the manual profile dropdown sets autoDetect off so a user choice
  // sticks. Re-runs on hot-plug (midiInputs changes).
  const detected = useMemo(() => detectProfileFromNames(midiInputs), [midiInputs]);
  useEffect(() => {
    if (!autoDetect || !detected) return;
    if (detected.id !== profileId) { setProfileId(detected.id); setBank(0); }
  }, [autoDetect, detected, profileId, setProfileId, setBank]);

  const bank = bankByContent[content] ?? 0;

  const faderCount = Math.max(1, profileKindCount(profile, 'fader'));
  const deviceSize = Math.max(1, profileControlCount(profile));
  const pageSize = view === 'controller' ? deviceSize : faderCount;
  const pageCount = Math.max(1, Math.ceil(catalog.length / pageSize));
  const pageColor = content === 'visual' ? '#f9a8d4' : '#6ee7b7';

  // keep bank in range when content / view / device changes
  useEffect(() => {
    if (bank > pageCount - 1) setBank(pageCount - 1);
  }, [bank, pageCount, setBank]);

  // page navigation — WRAPS around the ends (page 5 → page 1, page 1 → page 5)
  // so you can keep pressing → / ← to cycle.
  const goToPage = useCallback(
    (p: number) => {
      if (pageCount <= 0) return;
      setBank(((p % pageCount) + pageCount) % pageCount);
    },
    [pageCount, setBank],
  );

  // Page-nav cadence guard: holding ←/→ machine-gunned through pages. A cooldown
  // throttles the OS key-repeat to ~1/5th speed; a deliberate fresh press still
  // fires immediately because the idle gap exceeds the cooldown.
  const navCooldownRef = useRef(0);

  // ←/→ keyboard page nav (always on, wraps). Ignored while typing in a field
  // or when a dropdown is focused; widgets are up/down-only so there's no conflict.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      e.preventDefault();
      const now = performance.now();
      if (now - navCooldownRef.current < 220) return;
      navCooldownRef.current = now;
      goToPage(bank + (e.key === 'ArrowRight' ? 1 : -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bank, goToPage]);

  const resolve = useCallback(
    (index: number) => ({
      item: resolveItem(assignments, catalog, index),
      locked: isSlotLocked(assignments, index),
    }),
    [assignments, catalog],
  );

  // stable identity so memoized Slots don't re-render on every parent render
  const onDropItem = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      swapSlots(from, to, resolveItem(assignments, catalog, from), resolveItem(assignments, catalog, to));
    },
    [assignments, catalog, swapSlots],
  );

  /* ---------------------- controller MAP + MIDI routing ----------------- */
  const mapMode = useControllerMapStore((s) => s.mapMode);
  const setMapMode = useControllerMapStore((s) => s.setMapMode);
  const learnPos = useControllerMapStore((s) => s.learnPos);
  const autoWalk = useControllerMapStore((s) => s.autoWalk);

  // Tracks the signature we just bound during an Auto-map walk so its trailing
  // message stream doesn't walk onto the next slot. Reset at each walk start so
  // a stale sig from a prior walk can't suppress the first real control.
  const lastBoundSigRef = useRef<MidiBinding | null>(null);
  useEffect(() => {
    if (autoWalk) lastBoundSigRef.current = null;
  }, [autoWalk]);

  // Device positions for the CURRENT page, in the profile's section order
  // (knobs → faders → pads). Each carries its widget kind + the slideStore item
  // key its value/pad lives under (audio knobs get the PAN suffix). This is the
  // bridge between a physical position and what it controls right now.
  const deviceSlots = useMemo<DeviceSlot[]>(() => {
    const slots: DeviceSlot[] = [];
    const base = bank * deviceSize;
    let local = 0;
    for (const sec of profile.sections) {
      const n = sec.rows * sec.cols;
      for (let i = 0; i < n; i++, local++) {
        const item = resolveItem(assignments, catalog, base + local);
        let storeItem = item;
        if (item && sec.kind === 'knob' && content === 'audio') storeItem = `${item}${PAN_SUFFIX}`;
        slots.push({ pos: local, kind: sec.kind, item, storeItem });
      }
    }
    return slots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, bank, deviceSize, assignments, catalog, content]);

  // MIDI routing runtime. Active in CONTROLLER view. In MAP mode an incoming
  // CC/note binds to the learn target (then auto-advances during Auto-map);
  // otherwise an incoming message is routed to the slot bound to that physical
  // control and applied to its value (CC/abs) or pad (note toggle).
  useEffect(() => {
    if (view !== 'controller') return;
    enableMidi(); // ensure the global Web MIDI listener is running
    const store = useControllerMapStore.getState();

    const orderedPositions = deviceSlots.map((s) => s.pos);
    const advanceLearn = (justBound: number) => {
      if (!useControllerMapStore.getState().autoWalk) {
        store.setLearnPos(null);
        return;
      }
      const idx = orderedPositions.indexOf(justBound);
      const next = orderedPositions[idx + 1];
      if (next === undefined) {
        store.setAutoWalk(false);
        store.setLearnPos(null);
      } else {
        store.setLearnPos(next);
      }
    };

    const unsub = subscribeToMidi((msg) => {
      const [status, data1, data2] = msg.data;
      if (typeof status !== 'number') return;
      const command = status & 0xf0;
      const channel = status & 0x0f;

      let binding: MidiBinding | null = null;
      let value127 = 0;
      let isNoteOn = false;
      if (command === 0xb0) {
        binding = { kind: 'cc', number: data1, channel };
        value127 = data2 ?? 0;
      } else if (command === 0x90 && (data2 ?? 0) > 0) {
        binding = { kind: 'note', number: data1, channel };
        isNoteOn = true;
      } else {
        return; // ignore note-off / other
      }

      // LEARN: bind to the current learn target, then advance.
      const target = useControllerMapStore.getState().learnPos;
      if (useControllerMapStore.getState().mapMode && target !== null) {
        const prof = getProfileBindings(profileId);
        const sameSig = (b: MidiBinding) =>
          b.kind === binding!.kind && b.number === binding!.number && b.channel === channel;

        if (useControllerMapStore.getState().autoWalk) {
          // A physical control emits a STREAM of messages while you wiggle it.
          // Drain guard: ignore ONLY the signature we *just* bound, so its
          // trailing messages don't walk onto the next slot. A genuinely
          // different control is always treated as new — even if it was
          // (mis)bound earlier this walk — so it gets STOLEN to the current slot
          // below. (The old "ignore ANY already-bound signature" guard preserved
          // a stale/mis-bound CC instead of moving it: the CC49/CC77 cross-link.)
          const last = lastBoundSigRef.current;
          if (last && last.kind === binding.kind && last.number === binding.number && last.channel === channel) return;
        }
        // One physical control = exactly ONE slot (auto + manual): steal this
        // signature from any other position before binding here, so routing's
        // first-match can never cross-link two slots to one CC.
        for (const [posStr, b] of Object.entries(prof)) {
          if (Number(posStr) !== target && sameSig(b)) store.clearPos(profileId, Number(posStr));
        }
        store.bind(profileId, target, binding);
        lastBoundSigRef.current = { kind: binding.kind, number: binding.number, channel };
        advanceLearn(target);
        return;
      }

      // ROUTE: find the slot bound to this physical control and apply it.
      const profBindings = getProfileBindings(profileId);
      for (const slot of deviceSlots) {
        const b = profBindings[slot.pos];
        if (!b || b.kind !== binding.kind || b.number !== binding.number) continue;
        if (b.channel !== channel) continue;
        if (!slot.storeItem) continue;
        const slideState = useSlideStore.getState();
        if (slot.kind === 'pad') {
          if (isNoteOn) {
            const key = `${content}/${slot.storeItem}`;
            const cur = slideState.pads[key] ?? false;
            slideState.setOnFor(content, slot.storeItem, !cur); // toggle
          }
        } else if (binding.kind === 'cc') {
          slideState.setValueFor(content, slot.storeItem, (value127 / 127) * 100);
        }
        break;
      }
    });
    return unsub;
  }, [view, profileId, content, deviceSlots]);

  // FOCUS needs the whole catalog as fader slots (the strip pages internally)
  const focusItems = useMemo(
    () => catalog.map((_, i) => ({ index: i, ...resolve(i) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, catalog, assignments],
  );

  return (
    <div className="slide-surface h-full flex flex-col min-h-0 bg-[#07060c]">
      {/* slim toolbar — view switch · device · reset (AUDIO/VISUAL is in the tab row) */}
      <div className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-b border-white/5 bg-black/25">
        <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
          {VIEW_DEFS.map((v) => {
            const Icon = v.icon;
            const on = view === v.id;
            return (
              <button
                key={v.id}
                onClick={() => { setView(v.id); setBank(0); }}
                className={`px-2.5 py-1 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest transition-colors ${
                  on ? 'bg-indigo-500/20 text-indigo-200 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.5)]' : 'text-zinc-500 hover:text-zinc-200'
                }`}
                title={`${v.label} view`}
              >
                <Icon className="w-3 h-3" /> {v.label}
              </button>
            );
          })}
        </div>

        <span className="w-px h-4 bg-white/10" />

        <span
          className={`w-1.5 h-1.5 rounded-full ${midiInputs.length > 0 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-zinc-600'}`}
          title={midiInputs.length > 0 ? `MIDI: ${midiInputs.join(', ')}` : 'No MIDI device connected'}
        />
        <label htmlFor="slide-controller-profile" className="sr-only">Controller profile</label>
        <select
          id="slide-controller-profile"
          name="slide-controller-profile"
          value={profileId}
          onChange={(e) => { setProfileId(e.target.value); setAutoDetect(false); setBank(0); }}
          className="bg-[#111114] text-zinc-300 border border-white/12 rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider outline-none"
          title="Controller profile — picking one turns Auto off so your choice sticks"
        >
          {/* GANTASMO on-screen XR twin — always first in the list. */}
          {CONTROLLER_PROFILES.filter((p) => p.id === GANTASMO_WORLDS_COLLIDE_ID).map((p) => (
            <optgroup key="gantasmo" label="GANTASMO">
              <option value={p.id}>{p.name} · {profileControlCount(p)}</option>
            </optgroup>
          ))}
          {/* Audima Sway — pinned second so the 6-dimension motion surface sits
              one click below the GANTASMO twin. */}
          {CONTROLLER_PROFILES.filter((p) => p.id === AUDIMA_SWAY_ID).map((p) => (
            <optgroup key="sway" label="SWAY">
              <option value={p.id}>{p.name} · {profileControlCount(p)}</option>
            </optgroup>
          ))}
          {learnedProfiles.length > 0 && (
            <optgroup label="LEARNED (your devices)">
              {learnedProfiles
                .map((l) => l.profile)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {profileControlCount(p)}</option>
                ))}
            </optgroup>
          )}
          {(['dj', 'pad', 'mixer', 'keys', 'generic'] as const).map((cat) => {
            const inCat = CONTROLLER_PROFILES
              .filter((p) => (p.category ?? 'generic') === cat && p.id !== GANTASMO_WORLDS_COLLIDE_ID && p.id !== AUDIMA_SWAY_ID)
              .sort((a, b) => a.name.localeCompare(b.name)); // alpha within each group
            if (inCat.length === 0) return null;
            return (
              <optgroup key={cat} label={cat.toUpperCase()}>
                {inCat.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {profileControlCount(p)}</option>
                ))}
              </optgroup>
            );
          })}
        </select>

        {/* Unified device setup — one button → mode menu (Auto / Identify by
            AI photo / Learn by wiggling / Manual map). The transient capture
            state takes over inline while a Learn session is running. */}
        {learnPhase === 'capturing' ? (
          <span className="flex items-center gap-1.5">
            <span className="px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border border-amber-500/50 bg-amber-500/15 text-amber-200 animate-pulse">
              ◉ Listening · {capturedCount} ctrl{capturedCount === 1 ? '' : 's'}
            </span>
            <button
              onClick={() => { const id = commitLearn(`My Controller (${capturedCount})`); if (id) { setProfileId(id); setAutoDetect(false); setBank(0); } }}
              disabled={capturedCount === 0}
              className="px-1.5 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border border-emerald-500/50 bg-emerald-500/15 text-emerald-200 disabled:opacity-30"
              title="Finish — build a profile from the controls you exercised"
            >
              Done
            </button>
            <button
              onClick={cancelLearn}
              className="px-1.5 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border border-white/12 text-zinc-400 hover:text-zinc-200"
              title="Cancel capture"
            >
              ✕
            </button>
          </span>
        ) : (
          <DeviceSetupMenu
            autoDetect={autoDetect}
            detectedName={detected?.name ?? null}
            hasDevice={midiInputs.length > 0}
            onToggleAuto={() => setAutoDetect(!autoDetect)}
            onIdentify={() => setCvOpen(true)}
            onLearn={() => { enableMidi(); startLearn(); }}
            onMap={() => { setView('controller'); setBank(0); setMapMode(true); }}
          />
        )}

        <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider">
          {catalog.length} {content === 'visual' ? 'fx' : 'tracks'} · {pageSize}/page
        </span>

        <span className="flex-1" />

        {/* page navigation — ←/→ keys always work; this cluster mirrors that and
            picks which hardware control also flips pages (binds in Phase 2). */}
        <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
          <button
            onClick={() => goToPage(bank - 1)}
            className="px-1.5 py-1 text-zinc-400 hover:text-white hover:bg-white/5"
            title="Previous page (←) — wraps to last"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="px-1 text-[9px] font-mono tabular-nums text-zinc-300 min-w-10.5 text-center">
            {bank + 1}/{pageCount}
          </span>
          <button
            onClick={() => goToPage(bank + 1)}
            className="px-1.5 py-1 text-zinc-400 hover:text-white hover:bg-white/5"
            title="Next page (→) — wraps to first"
            aria-label="Next page"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <label htmlFor="slide-pagenav-binding" className="sr-only">Page navigation binding</label>
        <select
          id="slide-pagenav-binding"
          name="slide-pagenav-binding"
          value={pageNavBinding}
          onChange={(e) => setPageNavBinding(e.target.value as typeof pageNavBinding)}
          className="bg-[#111114] text-zinc-300 border border-white/12 rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider outline-none"
          title="Which control flips pages. ← / → keys always work; hardware bindings activate when a controller is connected."
        >
          <option value="keys">PG: ← / → keys</option>
          <option value="track-select">PG: Track Select</option>
          <option value="send-select">PG: Send Select</option>
          <option value="none">PG: none</option>
        </select>

        {/* MAP cluster — only in controller view; binds physical controls to
            on-screen positions so incoming MIDI lands correctly. */}
        {view === 'controller' && <MapToolbar profileId={profileId} positions={deviceSlots.map((s) => s.pos)} />}

        {content === 'visual' && (
          <button
            onClick={() => { const id = addStack(); setBank(0); void id; }}
            className="px-2 py-1 rounded-md border border-pink-500/40 bg-pink-500/10 text-pink-200 hover:bg-pink-500/20 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1"
            title="Add a custom stack lane — one slider bound to media + effect(s)"
          >
            <Plus className="w-3 h-3" /> Stack
          </button>
        )}

        <button
          onClick={resetAssignments}
          className="px-2 py-1 rounded-md border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1"
          title="Clear all manual locks / rearrangements"
        >
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
      </div>

      {/* surface */}
      <div className={`flex-1 min-h-0 overflow-auto relative flex flex-col ${view === 'controller' ? 'p-3' : 'px-3 pt-3 pb-0'}`}>
        {view === 'controller' ? (
          profileId === GANTASMO_WORLDS_COLLIDE_ID ? (
            // GANTASMO on-screen twin of the Quest XR MIDI surface.
            <WorldsCollidePanel profileId={profileId} />
          ) : (
          // Controller view OPENS FITTED to the window, mouse-wheel zooms, and
          // left-click drag on the background pans around the device.
          <>
            <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md border border-white/12 bg-black/60 backdrop-blur px-1 py-0.5">
              <button onClick={() => setCtrlZoom((z) => clampZoom(z - 0.1))} className="px-1.5 py-0.5 text-zinc-300 hover:text-white text-[11px]" title="Zoom out">−</button>
              <button onClick={fitZoom} className="px-1.5 py-0.5 text-[8px] font-mono text-zinc-400 hover:text-white tabular-nums" title="Fit the whole controller in the window">{Math.round(ctrlZoom * 100)}%</button>
              <button onClick={() => setCtrlZoom((z) => clampZoom(z + 0.1))} className="px-1.5 py-0.5 text-zinc-300 hover:text-white text-[11px]" title="Zoom in">+</button>
            </div>
            <div ref={ctrlSurfaceRef} className="min-h-full flex items-start justify-center" title="Scroll to zoom · drag the background to pan">
              <div style={ctrlNat ? { width: ctrlNat.w * ctrlZoom, height: ctrlNat.h * ctrlZoom } : undefined}>
                <div ref={ctrlContentRef} style={{ transform: `scale(${ctrlZoom})`, transformOrigin: 'top left', transition: 'transform 0.12s ease', width: 'fit-content' }}>
                  <ControllerView
                    profile={profile}
                    content={content}
                    bank={bank}
                    deviceSize={deviceSize}
                    pageCount={pageCount}
                    pageColor={pageColor}
                    resolve={resolve}
                    onDropItem={onDropItem}
                    onPickPage={setBank}
                    profileId={profileId}
                    mapMode={mapMode}
                    learnPos={learnPos}
                    autoWalk={autoWalk}
                  />
                </div>
              </div>
            </div>
          </>
          )
        ) : view === 'focus' ? (
          // mt-auto anchors the lanes to the BOTTOM of the panel; the page
          // controller below them is sticky so it never scrolls away.
          <div className="mt-auto">
            <FocusStrip
              content={content}
              items={focusItems}
              pageSize={pageSize}
              startPage={bank}
              pageColor={pageColor}
              pageCount={pageCount}
              onDropItem={onDropItem}
              onPickPage={setBank}
            />
          </div>
        ) : (
          <div className="mt-auto">
            <RowView
              content={content}
              bank={bank}
              pageSize={pageSize}
              pageCount={pageCount}
              pageColor={pageColor}
              resolve={resolve}
              onDropItem={onDropItem}
              onPickPage={setBank}
            />
          </div>
        )}
      </div>

      {cvOpen && (
        <ControllerVisionModal
          onClose={() => setCvOpen(false)}
          onBuilt={(id) => { setProfileId(id); setAutoDetect(false); setBank(0); setCvOpen(false); }}
        />
      )}
    </div>
  );
};

/* ---- ROW view ---- */
const RowView: React.FC<{
  content: SlideContent;
  bank: number;
  pageSize: number;
  pageCount: number;
  pageColor: string;
  resolve: (i: number) => { item: string | null; locked: boolean };
  onDropItem: (from: number, to: number) => void;
  onPickPage: (p: number) => void;
}> = ({ content, bank, pageSize, pageCount, pageColor, resolve, onDropItem, onPickPage }) => {
  const start = bank * pageSize;
  return (
    <div className="sl-section">
      <div className="sl-section-head">SLIDERS · {content.toUpperCase()} · all faders, paged</div>
      <div className="sl-strip">
        {Array.from({ length: pageSize }, (_, i) => {
          const index = start + i;
          const { item, locked } = resolve(index);
          return (
            <Slot
              key={index}
              index={index}
              kind="fader"
              content={content}
              item={item}
              locked={locked}
              colColor={PAD_COLORS[i % PAD_COLORS.length]}
              onDropItem={onDropItem}
            />
          );
        })}
      </div>
      <div className="sl-pagedock">
        <PageLight count={pageCount} active={bank} color={pageColor} onPick={onPickPage} />
      </div>
    </div>
  );
};

/* ---- Unified device-setup menu (one button → the 4 ways to set up a device) ---- */
const DeviceSetupMenu: React.FC<{
  autoDetect: boolean;
  detectedName: string | null;
  hasDevice: boolean;
  onToggleAuto: () => void;
  onIdentify: () => void;
  onLearn: () => void;
  onMap: () => void;
}> = ({ autoDetect, detectedName, hasDevice, onToggleAuto, onIdentify, onLearn, onMap }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const item = 'w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-white/5 transition-colors';
  const close = (fn: () => void) => () => { fn(); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border border-white/12 text-zinc-300 hover:text-indigo-200 hover:border-indigo-500/40 flex items-center gap-1"
        title="Set up your controller — auto-detect, identify by photo, learn by wiggling, or map manually"
      >
        <Sliders className="w-3 h-3" /> Set up device
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-64 rounded-lg border border-white/12 bg-[#0c0a14] shadow-2xl overflow-hidden">
          <button onClick={close(onToggleAuto)} className={item}>
            <Radio className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${autoDetect ? 'text-emerald-300' : 'text-zinc-500'}`} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-zinc-100">
                Auto-detect {autoDetect && <Check className="w-3 h-3 text-emerald-300" />}
              </span>
              <span className="block text-[8px] text-zinc-500">
                {autoDetect ? (detectedName ? `On — matched ${detectedName}` : hasDevice ? 'On — no match for connected device' : 'On — waiting for a device') : 'Match a profile from the connected device name'}
              </span>
            </span>
          </button>
          <button onClick={close(onIdentify)} className={item}>
            <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-300" />
            <span className="min-w-0">
              <span className="block text-[10px] font-bold text-zinc-100">Identify by photo (AI)</span>
              <span className="block text-[8px] text-zinc-500">Snap/upload a photo — AI names it + builds the layout. Most accurate.</span>
            </span>
          </button>
          <button onClick={close(onLearn)} className={item}>
            <Wand2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300" />
            <span className="min-w-0">
              <span className="block text-[10px] font-bold text-zinc-100">Learn by wiggling</span>
              <span className="block text-[8px] text-zinc-500">Move each control once — builds the exact layout + mapping from your hardware.</span>
            </span>
          </button>
          <button onClick={close(onMap)} className={item}>
            <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-cyan-300" />
            <span className="min-w-0">
              <span className="block text-[10px] font-bold text-zinc-100">Map manually</span>
              <span className="block text-[8px] text-zinc-500">Controller view: click a slot, then move its control to bind it.</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

/* ---- MAP toolbar (controller view only) ---- */
const MapToolbar: React.FC<{ profileId: string; positions: number[] }> = ({ profileId, positions }) => {
  const mapMode = useControllerMapStore((s) => s.mapMode);
  const autoWalk = useControllerMapStore((s) => s.autoWalk);
  const setMapMode = useControllerMapStore((s) => s.setMapMode);
  const setLearnPos = useControllerMapStore((s) => s.setLearnPos);
  const setAutoWalk = useControllerMapStore((s) => s.setAutoWalk);
  const clearProfile = useControllerMapStore((s) => s.clearProfile);

  const startAuto = () => {
    setMapMode(true);
    clearProfile(profileId); // fresh walk — so "already bound" only means "mapped in this pass"
    setAutoWalk(true);
    setLearnPos(positions[0] ?? null); // wiggle controls in order; auto-advances
  };

  return (
    <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
      <button
        onClick={() => setMapMode(!mapMode)}
        className={`px-2 py-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider transition-colors ${
          mapMode ? 'bg-amber-500/20 text-amber-200 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.5)]' : 'text-zinc-400 hover:text-white'
        }`}
        title="MAP mode — click a control's chip then wiggle the matching hardware control to bind it"
      >
        <Target className="w-3 h-3" /> Map
      </button>
      {mapMode && (
        <>
          <button
            onClick={startAuto}
            className={`px-2 py-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider border-l border-white/10 ${
              autoWalk ? 'bg-amber-500/15 text-amber-200 animate-pulse' : 'text-zinc-400 hover:text-white'
            }`}
            title="Auto-map — wiggle each control in order; binding auto-advances"
          >
            <Wand2 className="w-3 h-3" /> {autoWalk ? 'Mapping…' : 'Auto'}
          </button>
          <button
            onClick={() => clearProfile(profileId)}
            className="px-2 py-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider border-l border-white/10 text-zinc-400 hover:text-rose-300"
            title="Clear all bindings for this controller profile"
          >
            <RotateCcw className="w-3 h-3" /> Clear
          </button>
        </>
      )}
    </div>
  );
};

/* ---- CONTROLLER view ---- */
const ControllerView: React.FC<{
  profile: ControllerProfile;
  content: SlideContent;
  bank: number;
  deviceSize: number;
  pageCount: number;
  pageColor: string;
  resolve: (i: number) => { item: string | null; locked: boolean };
  onDropItem: (from: number, to: number) => void;
  onPickPage: (p: number) => void;
  profileId: string;
  mapMode: boolean;
  learnPos: number | null;
  autoWalk: boolean;
}> = ({ profile, content, bank, deviceSize, pageCount, pageColor, resolve, onDropItem, onPickPage, profileId, mapMode, learnPos, autoWalk }) => {
  const bindings = useControllerMapStore((s) => s.bindings[profileId]);
  const setLearnPos = useControllerMapStore((s) => s.setLearnPos);
  const clearPos = useControllerMapStore((s) => s.clearPos);
  const base = bank * deviceSize;
  let local = 0;
  return (
    <>
      {mapMode && (
        <div className="sl-map-banner">
          {autoWalk
            ? 'AUTO-MAP — wiggle each highlighted control on your device, in order. It advances automatically.'
            : 'MAP MODE — click a control’s chip below, then move the matching knob/fader/button on your device to bind it.'}
        </div>
      )}
      {profile.sections.map((sec) => {
        const n = sec.rows * sec.cols;
        const cells: React.ReactNode[] = [];
        for (let i = 0; i < n; i++, local++) {
          const index = base + local;
          const pos = local;
          const { item, locked } = resolve(index);
          const binding = bindings?.[pos];
          const learning = learnPos === pos;
          cells.push(
            <div className="sl-mapcell" key={index}>
              <Slot
                index={index}
                kind={sec.kind}
                content={content}
                item={item}
                locked={locked}
                colColor={PAD_COLORS[(i % sec.cols) % PAD_COLORS.length]}
                onDropItem={onDropItem}
                muteUnmapped
              />
              {mapMode && (
                <button
                  className={`sl-mapchip${learning ? ' learning' : ''}${binding ? ' bound' : ''}`}
                  onClick={() => setLearnPos(learning ? null : pos)}
                  onContextMenu={(e) => { e.preventDefault(); clearPos(profileId, pos); }}
                  title={
                    learning
                      ? 'Waiting — move a control on your device. Right-click to clear.'
                      : binding
                        ? `Bound to ${bindingLabel(binding)} (ch ${binding.channel + 1}). Click to relearn, right-click to clear.`
                        : 'Unmapped — click, then move the matching control on your device.'
                  }
                >
                  {learning ? '◉ learn' : bindingLabel(binding)}
                </button>
              )}
            </div>,
          );
        }
        return (
          <div className="sl-section" key={sec.id}>
            <div className="sl-section-head">{sec.label} · {sec.rows}×{sec.cols}</div>
            <div className="sl-grid" style={{ gridTemplateColumns: `repeat(${sec.cols}, var(--lane))` }}>
              {cells}
            </div>
          </div>
        );
      })}
      <PageLight count={pageCount} active={bank} color={pageColor} onPick={onPickPage} />
    </>
  );
};
