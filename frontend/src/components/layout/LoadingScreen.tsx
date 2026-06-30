import React, { useEffect, useState } from 'react';
import { LiquidChromeTitle } from './LiquidChromeTitle';

interface LoadingScreenProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/**
 * The boot screen IS the cinematic. A solid BLACK background fills the whole
 * screen (the one continuous backdrop from the first frame after boot through to
 * the app — matches index.html's splash + the Electron window). A full-bleed
 * stack sits on it: the liquid-chrome theDAW model (~2.5x the logo), a small
 * 3D-ish "by", and the animated GANTASMO logo. No labels, never says "loading".
 * If WebGL doesn't start, the model area falls back to static branding (and
 * reports complete so the host doesn't hang). A tiny "continue without backend"
 * escape appears only after a genuinely long wait.
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const [cinematicActive, setCinematicActive] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // If WebGL never started there is no formation to wait on — report complete so
  // the host hands off the moment the backend is ready.
  useEffect(() => {
    if (cinematicActive === false && elapsed >= 1) onComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cinematicActive, elapsed]);

  return (
    <div className="fixed inset-0 z-200 select-none overflow-hidden bg-black flex flex-col items-center gap-1.5 pt-10">
      <style>{`@keyframes bootCreditFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>

      {/* theDAW — liquid-chrome 3D model, transparent over the black background.
          Anchored to the top 50vh (the model sits LOW in it via the camera) so
          "by" right below lands at the vertical center, tight under the model. */}
      <div className="relative w-full shrink-0" style={{ height: '50vh' }}>
        <LiquidChromeTitle onActive={setCinematicActive} onComplete={onComplete} />
        {/* Static fallback ONLY if WebGL never starts (model can't render). */}
        {!cinematicActive && elapsed >= 3 && (
          <span className="absolute inset-0 flex items-end justify-center pb-2 text-4xl font-black uppercase tracking-[0.36em] pl-[0.36em] text-zinc-100">
            theDAW
          </span>
        )}
      </div>

      {/* by — small, 3D-ish chrome lettering. */}
      <span
        style={{
          fontFamily: "'Orbitron', system-ui, sans-serif",
          fontWeight: 700,
          letterSpacing: '0.18em',
          fontSize: 'clamp(11px, 2.2vh, 24px)',
          backgroundImage:
            'linear-gradient(180deg,#ffffff 0%,#cbb9e8 46%,#7a6aa0 56%,#efe9fb 100%)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          textShadow: '0 1px 0 rgba(255,255,255,0.18), 0 3px 6px rgba(0,0,0,0.6)',
          animation: 'bootCreditFade 1.1s ease 1.6s both',
        }}
      >
        by
      </span>

      {/* GANTASMO — the animated logo, ~30% size, tight under "by". */}
      <img
        src="/GANTASMO_LOGO.webp"
        alt="GANTASMO"
        className="shrink-0 object-contain select-none"
        draggable={false}
        style={{ height: 'clamp(34px, 8vh, 110px)', maxWidth: '70vw', animation: 'bootCreditFade 1.3s ease 2s both' }}
      />

      {/* Real escape only after a genuine wait. */}
      {elapsed >= 40 && (
        <button
          onClick={onSkip}
          className="absolute bottom-2 right-3 text-[9px] font-mono text-zinc-700 hover:text-zinc-400 transition-colors underline"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};
