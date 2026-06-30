import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Wand2, Music, Layers, Shuffle, Zap, Loader2, Cloud, KeyRound, RefreshCw, Sparkles, ListMusic, Settings } from 'lucide-react';
import { useSunoStore, type SunoMode } from './sunoStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { SunoModeFields } from './SunoModeFields';
import { SunoJobList } from './SunoJobList';
import { HoverTip, InfoTip } from '../components/ui/Tooltip';

/**
 * SunoGenPanel — the cloud (Suno) generation workspace ("Aurora Cloud Console").
 * Rendered by AdvancedGenPanel when `generateParamsStore.model === 'suno'`. The
 * model dropdown in the hero bar is bound to that same store: selecting a Stable
 * Audio model flips `model` back and the parent re-renders into the local panel.
 *
 * This is a presentation-only treatment over the existing store wiring — all
 * handlers, tooltips, and the KeyBanner/UsageBadge logic are unchanged.
 */

/** Per-mode visual identity (literal classes so Tailwind keeps them). */
const MODE_STYLE: Record<SunoMode, { token: string; ring: string; bar: string }> = {
  simple: { token: 'text-violet-300 bg-violet-500/15', ring: 'border-violet-400/60 bg-violet-500/12', bar: 'bg-violet-400' },
  custom: { token: 'text-sky-300 bg-sky-500/15', ring: 'border-sky-400/60 bg-sky-500/12', bar: 'bg-sky-400' },
  cover: { token: 'text-amber-300 bg-amber-500/15', ring: 'border-amber-400/60 bg-amber-500/12', bar: 'bg-amber-400' },
  mashup: { token: 'text-fuchsia-300 bg-fuchsia-500/15', ring: 'border-fuchsia-400/60 bg-fuchsia-500/12', bar: 'bg-fuchsia-400' },
};

const MODES: { key: SunoMode; icon: React.ReactNode; label: string; desc: string; tip: { title: string; body: string } }[] = [
  {
    key: 'simple',
    icon: <Wand2 className="w-4 h-4" />,
    label: 'Simple',
    desc: 'Describe it — Suno writes lyrics & picks the style',
    tip: {
      title: 'Simple Mode',
      body: 'The fastest way to a full song — just describe what you want.\n\n• Suno writes the lyrics for you\n• Suno chooses a fitting musical style\n• Only a Description is required (no style string)\n• Optional: a title and a preset voice',
    },
  },
  {
    key: 'custom',
    icon: <Music className="w-4 h-4" />,
    label: 'Custom',
    desc: 'Your own lyrics + a style string',
    tip: {
      title: 'Custom Mode',
      body: 'Full control over the song — you supply the words and the sound.\n\n• A Style string is required (genre, instruments, mood)\n• Provide your own Lyrics, or toggle Instrumental for no vocals\n• Use the section chips ([Verse], [Chorus]…) to structure lyrics\n• Optional: a title and a preset voice',
    },
  },
  {
    key: 'cover',
    icon: <Layers className="w-4 h-4" />,
    label: 'Cover',
    desc: 'Re-style an existing Suno clip you own',
    tip: {
      title: 'Cover Mode',
      body: 'Re-imagine a Suno clip you already own in a new style.\n\n• Requires the Source Clip ID of one of your Suno tracks\n• Optional new style and/or lyrics to re-interpret it\n• Leave lyrics empty for an instrumental cover\n• Tip: use a library track’s Cover button to prefill the id',
    },
  },
  {
    key: 'mashup',
    icon: <Shuffle className="w-4 h-4" />,
    label: 'Mashup',
    desc: 'Blend two Suno clips you own',
    tip: {
      title: 'Mashup Mode',
      body: 'Blend two of your own Suno clips into one new track.\n\n• Requires both clip IDs (a base and a second clip)\n• Optional style and lyrics steer the blend\n• Leave lyrics empty for an instrumental mashup\n• Voice selection is not available for mashups',
    },
  },
];

const KEY_TIP = {
  title: 'Suno API Key',
  body: 'Cloud generation runs on Suno’s servers and needs your secret key.\n\n• Paste your sk_live_… key from platform.suno.com\n• Stored on the backend only — never in the browser\n• Once saved, the “key required” banner clears automatically',
};

