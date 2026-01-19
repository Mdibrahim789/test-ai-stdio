
import React, { useEffect, useRef } from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionListProps {
  entries: TranscriptionEntry[];
  currentInput: string;
  currentOutput: string;
}

const TranscriptionList: React.FC<TranscriptionListProps> = ({ entries, currentInput, currentOutput }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever content changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [entries, currentInput, currentOutput]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex items-center gap-2 mb-3 text-white/40 text-[10px] font-bold uppercase tracking-widest px-1">
        <i className="fas fa-comment-dots"></i>
        <span>Conversation History</span>
      </div>
      
      <div 
        ref={scrollRef} 
        className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar overscroll-contain touch-pan-y"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {entries.map((entry) => (
          <div 
            key={entry.id}
            className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
          >
            <div className={`max-w-[90%] p-3 rounded-2xl text-xs font-medium leading-relaxed ${
              entry.role === 'user' 
                ? 'bg-amber-500 text-[#0f2027] rounded-tr-none shadow-sm' 
                : 'bg-white/10 text-slate-200 rounded-tl-none border border-white/5'
            }`}>
              {entry.text}
            </div>
            <span className="text-[9px] text-white/30 mt-1 font-bold px-1">
              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}

        {/* Real-time feedback for active turns */}
        {currentInput && (
          <div className="flex flex-col items-end opacity-60">
            <div className="max-w-[90%] p-3 rounded-2xl bg-amber-500/50 text-[#0f2027] rounded-tr-none text-xs font-medium border border-amber-400/20">
              {currentInput}
            </div>
          </div>
        )}

        {currentOutput && (
          <div className="flex flex-col items-start opacity-90">
            <div className="max-w-[90%] p-3 rounded-2xl bg-white/5 text-slate-300 rounded-tl-none text-xs font-medium border border-white/10">
              {currentOutput}
            </div>
          </div>
        )}

        {entries.length === 0 && !currentInput && !currentOutput && (
          <div className="h-full flex flex-col items-center justify-center text-white/20 italic space-y-3">
            <div className="w-12 h-12 rounded-full border border-white/5 flex items-center justify-center">
               <i className="fas fa-microphone-lines text-xl opacity-20"></i>
            </div>
            <p className="text-[10px] font-black uppercase tracking-widest">Awaiting Input...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default TranscriptionList;
