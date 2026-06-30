import React from 'react';
import { useSoundfontStore, ensureSoundfontReady } from '../../lib/soundfontEngine';
import { GM_NAMES } from '../../lib/gmInstruments';
import { SYNTH_VOICES } from '../../lib/synthVoices';

const VOICE_GROUPS = Array.from(new Set(SYNTH_VOICES.map((v) => v.group)));

/**
 * Single dropdown that picks the MIDI voice: the built-in sawtooth ("Basic") or
 * a General MIDI soundfont program. Drives the shared soundfont store, so the
 * choice applies to live preview, playback, and offline WAV bounce alike.
 */
export const InstrumentPicker: React.FC = () => {
  const useSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const activeProgram = useSoundfontStore((s) => s.activeProgram);
  const activeSynthVoice = useSoundfontStore((s) => s.activeSynthVoice);
  const loading = useSoundfontStore((s) => s.loading);
  const loadError = useSoundfontStore((s) => s.loadError);
  const setUseSoundfont = useSoundfontStore((s) => s.setUseSoundfont);
  const setActiveProgram = useSoundfontStore((s) => s.setActiveProgram);
  const setActiveSynthVoice = useSoundfontStore((s) => s.setActiveSynthVoice);

  const value = activeSynthVoice ? `v:${activeSynthVoice}` : useSoundfont ? String(activeProgram) : 'basic';

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'basic') {
      setUseSoundfont(false);
      setActiveSynthVoice(null);
      return;
    }
    if (v.startsWith('v:')) {
      setActiveSynthVoice(v.slice(2)); // procedural EDM voice (clears soundfont)
      return;
    }
    setActiveProgram(Number(v));
    setUseSoundfont(true); // clears any synth voice
    void ensureSoundfontReady(); // warm the worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor="pr-instrument" className="text-xs text-white/50">
        Instrument
      </label>
      <select
        id="pr-instrument"
        name="pr-instrument"
        aria-label="MIDI instrument"
        value={value}
        onChange={onChange}
        className="form-select px-2 py-1 text-xs max-w-44"
        style={{ colorScheme: 'dark' }}
      >
        <option value="basic">Basic (sawtooth)</option>
        {VOICE_GROUPS.map((g) => (
          <optgroup key={g} label={`Synth · ${g}`}>
            {SYNTH_VOICES.filter((vv) => vv.group === g).map((vv) => (
              <option key={vv.id} value={`v:${vv.id}`}>{vv.name}</option>
            ))}
          </optgroup>
        ))}
        <optgroup label="General MIDI">
          {GM_NAMES.map((n, i) => (
            <option key={n} value={i}>{`${i + 1}. ${n}`}</option>
          ))}
        </optgroup>
      </select>
      {loading && <span className="text-xs text-white/40">loading…</span>}
      {loadError && (
        <span className="text-xs text-amber-400" title={loadError}>
          soundfont failed
        </span>
      )}
    </div>
  );
};
