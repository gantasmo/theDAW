import React, { useState, useRef, useCallback } from 'react';

interface BpmTapperProps {
  onBpmSet: (bpm: number) => void;
  currentBpm: number;
}

export const BpmTapper: React.FC<BpmTapperProps> = ({ onBpmSet, currentBpm }) => {
  const [taps, setTaps] = useState<number[]>([]);
  const [calculatedBpm, setCalculatedBpm] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const calculateBpm = useCallback((tapTimes: number[]): number | null => {
    if (tapTimes.length < 2) return null;

    // Calculate intervals between consecutive taps
    const intervals: number[] = [];
    for (let i = 1; i < tapTimes.length; i++) {
      intervals.push(tapTimes[i] - tapTimes[i - 1]);
    }

    // Filter out outliers (too fast or too slow - outside 30-300 BPM range)
    const validIntervals = intervals.filter(interval => {
      const bpm = 60000 / interval;
      return bpm >= 30 && bpm <= 300;
    });

    if (validIntervals.length === 0) return null;

    // Calculate average interval
    const avgInterval = validIntervals.reduce((a, b) => a + b, 0) / validIntervals.length;

    // Convert to BPM
    const bpm = Math.round(60000 / avgInterval);

    return Math.max(30, Math.min(300, bpm));
  }, []);

  const handleTap = useCallback(() => {
    const now = performance.now();

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    setTaps(prevTaps => {
      // Just add the new tap (no auto-reset, user must click Reset)
      const newTaps = [...prevTaps, now];

      // Keep only last 10 taps for rolling average
      const trimmedTaps = newTaps.slice(-10);

      // Calculate BPM
      const bpm = calculateBpm(trimmedTaps);
      setCalculatedBpm(bpm);
      setIsActive(true);

      return trimmedTaps;
    });

    // Auto-pause (not reset) after 2 seconds of inactivity
    timeoutRef.current = setTimeout(() => {
      setIsActive(false);
    }, 2000);
  }, [calculateBpm]);

  const handleReset = useCallback(() => {
    setTaps([]);
    setCalculatedBpm(null);
    setIsActive(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  }, []);

  const handleApply = useCallback(() => {
    if (calculatedBpm) {
      onBpmSet(calculatedBpm);
    }
  }, [calculatedBpm, onBpmSet]);

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Tap Tempo</h3>
        {calculatedBpm && (
          <button
            onClick={handleReset}
            className="text-[10px] text-gray-500 hover:text-white transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Tap Button */}
      <button
        onClick={handleTap}
        className={`w-full h-20 rounded-lg font-bold text-lg transition-all ${
          isActive
            ? 'bg-cyan-500/20 border-2 border-cyan-400 text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.3)]'
            : 'bg-black/50 border-2 border-white/10 text-gray-400 hover:border-gray-600'
        }`}
      >
        {calculatedBpm ? (
          <span className="text-2xl">{calculatedBpm} <span className="text-sm">BPM</span></span>
        ) : (
          <span>TAP</span>
        )}
      </button>

      {/* Tap count indicator */}
      <div className="flex justify-between items-center mt-2">
        <span className="text-[10px] text-gray-500">
          {taps.length > 0 ? `${taps.length} taps` : 'Tap to start'}
        </span>
        {taps.length >= 2 && (
          <div className="flex gap-1">
            {Array.from({ length: Math.min(taps.length, 8) }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${
                  i < taps.length ? 'bg-cyan-400' : 'bg-gray-700'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Apply button */}
      {calculatedBpm && (
        <button
          onClick={handleApply}
          className="w-full mt-3 py-2 rounded-lg bg-cyan-500/20 border border-cyan-400 text-cyan-400 text-xs font-medium hover:bg-cyan-500 hover:text-black transition-all"
        >
          Set BPM to {calculatedBpm} (current: {currentBpm})
        </button>
      )}

      <p className="text-[9px] text-gray-600 mt-2 text-center">
        Tap along with your beat. Best accuracy with 4-8 taps.
      </p>
    </div>
  );
};