const OUTPUT_TIP = {
  title: 'Render Queue',
  body: 'Every generation you submit appears here as a job.\n\n• Jobs poll automatically every few seconds until done\n• Play finished tracks through the shared player engine\n• Reuse a finished clip as a Cover or Mashup base\n• Completed tracks are auto-imported into your Library',
};

// Stable Audio models + Suno, so the user can switch back from the same dropdown.
const MODEL_OPTIONS = [
  { value: 'small', label: 'Small (ARC)' },
  { value: 'medium', label: 'Medium (ARC)' },
  { value: 'small-rf', label: 'Small-RF' },
  { value: 'medium-rf', label: 'Medium-RF' },
  { value: 'suno', label: 'Suno (Cloud)' },
];

/** Slim "key required" notice. The actual key INPUT lives in Settings → Suno API
 *  (SunoKeySettings); this just points the user there and opens it. */
const KeyNotice: React.FC = () => (
  <div className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/6 px-3 py-2">
    <span className="grid place-items-center w-6 h-6 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 shrink-0">
      <KeyRound className="w-3.5 h-3.5" />
    </span>
    <div className="flex-1 min-w-0">
      <div className="mono-label text-[10px]! text-amber-300! flex items-center gap-1">
        Suno API key required <InfoTip {...KEY_TIP} />
      </div>
      <p className="text-[9px] text-zinc-500 font-mono leading-tight mt-0.5">Add your key in Settings to enable cloud generation.</p>
    </div>
    <HoverTip text="Open Settings → Suno API to paste your sk_live_… key (stored server-side).">
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('thedaw:open-settings'))}
        className="shrink-0 mono-tag bg-amber-500/20! text-amber-200! border-amber-500/40! hover:bg-amber-500/30! flex items-center gap-1"
      >
        <Settings className="w-3 h-3" /> Open Settings
      </button>
    </HoverTip>
  </div>
);

/** Small credits/plan readout derived from the /usage payload. */
const UsageBadge: React.FC = () => {
  const usage = useSunoStore((s) => s.usage);
  if (!usage) return null;
  const metered = (usage.metered_features ?? {}) as Record<
    string,
    { limits?: { per_lifetime?: number }; usage?: { lifetime?: number } }
  >;
  const entries = Object.values(metered);
  const limit = entries.reduce((m, f) => Math.max(m, f.limits?.per_lifetime ?? 0), 0);
  const used = entries.reduce((m, f) => Math.max(m, f.usage?.lifetime ?? 0), 0);
  const remaining = Math.max(0, limit - used);
  const plan = typeof usage.plan_id === 'string' ? usage.plan_id.replace(/[-_]/g, ' ') : null;
  if (!plan && limit === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/8 bg-white/3 px-2 py-0.5 text-[8px] font-mono text-zinc-500">
      {plan && <span className="text-zinc-300 uppercase tracking-wider">{plan}</span>}
      {limit > 0 && (
        <span>
          {plan ? ' · ' : ''}
          <span className="text-emerald-300">{remaining.toLocaleString()}</span>/{limit.toLocaleString()} cr
        </span>
      )}
    </span>
  );
};

/** Live connection status dot derived from apiConfigured. */
const StatusDot: React.FC<{ state: boolean | null }> = ({ state }) => {
  const color = state === true ? 'bg-emerald-400' : state === false ? 'bg-amber-400' : 'bg-zinc-500';
  const label = state === true ? 'Connected' : state === false ? 'No API key' : 'Checking…';
  return (
    <HoverTip text={`Suno cloud: ${label}.`}>
      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex w-2 h-2">
          {state === true && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/60 animate-ping" />}
          <span className={`relative inline-flex rounded-full w-2 h-2 ${color}`} />
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
      </span>
    </HoverTip>
  );
};

const fade = (delay: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, delay, ease: [0.22, 1, 0.36, 1] as const },
});

