
import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  analyzer?: AnalyserNode;
  color?: string;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, analyzer, color = '#6366f1' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isActive || !analyzer || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyzer.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const barWidth = (width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * height;
        
        ctx.fillStyle = color;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
      }
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, analyzer, color]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-24 rounded-lg bg-slate-800/50"
      width={400}
      height={100}
    />
  );
};

export default AudioVisualizer;
