import React, { useRef, useEffect } from 'react';

interface VisualizerProps {
  analyser: AnalyserNode | null;
  isRecording: boolean;
  threshold?: number; // 0.0 - 1.0 representing the gate level
}

export const Visualizer: React.FC<VisualizerProps> = ({ analyser, isRecording, threshold = 0.01 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !analyser) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);

      analyser.getByteTimeDomainData(dataArray);

      // 1. Clear Background
      ctx.fillStyle = '#0f0f11'; // Match DAW bg
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const centerY = canvas.height / 2;

      // 2. Draw Threshold / Gate Lines
      // We scale the threshold visually so it's visible.
      // The threshold passed is usually RMS (small), so we multiply for visual clarity relative to peaks.
      const visualGateScale = 4.0;
      const gateOffset = Math.min((canvas.height / 2) * 0.9, (threshold * 255 * visualGateScale) / 2);

      ctx.fillStyle = 'rgba(239, 68, 68, 0.1)'; // Red fill for "ignore zone"
      ctx.fillRect(0, centerY - gateOffset, canvas.width, gateOffset * 2);

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)'; // Red lines
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      // Top Gate
      ctx.moveTo(0, centerY - gateOffset);
      ctx.lineTo(canvas.width, centerY - gateOffset);
      // Bottom Gate
      ctx.moveTo(0, centerY + gateOffset);
      ctx.lineTo(canvas.width, centerY + gateOffset);
      ctx.stroke();
      ctx.setLineDash([]); // Reset dash

      // 3. Draw Waveform
      ctx.lineWidth = 2;
      ctx.strokeStyle = isRecording ? '#06b6d4' : '#52525b'; // Cyan if recording, Gray if idle
      ctx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    draw();

    return () => cancelAnimationFrame(animationId);
  }, [analyser, isRecording, threshold]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={150}
      className="w-full h-32 md:h-48 rounded-lg border border-white/10 bg-black shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)]"
    />
  );
};