export const SunoGenPanel: React.FC = () => {
  const mode = useSunoStore((s) => s.mode);
  const setMode = useSunoStore((s) => s.setMode);
  const submit = useSunoStore((s) => s.submit);
  const submitting = useSunoStore((s) => s.submitting);
  const apiConfigured = useSunoStore((s) => s.apiConfigured);
  const checkStatus = useSunoStore((s) => s.checkStatus);
  const loadJobs = useSunoStore((s) => s.loadJobs);
  const loadUsage = useSunoStore((s) => s.loadUsage);
  const jobCount = useSunoStore((s) => s.jobs.length);

  const model = useGenerateParamsStore((s) => s.model);
  const patchParams = useGenerateParamsStore((s) => s.patch);

  const [err, setErr] = useState<string | null>(null);

  // On mount: confirm key state, hydrate jobs (resumes polling), pull usage.
  useEffect(() => {
    void checkStatus();
    void loadJobs();
    void loadUsage();
  }, [checkStatus, loadJobs, loadUsage]);

  const onGenerate = async () => {
    setErr(null);
    try {
      await submit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const activeDesc = MODES.find((m) => m.key === mode)?.desc;

  return (
    <div className="absolute inset-0 flex flex-col text-zinc-200 overflow-hidden">
      {/* ── Atmosphere: aurora gradient mesh + faint grain (signals "cloud") ── */}
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-1/3 -left-1/4 w-3/5 h-4/5 rounded-full bg-purple-600/12 blur-[90px]" />
        <div className="absolute top-1/4 right-0 w-[45%] h-[70%] rounded-full bg-fuchsia-600/8 blur-[90px]" />
        <div className="absolute bottom-0 left-1/3 w-2/5 h-1/2 rounded-full bg-teal-500/8 blur-[90px]" />
        <div
          className="absolute inset-0 opacity-4 mix-blend-soft-light"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          }}
        />
      </div>

      {/* ── Hero identity bar ── */}
      <motion.header
        {...fade(0)}
        className="relative shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/8 bg-linear-to-r from-purple-950/40 via-[#0a0810]/30 to-transparent backdrop-blur-sm"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="relative grid place-items-center w-8 h-8 rounded-lg bg-linear-to-br from-purple-500/25 to-fuchsia-500/10 border border-purple-400/30 shadow-[0_0_20px_-6px_rgba(168,85,247,0.7)]">
            <Cloud className="w-4 h-4 text-purple-200" />
            <Sparkles className="w-2.5 h-2.5 text-fuchsia-300 absolute -top-1 -right-1" />
          </span>
          <div className="flex flex-col leading-none min-w-0">
            <span className="text-[8px] font-mono uppercase tracking-[0.35em] text-purple-300/60">Cloud Engine</span>
            <span className="text-[15px] font-black tracking-tight text-zinc-50">
              Suno<span className="text-purple-400">.</span>
            </span>
          </div>
          <span className="hidden sm:block h-6 w-px bg-white/8 mx-1" />
          <StatusDot state={apiConfigured} />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <UsageBadge />
          <HoverTip text="Switch the active model. Pick a Stable Audio model to return to the local generator; keep Suno (Cloud) for cloud generation.">
            <div className="relative">
              <select
                name="suno-model"
                className="appearance-none rounded-full border border-purple-400/30 bg-purple-500/10 hover:bg-purple-500/15 pl-3 pr-7 py-1 text-[10px] font-bold uppercase tracking-wider text-purple-100 outline-none transition-colors cursor-pointer"
                value={model}
                onChange={(e) => patchParams({ model: e.target.value })}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value} className="bg-[#0a080f] text-zinc-200 normal-case tracking-normal">
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-purple-300/70 text-[8px]">▾</span>
            </div>
          </HoverTip>
        </div>
      </motion.header>

      {/* ── Body: composer (left) + render queue (right) ── */}
      <div className="relative flex-1 min-h-0 flex">
        {/* Composer — content constrained to a readable centered column so it
            doesn't stretch across the very wide Make pane. */}
        <div className="flex-1 min-w-0 overflow-y-auto no-scrollbar border-r border-white/5">
          <div className="w-full max-w-2xl mx-auto px-5 py-4 flex flex-col gap-3.5">
            <AnimatePresence>
              {apiConfigured === false && (
                <motion.div {...fade(0.02)} exit={{ opacity: 0, height: 0 }}>
                  <KeyNotice />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Mode selector — compact segmented control with a sliding pill */}
            <motion.div {...fade(0.06)}>
              <span className="mono-label text-[10px]! block mb-1.5">Mode</span>
              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg border border-white/8 bg-black/30">
                {MODES.map((m) => {
                  const active = mode === m.key;
                  const st = MODE_STYLE[m.key];
                  return (
                    <HoverTip key={m.key} text={m.desc}>
                      {/* role=button (not <button>) so the per-mode InfoTip — which
                          renders its own <button> — is not nested inside a button. */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setMode(m.key)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode(m.key); } }}
                        className="relative w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md transition-colors cursor-pointer"
                      >
                        {active && (
                          <motion.span
                            layoutId="suno-mode-active"
                            className={`absolute inset-0 rounded-md border ${st.ring}`}
                            transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                          />
                        )}
                        <span className={`relative z-10 ${active ? st.token.split(' ')[0] : 'text-zinc-500'}`}>{m.icon}</span>
                        <span className={`relative z-10 text-[9px] font-black uppercase tracking-widest ${active ? 'text-zinc-100' : 'text-zinc-500'}`}>
                          {m.label}
                        </span>
                        <span className="relative z-10">
                          <InfoTip {...m.tip} />
                        </span>
                      </div>
                    </HoverTip>
                  );
                })}
              </div>
              <p className="text-[9px] text-zinc-500 font-mono mt-1.5 text-center italic">{activeDesc}</p>
            </motion.div>

            {/* Compose card */}
            <motion.div {...fade(0.1)} className="rounded-lg border border-white/8 bg-[#0b0910]/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/5 bg-white/2">
                <Sparkles className="w-3 h-3 text-purple-400" />
                <span className="mono-label text-[9px]!">Compose</span>
              </div>
              <div className="p-3">
                <SunoModeFields />
              </div>
            </motion.div>

            {/* Generate */}
            <motion.div {...fade(0.14)} className="flex flex-col gap-1.5 [&>span]:w-full">
              <HoverTip text="Submit this generation to Suno. The job appears in the render queue and polls until the track is ready.">
                <button
                  onClick={() => void onGenerate()}
                  disabled={submitting || apiConfigured === false}
                  className="group relative w-full py-2.5 rounded-lg overflow-hidden font-black uppercase tracking-[0.2em] text-[11px] text-white
                    bg-linear-to-r from-purple-600 via-fuchsia-600 to-purple-600 bg-size-[200%_100%] hover:bg-position-[100%_0]
                    shadow-[0_6px_22px_-10px_rgba(168,85,247,0.9)] transition-[background-position,transform,box-shadow] duration-500
                    active:scale-99 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
                >
                  <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-out bg-linear-to-r from-transparent via-white/20 to-transparent skew-x-12 pointer-events-none" />
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Summoning…
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 fill-current" /> Generate
                    </>
                  )}
                </button>
              </HoverTip>
              {err && <span className="text-[9px] text-red-400 text-center">{err}</span>}
            </motion.div>
          </div>
        </div>

        {/* Render queue — min-h-0 lets the column bound its height so ONLY
            the job list scrolls; the header stays pinned (shrink-0) instead
            of the whole column compressing when the pane is short. */}
        <motion.div {...fade(0.12)} className="w-80 shrink-0 min-h-0 flex flex-col bg-[#08060c]/60 backdrop-blur-sm">
          <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-white/8">
            <span className="mono-label text-[10px]! flex items-center gap-1.5">
              <ListMusic className="w-3.5 h-3.5 text-purple-400" />
              Render Queue
              {jobCount > 0 && (
                <span className="grid place-items-center min-w-4 h-4 px-1 rounded-full bg-purple-500/20 border border-purple-500/30 text-[8px] font-bold text-purple-200">
                  {jobCount}
                </span>
              )}
              <InfoTip {...OUTPUT_TIP} />
            </span>
            <HoverTip text="Reload the job list and refresh your remaining credits.">
              <button
                className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                onClick={() => {
                  void loadJobs();
                  void loadUsage();
                }}
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </HoverTip>
          </div>
          <SunoJobList />
        </motion.div>
      </div>
    </div>
  );
};
