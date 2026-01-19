
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { VoiceName, TranscriptionEntry } from './types';
import { decodeBase64, decodeAudioData, createPCMBlob } from './services/audioUtils';
import { persistence, AppData } from './services/persistence';
import AudioVisualizer from './components/AudioVisualizer';
import TranscriptionList from './components/TranscriptionList';

const App: React.FC = () => {
  // Navigation & UI State
  const [activeTab, setActiveTab] = useState<'home' | 'academic' | 'students' | 'faculty' | 'notices' | 'attendance' | 'polls'>('home');
  const [isAdmin, setIsAdmin] = useState(false);
  const [showForm, setShowForm] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'error' | 'idle'>('idle');

  // Unified Data State
  const [data, setData] = useState<AppData>({
    routine: [],
    students: [],
    faculty: [],
    notices: [],
    attendance: [],
    polls: [],
    courses: []
  });

  // Load Initial Data
  useEffect(() => {
    const loadInitialData = async () => {
      setSyncStatus('syncing');
      const loadedData = await persistence.load();
      if (loadedData) {
        setData(loadedData);
        setSyncStatus('synced');
      } else {
        setSyncStatus('error');
      }
    };
    loadInitialData();
  }, []);

  // Sync Data to Server whenever it changes
  const lastSavedData = useRef<string>("");
  useEffect(() => {
    const currentDataStr = JSON.stringify(data);
    if (currentDataStr === lastSavedData.current || (data.routine.length === 0 && data.students.length === 0 && data.notices.length === 0)) return;
    
    const timer = setTimeout(async () => {
      setSyncStatus('syncing');
      const success = await persistence.save(data);
      if (success) {
        setSyncStatus('synced');
        lastSavedData.current = currentDataStr;
      } else {
        setSyncStatus('error');
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [data]);

  // Voice Assistant Logic
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'listening' | 'speaking'>('idle');
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');

  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const audioNodesRef = useRef<{ inputNode: GainNode; outputNode: GainNode; analyzer: AnalyserNode; sources: Set<AudioBufferSourceNode> } | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);

  const stopAllAudio = useCallback(() => {
    if (audioNodesRef.current) {
      audioNodesRef.current.sources.forEach(s => { try { s.stop(); } catch(e) {} });
      audioNodesRef.current.sources.clear();
    }
    nextStartTimeRef.current = 0;
  }, []);

  const stopVoiceSession = useCallback(() => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    stopAllAudio();
    setIsConnected(false);
    setIsConnecting(false);
    setStatus('idle');
  }, [stopAllAudio]);

  const startVoiceSession = async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const analyzer = inputCtx.createAnalyser();
      audioContextsRef.current = { input: inputCtx, output: outputCtx };
      audioNodesRef.current = { inputNode: inputCtx.createGain(), outputNode: outputCtx.createGain(), analyzer, sources: new Set<AudioBufferSourceNode>() };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsConnected(true); setIsConnecting(false); setStatus('listening');
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createPCMBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(analyzer); source.connect(scriptProcessor); scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.outputTranscription) { setCurrentOutput(prev => prev + msg.serverContent!.outputTranscription!.text); setStatus('speaking'); }
            else if (msg.serverContent?.inputTranscription) { setCurrentInput(prev => prev + msg.serverContent!.inputTranscription!.text); setStatus('listening'); }
            if (msg.serverContent?.turnComplete) {
              setTranscriptions(prev => [...prev, { id: Date.now().toString() + '-in', role: 'user', text: currentInput, timestamp: Date.now() }, { id: Date.now().toString() + '-out', role: 'model', text: currentOutput, timestamp: Date.now() }]);
              setCurrentInput(''); setCurrentOutput('');
            }
            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextsRef.current && audioNodesRef.current) {
              const { output: outputCtx } = audioContextsRef.current;
              const { outputNode, sources } = audioNodesRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decodeBase64(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              outputNode.connect(outputCtx.destination);
              source.addEventListener('ended', () => { sources.delete(source); if (sources.size === 0) setStatus('idle'); });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sources.add(source);
            }
            if (msg.serverContent?.interrupted) stopAllAudio();
          },
          onerror: () => stopVoiceSession(),
          onclose: () => stopVoiceSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are EEE-Voice, UU EEE Assistant. Data: ${JSON.stringify(data)}`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VoiceName.ZEPHYR } } },
          inputAudioTranscription: {}, outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { setIsConnecting(false); }
  };

  // Admin Actions
  const handleAddItem = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const type = showForm;
    const newData = { ...data };
    if (type === 'home' || type === 'routine') { newData.routine = [...newData.routine, { day: formData.get('day'), sub: formData.get('sub'), room: formData.get('room') }]; }
    else if (type === 'students') { newData.students = [...newData.students, { name: formData.get('name'), id: formData.get('id'), dip: formData.get('dip'), phone: formData.get('phone') }]; }
    else if (type === 'faculty') { newData.faculty = [...newData.faculty, { name: formData.get('name'), post: formData.get('post'), phone: formData.get('phone') }]; }
    else if (type === 'notices') { newData.notices = [...newData.notices, { title: formData.get('title'), desc: formData.get('desc'), date: new Date().toLocaleDateString() }]; }
    else if (type === 'academic') { newData.courses = [...newData.courses, { name: formData.get('name'), code: formData.get('code'), progress: 0, status: 'Ongoing' }]; }
    else if (type === 'polls') { const opts = (formData.get('options') as string).split(',').map(o => ({ text: o.trim(), votes: 0 })); newData.polls = [...newData.polls, { question: formData.get('question'), options: opts }]; }
    setData(newData);
    setShowForm(null);
  };

  const handleRemoveItem = (category: keyof AppData, index: number) => {
    const newData = { ...data };
    newData[category] = (newData[category] as any[]).filter((_, i) => i !== index);
    setData(newData);
  };

  const menuItems = [
    { id: 'home', icon: 'house', label: 'Dashboard' },
    { id: 'academic', icon: 'book-open', label: 'Academic' },
    { id: 'students', icon: 'user-group', label: 'Students' },
    { id: 'faculty', icon: 'chalkboard-teacher', label: 'Faculty' },
    { id: 'notices', icon: 'bullhorn', label: 'Notices' },
    { id: 'attendance', icon: 'calendar-check', label: 'Attendance' },
    { id: 'polls', icon: 'square-poll-vertical', label: 'Polls' },
  ];

  return (
    <div className="min-h-screen bg-[#0f2027] text-slate-200 font-sans flex overflow-hidden">
      {showForm && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-white/10 w-full max-w-md rounded-[2.5rem] overflow-hidden shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b border-white/5 flex justify-between items-center bg-white/5">
              <h3 className="text-white font-black uppercase text-xs tracking-widest">Add {showForm}</h3>
              <button onClick={() => setShowForm(null)} className="text-white/40 hover:text-white"><i className="fas fa-times"></i></button>
            </div>
            <form onSubmit={handleAddItem} className="p-8 space-y-4">
              {(showForm === 'home' || showForm === 'routine') && (
                <><input name="day" placeholder="Day & Time" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="sub" placeholder="Subject Name" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="room" placeholder="Room No." required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              {showForm === 'students' && (
                <><input name="name" placeholder="Full Name" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="id" placeholder="Student ID" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="dip" placeholder="Diploma Session" className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              {showForm === 'faculty' && (
                <><input name="name" placeholder="Teacher Name" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="post" placeholder="Designation" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              {showForm === 'notices' && (
                <><input name="title" placeholder="Notice Title" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <textarea name="desc" placeholder="Details..." required rows={4} className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              {showForm === 'academic' && (
                <><input name="name" placeholder="Course Name" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="code" placeholder="Course Code" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              {showForm === 'polls' && (
                <><input name="question" placeholder="Poll Question?" required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" />
                <input name="options" placeholder="Option 1, Option 2, ..." required className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-sm outline-none focus:border-amber-500" /></>
              )}
              <button type="submit" className="w-full py-4 bg-amber-500 text-[#0f2027] font-black rounded-2xl shadow-xl shadow-amber-500/20">SAVE RECORD</button>
            </form>
          </div>
        </div>
      )}

      {isSidebarOpen && <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] md:hidden" onClick={() => setIsSidebarOpen(false)} />}

      {/* Sidebar */}
      <div className={`fixed inset-y-0 left-0 w-64 bg-slate-900/95 border-r border-white/5 flex flex-col p-4 z-[70] transform transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:translate-x-0 md:bg-slate-900/50`}>
        <div className="mb-8 flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center shadow-lg shadow-amber-500/20"><i className="fas fa-bolt text-[#0f2027]"></i></div>
            <span className="font-black tracking-tighter text-xl text-white">UU <span className="text-amber-500">EEE</span></span>
          </div>
          <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-white/40"><i className="fas fa-times"></i></button>
        </div>
        <nav className="flex-1 space-y-1">
          {menuItems.map(item => (
            <button key={item.id} onClick={() => { setActiveTab(item.id as any); setIsSidebarOpen(false); }} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-bold ${activeTab === item.id ? 'bg-amber-500 text-[#0f2027]' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
              <i className={`fas fa-${item.icon} w-5`}></i>{item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto pt-4 border-t border-white/5 space-y-2">
          <button onClick={() => setIsAdmin(!isAdmin)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest ${isAdmin ? 'bg-amber-500/10 text-amber-400' : 'text-white/20 hover:text-white'}`}><i className={`fas fa-${isAdmin ? 'lock-open' : 'lock'}`}></i>{isAdmin ? 'Admin Mode Active' : 'Admin Login'}</button>
          <div className="flex items-center gap-2 px-4 py-2 opacity-40">
            <div className={`w-2 h-2 rounded-full ${syncStatus === 'synced' ? 'bg-green-500' : syncStatus === 'syncing' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'}`}></div>
            <span className="text-[8px] font-black uppercase tracking-widest">{syncStatus}</span>
          </div>
        </div>
      </div>

      {/* Main Container */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-4 md:px-8 bg-[#0f2027]/80 backdrop-blur-xl z-10 shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white"><i className="fas fa-bars"></i></button>
            <div>
              <h1 className="text-xl md:text-2xl font-black text-white capitalize">{activeTab}</h1>
              <p className="hidden md:block text-[10px] text-white/30 font-bold uppercase tracking-widest">EEE Batch 2026 • Uttara University</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             {isAdmin && activeTab !== 'attendance' && (
               <button onClick={() => setShowForm(activeTab)} className="px-4 py-2 bg-amber-500 text-[#0f2027] rounded-lg text-[10px] font-black uppercase tracking-widest shadow-lg shadow-amber-500/20 active:scale-95 transition-transform">
                 <i className="fas fa-plus md:mr-2"></i><span className="hidden md:inline">Add Record</span>
               </button>
             )}
          </div>
        </header>

        {/* Dynamic Content */}
        <div className="flex-1 p-4 md:p-8 overflow-y-auto custom-scrollbar pb-32">
          {activeTab === 'home' && (
            <div className="space-y-8 max-w-5xl animate-in slide-in-from-bottom-4 duration-500">
              <section className="space-y-4">
                <h2 className="font-black text-white text-sm uppercase flex items-center gap-2 px-1"><span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span> LATEST BULLETIN</h2>
                <div className="flex gap-4 overflow-x-auto no-scrollbar pb-4 snap-x">
                  {data.notices.length > 0 ? data.notices.slice().reverse().map((n: any, i: number) => (
                    <div key={i} className="min-w-[280px] md:min-w-[320px] snap-center bg-slate-900 border border-white/5 rounded-[2.5rem] p-8 shadow-xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-amber-500/10 to-transparent rounded-bl-[5rem] -mr-8 -mt-8"></div>
                      <div className="flex items-center gap-2 mb-4">
                        <span className="bg-amber-500 text-[#0f2027] text-[9px] font-black px-3 py-1 rounded-full uppercase">{n.date}</span>
                        {isAdmin && <button onClick={() => handleRemoveItem('notices', data.notices.length - 1 - i)} className="ml-auto text-white/10 hover:text-rose-500 transition-colors"><i className="fas fa-trash-alt text-xs"></i></button>}
                      </div>
                      <h3 className="text-xl font-black text-white leading-tight mb-3 group-hover:text-amber-500 transition-colors">{n.title}</h3>
                      <p className="text-slate-400 text-xs line-clamp-3 font-medium leading-relaxed">{n.desc}</p>
                    </div>
                  )) : <div className="w-full bg-slate-900/50 rounded-[2.5rem] p-12 text-center text-slate-500 italic text-xs border border-white/5">No notices to display.</div>}
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="font-black text-white text-sm uppercase px-1">📅 CLASS SCHEDULE</h2>
                <div className="bg-slate-900/50 rounded-[2.5rem] border border-white/5 overflow-hidden shadow-2xl">
                  <table className="w-full text-sm">
                    <thead className="bg-white/5 text-amber-500">
                      <tr><th className="p-5 text-left font-black uppercase text-[10px] tracking-widest">Time</th><th className="p-5 text-left font-black uppercase text-[10px] tracking-widest">Subject</th><th className="p-5 text-left font-black uppercase text-[10px] tracking-widest">Room</th>{isAdmin && <th className="p-5 w-10"></th>}</tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.routine.map((item: any, idx: number) => (
                        <tr key={idx} className="hover:bg-white/5 transition-colors">
                          <td className="p-5 font-black text-white">{item.day}</td>
                          <td className="p-5 font-bold text-slate-400">{item.sub}</td>
                          <td className="p-5"><span className="bg-amber-500/10 text-amber-500 px-4 py-1.5 rounded-xl text-[10px] font-black border border-amber-500/20">{item.room}</span></td>
                          {isAdmin && <td className="p-5 text-right"><button onClick={() => handleRemoveItem('routine', idx)} className="text-white/10 hover:text-rose-500"><i className="fas fa-trash-alt"></i></button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'academic' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl">
               {data.courses.map((c: any, i: number) => (
                 <div key={i} className="bg-slate-900 p-8 rounded-[2.5rem] border border-white/5 shadow-xl space-y-4">
                    <div className="flex justify-between items-start">
                       <div><h3 className="font-black text-white text-xl">{c.name}</h3><p className="text-[10px] text-amber-500 font-black uppercase tracking-widest">{c.code}</p></div>
                       {isAdmin && <button onClick={() => handleRemoveItem('courses', i)} className="text-white/10 hover:text-rose-500"><i className="fas fa-trash-alt"></i></button>}
                    </div>
                    <div className="space-y-2">
                       <div className="flex justify-between text-[10px] font-black text-white/40 uppercase"><span>Progress</span><span>{c.progress}%</span></div>
                       <div className="h-2 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${c.progress}%` }}></div></div>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'students' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl">
               {data.students.map((s: any, i: number) => (
                 <div key={i} className="bg-slate-900 p-6 rounded-[2rem] border border-white/5 flex items-center justify-between group">
                    <div className="flex items-center gap-4">
                       <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-amber-500 font-black">{s.name.charAt(0)}</div>
                       <div><h4 className="font-black text-white">{s.name}</h4><p className="text-[10px] text-white/30 uppercase font-bold">ID: {s.id} • {s.dip}</p></div>
                    </div>
                    {isAdmin && <button onClick={() => handleRemoveItem('students', i)} className="text-white/10 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"><i className="fas fa-user-minus"></i></button>}
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'faculty' && (
            <div className="space-y-4 max-w-5xl">
               {data.faculty.map((f: any, i: number) => (
                 <div key={i} className="bg-slate-900 p-8 rounded-[2.5rem] border border-white/5 flex justify-between items-center">
                    <div className="flex items-center gap-6">
                       <div className="w-16 h-16 rounded-[1.5rem] bg-amber-500 text-[#0f2027] flex items-center justify-center text-2xl shadow-xl shadow-amber-500/10"><i className="fas fa-user-tie"></i></div>
                       <div><h3 className="text-2xl font-black text-white">{f.name}</h3><p className="text-amber-500 text-[10px] font-black uppercase tracking-[0.3em]">{f.post}</p><p className="text-white/40 text-xs mt-2 font-bold"><i className="fas fa-phone mr-2"></i>{f.phone}</p></div>
                    </div>
                    {isAdmin && <button onClick={() => handleRemoveItem('faculty', i)} className="text-white/10 hover:text-rose-500"><i className="fas fa-trash-alt"></i></button>}
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'notices' && (
            <div className="space-y-6 max-w-4xl">
               {data.notices.slice().reverse().map((n: any, i: number) => (
                 <div key={i} className="bg-slate-900 p-10 rounded-[3rem] border border-white/5 relative group">
                    <span className="absolute top-8 right-10 text-[10px] font-black text-white/20 uppercase tracking-widest">{n.date}</span>
                    <h2 className="text-3xl font-black text-white mb-6 pr-20">{n.title}</h2>
                    <div className="bg-white/5 p-8 rounded-[2rem] text-slate-400 text-sm leading-relaxed border border-white/5">{n.desc}</div>
                    {isAdmin && <button onClick={() => handleRemoveItem('notices', data.notices.length - 1 - i)} className="mt-6 text-rose-500/50 hover:text-rose-500 text-xs font-black uppercase tracking-widest flex items-center gap-2"><i className="fas fa-trash-alt"></i> Remove Post</button>}
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'polls' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl">
               {data.polls.map((p: any, i: number) => (
                 <div key={i} className="bg-slate-900 p-8 rounded-[2.5rem] border border-white/5 space-y-6">
                    <div className="flex justify-between items-start">
                       <h3 className="text-xl font-black text-white">{p.question}</h3>
                       {isAdmin && <button onClick={() => handleRemoveItem('polls', i)} className="text-white/20 hover:text-rose-500"><i className="fas fa-trash"></i></button>}
                    </div>
                    <div className="space-y-3">
                       {p.options.map((opt: any, oi: number) => (
                         <div key={oi} className="bg-white/5 p-4 rounded-2xl border border-white/5 flex justify-between items-center hover:bg-white/10 transition-colors cursor-pointer group/opt">
                            <span className="font-bold text-slate-300">{opt.text}</span>
                            <span className="text-xs font-black text-amber-500">{opt.votes} votes</span>
                         </div>
                       ))}
                    </div>
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'attendance' && (
            <div className="max-w-4xl space-y-4">
               <div className="p-12 text-center text-white/10 font-black uppercase tracking-[0.5em] border-2 border-dashed border-white/5 rounded-[3rem]">Attendance Dashboard Coming Soon</div>
            </div>
          )}
        </div>

        {/* Voice Assistant Panel */}
        <div className={`absolute right-4 md:right-8 top-24 bottom-6 w-[calc(100%-2rem)] md:w-80 bg-slate-900/95 border border-white/10 rounded-[2.5rem] backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-500 z-50 ${isConnected ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0 pointer-events-none'}`}>
          <div className="p-5 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3"><div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div><span className="text-[10px] font-black uppercase tracking-widest text-white">EEE-Voice</span></div>
            <button onClick={stopVoiceSession} className="text-white/20 hover:text-white"><i className="fas fa-times"></i></button>
          </div>
          <div className="flex-1 p-5 overflow-hidden">
            <TranscriptionList entries={transcriptions} currentInput={currentInput} currentOutput={currentOutput} />
          </div>
          <div className="p-5 bg-black/40 space-y-4">
            {isConnected && <AudioVisualizer isActive analyzer={audioNodesRef.current?.analyzer} color={status === 'speaking' ? '#f59e0b' : '#6366f1'} />}
            <div className="flex items-center gap-3">
              <input type="text" placeholder="Message EEE-Voice..." value={textInput} onChange={(e) => setTextInput(e.target.value)} className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-xs outline-none focus:border-amber-500/50" />
              <button className="w-10 h-10 rounded-xl bg-amber-500 text-[#0f2027] flex items-center justify-center shadow-lg"><i className="fas fa-paper-plane"></i></button>
            </div>
          </div>
        </div>

        {!isConnected && (
          <button onClick={startVoiceSession} disabled={isConnecting} className="fixed bottom-8 right-8 w-16 h-16 rounded-full bg-amber-500 text-[#0f2027] shadow-2xl shadow-amber-500/40 flex items-center justify-center animate-bounce z-40">
            {isConnecting ? <i className="fas fa-circle-notch fa-spin text-xl"></i> : <i className="fas fa-microphone text-xl"></i>}
          </button>
        )}
      </main>

      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes bounce { 0%, 100% { transform: translateY(-5%); } 50% { transform: translateY(0); } }
        .animate-bounce { animation: bounce 2s infinite ease-in-out; }
      `}</style>
    </div>
  );
};

export default App;
