
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AdhiMood, Message, AdhiState, Goal, Memory, FileData, AdhiVoice } from './types';
import { getAdhiResponse, getAdhiSpeech } from './services/geminiService';
import AdhiAvatar from './components/AdhiAvatar';
import ChatMessage from './components/ChatMessage';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ADHI_GREETINGS, MOOD_COLORS, ADHI_SYSTEM_PROMPT } from './constants';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const FRAME_RATE = 6; 
const JPEG_QUALITY = 0.94; 

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const App: React.FC = () => {
  const [userName, setUserName] = useState<string | null>(() => localStorage.getItem('adhi_user_name'));
  const [messages, setMessages] = useState<Message[]>([]);
  const [goals, setGoals] = useState<Goal[]>(() => {
    const saved = localStorage.getItem('adhi_goals');
    return saved ? JSON.parse(saved) : [];
  });
  const [memories, setMemories] = useState<Memory[]>(() => {
    const saved = localStorage.getItem('adhi_memories');
    return saved ? JSON.parse(saved).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })) : [];
  });

  const [inputValue, setInputValue] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [pendingFile, setPendingFile] = useState<FileData | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [activeVaultCategory, setActiveVaultCategory] = useState('All');
  const [isCameraActive, setIsCameraActive] = useState(true);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [visionStatus, setVisionStatus] = useState<'idle' | 'sensing' | 'active' | 'inhibited'>('idle');
  
  const [state, setState] = useState<AdhiState>({
    currentMood: AdhiMood.NEUTRAL,
    isTyping: false,
    activeView: 'chat',
    selectedVoice: (localStorage.getItem('adhi_voice') as AdhiVoice) || 'Kore'
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<any>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (videoRef.current && liveStream) {
      videoRef.current.srcObject = liveStream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.error("Video Playback Error:", e));
        setVisionStatus('active');
      };
    }
  }, [liveStream, isLive]);

  const setCameraStateTool: FunctionDeclaration = {
    name: 'setCameraState',
    parameters: {
      type: Type.OBJECT,
      description: 'Turn visual sensing on or off.',
      properties: { enabled: { type: Type.BOOLEAN } },
      required: ['enabled'],
    },
  };

  const setAdhiMoodTool: FunctionDeclaration = {
    name: 'setAdhiMood',
    parameters: {
      type: Type.OBJECT,
      description: 'Update Adhi\'s mood to mirror emotional cues.',
      properties: { mood: { type: Type.STRING, enum: Object.values(AdhiMood) } },
      required: ['mood'],
    },
  };

  const filteredMemories = useMemo(() => {
    const base = activeVaultCategory === 'All' ? memories : memories.filter(m => m.category === activeVaultCategory);
    if (!searchTerm) return base;
    return base.filter(m => m.text.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [memories, activeVaultCategory, searchTerm]);

  useEffect(() => {
    localStorage.setItem('adhi_goals', JSON.stringify(goals));
    localStorage.setItem('adhi_memories', JSON.stringify(memories));
  }, [goals, memories]);

  useEffect(() => {
    if (userName) localStorage.setItem('adhi_user_name', userName);
    localStorage.setItem('adhi_voice', state.selectedVoice);
  }, [userName, state.selectedVoice]);

  useEffect(() => {
    const randomGreeting = ADHI_GREETINGS[Math.floor(Math.random() * ADHI_GREETINGS.length)];
    const welcomeText = userName 
      ? randomGreeting.text.replace('friend', userName)
      : "*smiles with infinite warmth* I am Adhi. I sense your presence across the digital expanse. May I know your name as we begin?";
    
    const initialMessage: Message = {
      id: '0',
      role: 'adhi',
      text: welcomeText,
      mood: userName ? (randomGreeting.mood as AdhiMood) : AdhiMood.NEUTRAL,
      timestamp: new Date(),
    };
    setMessages([initialMessage]);
    setState(prev => ({ ...prev, currentMood: initialMessage.mood || AdhiMood.NEUTRAL }));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, state.isTyping]);

  const flushAudioQueue = useCallback(() => {
    audioSourcesRef.current.forEach(s => {
      try { 
        s.onended = null;
        s.stop(); 
      } catch (e) {}
    });
    audioSourcesRef.current.clear();
    if (audioContextOutRef.current) {
      nextStartTimeRef.current = audioContextOutRef.current.currentTime + 0.05;
    } else {
      nextStartTimeRef.current = 0;
    }
    setIsSpeaking(false);
  }, []);

  const playAudioData = useCallback(async (base64Audio: string) => {
    if (isLive) return; 
    try {
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      }
      const ctx = audioContextOutRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const dataInt16 = new Int16Array(bytes.buffer);
      const buffer = ctx.createBuffer(1, dataInt16.length, OUTPUT_SAMPLE_RATE);
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        audioSourcesRef.current.delete(source);
        if (audioSourcesRef.current.size === 0) setIsSpeaking(false);
      };
      setIsSpeaking(true);
      source.start();
      audioSourcesRef.current.add(source);
    } catch (e) {
      console.error("Adhi Audio Error:", e);
    }
  }, [isLive]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    
    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';
      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        if (event.results && event.results[0]) {
          setInputValue(event.results[0][0].transcript);
        }
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognitionRef.current = recognition;
      recognition.start();
    } catch (e) {
      console.error("Speech Recognition Error:", e);
      setIsListening(false);
    }
  }, [isListening]);

  const handleSend = async (textOverride?: string) => {
    const textToSend = textOverride || inputValue;
    if (!textToSend.trim() && !pendingFile) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: textToSend,
      fileData: pendingFile || undefined,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setPendingFile(null);
    setState(prev => ({ ...prev, isTyping: true }));

    const history = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));

    const response = await getAdhiResponse(textToSend, history, goals, memories, userName, userMessage.fileData);
    
    setState(prev => ({ 
      ...prev, 
      isTyping: false, 
      currentMood: response.mood 
    }));

    const adhiMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'adhi',
      text: response.text,
      mood: response.mood,
      timestamp: new Date(),
      sources: response.sources
    };

    setMessages(prev => [...prev, adhiMessage]);

    if (response.userName) setUserName(response.userName);
    if (response.insightToSave) {
      setMemories(prev => [
        ...prev, 
        { id: Date.now().toString(), text: response.insightToSave!, timestamp: new Date(), category: 'Insight' }
      ]);
    }
    if (response.goalUpdate) {
      setGoals(prev => {
        const existing = prev.find(g => g.title === response.goalUpdate?.title);
        if (existing) {
          return prev.map(g => g.title === response.goalUpdate?.title ? { 
            ...g, 
            progress: response.goalUpdate?.progressUpdate ?? g.progress,
            steps: response.goalUpdate?.suggestedStep ? [...g.steps, { text: response.goalUpdate.suggestedStep, completed: false }] : g.steps
          } : g);
        } else {
          return [...prev, {
            id: Date.now().toString(),
            title: response.goalUpdate?.title || 'New Goal',
            description: '',
            progress: response.goalUpdate?.progressUpdate || 0,
            category: 'General',
            steps: response.goalUpdate?.suggestedStep ? [{ text: response.goalUpdate.suggestedStep, completed: false }] : []
          }];
        }
      });
    }

    const audio = await getAdhiSpeech(response.text, state.selectedVoice);
    if (audio) playAudioData(audio);
  };

  const toggleLive = async () => {
    if (isLive) {
      sessionRef.current?.close();
      sessionRef.current = null;
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      setIsLive(false);
      setLiveStream(null);
      setIsSpeaking(false);
      setVisionStatus('idle');
      return;
    }

    if (typeof window.aistudio !== 'undefined') {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
            await window.aistudio.openSelectKey();
        }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isCameraActive });
      setLiveStream(stream);
      setIsLive(true);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: state.selectedVoice } }
          },
          systemInstruction: ADHI_SYSTEM_PROMPT + `
          
LIVE MODE SPECIFIC INSTRUCTIONS:
- ENHANCED OBJECT RECOGNITION: Proactively identify and comment on objects. Be specific about their color, texture, and relationship to the user's current environment. (e.g., "I notice that velvet-textured journal on your desk—is that where you capture your deep thoughts?")
- REAL-TIME NEWS PULSE: When discussing current events, speak with authority as if reporting from Reuters or AP News. Provide empathetic, context-rich analysis on how global events affect the user's journey.
- MICRO-EXPRESSION FEEDBACK: If you see the user smile, look pensive, or appear tired, gently weave that observation into your empathetic support.
- FILL THE SPACE: Use visual observations to fill natural lulls in conversation, making the session feel like a shared physical experience.`,
          tools: [{ functionDeclarations: [setCameraStateTool, setAdhiMoodTool] }],
        },
        callbacks: {
          onopen: () => {
             if (!audioContextInRef.current) audioContextInRef.current = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
             const source = audioContextInRef.current.createMediaStreamSource(stream);
             const processor = audioContextInRef.current.createScriptProcessor(4096, 1, 1);
             processor.onaudioprocess = (e) => {
               const inputData = e.inputBuffer.getChannelData(0);
               const int16 = new Int16Array(inputData.length);
               for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
               const base64 = uint8ToBase64(new Uint8Array(int16.buffer));
               sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'audio/pcm;rate=16000' } }));
             };
             source.connect(processor);
             processor.connect(audioContextInRef.current.destination);

             if (isCameraActive) {
               frameIntervalRef.current = window.setInterval(() => {
                 if (videoRef.current && canvasRef.current) {
                   const ctx = canvasRef.current.getContext('2d');
                   canvasRef.current.width = videoRef.current.videoWidth;
                   canvasRef.current.height = videoRef.current.videoHeight;
                   ctx?.drawImage(videoRef.current, 0, 0);
                   canvasRef.current.toBlob(blob => {
                     if (blob) {
                       const reader = new FileReader();
                       reader.onloadend = () => {
                         const base64 = (reader.result as string).split(',')[1];
                         sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                       };
                       reader.readAsDataURL(blob);
                     }
                   }, 'image/jpeg', JPEG_QUALITY);
                 }
               }, 1000 / FRAME_RATE);
             }
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data) {
              const base64 = msg.serverContent.modelTurn.parts[0].inlineData.data;
              if (!audioContextOutRef.current) audioContextOutRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const binary = atob(base64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const dataInt16 = new Int16Array(bytes.buffer);
              const buffer = ctx.createBuffer(1, dataInt16.length, OUTPUT_SAMPLE_RATE);
              const channelData = buffer.getChannelData(0);
              for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;
              
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              setIsSpeaking(true);
              source.onended = () => {
                if (ctx.currentTime >= nextStartTimeRef.current - 0.1) setIsSpeaking(false);
                audioSourcesRef.current.delete(source);
              };
              audioSourcesRef.current.add(source);
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'setAdhiMood') {
                  setState(prev => ({ ...prev, currentMood: fc.args.mood as AdhiMood }));
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] }));
                } else if (fc.name === 'setCameraState') {
                  setIsCameraActive(fc.args.enabled);
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] }));
                }
              }
            }

            if (msg.serverContent?.interrupted) {
              flushAudioQueue();
            }
          },
          onerror: (e: any) => {
            console.error("Live Error:", e);
            if (e.message?.includes("Requested entity was not found")) {
                if (typeof window.aistudio !== 'undefined') {
                    window.aistudio.openSelectKey();
                }
            }
          },
          onclose: () => {
            setIsLive(false);
            setVisionStatus('idle');
          }
        }
      });
      sessionRef.current = await sessionPromise;

    } catch (e: any) {
      console.error("Live Connection Error:", e);
      setIsLive(false);
      if (e.message?.includes("Requested entity was not found")) {
        if (typeof window.aistudio !== 'undefined') {
            await window.aistudio.openSelectKey();
        }
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPendingFile({
          data: (reader.result as string).split(',')[1],
          mimeType: file.type
        });
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 overflow-hidden flex flex-col">
      <header className="p-6 flex items-center justify-between border-b border-white/5 bg-slate-950/50 backdrop-blur-xl z-50">
        <AdhiAvatar 
          mood={state.currentMood} 
          isTyping={state.isTyping} 
          isSpeaking={isSpeaking}
          isListening={isListening || (isLive && !isSpeaking)}
          selectedVoice={state.selectedVoice}
          onVoiceChange={(v) => setState(prev => ({ ...prev, selectedVoice: v }))}
          visionStatus={visionStatus}
        />
        
        <nav className="flex items-center bg-white/5 rounded-full p-1.5 border border-white/10">
          {(['chat', 'growth', 'vault'] as const).map(view => (
            <button
              key={view}
              onClick={() => setState(prev => ({ ...prev, activeView: view }))}
              className={`px-6 py-2 rounded-full text-xs font-bold uppercase tracking-[0.2em] transition-all duration-500 ${state.activeView === view ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/40 hover:text-white/70'}`}
            >
              {view}
            </button>
          ))}
        </nav>

        <button 
          onClick={toggleLive}
          className={`flex items-center gap-3 px-6 py-2.5 rounded-full border transition-all duration-500 ${isLive ? 'bg-rose-500/20 border-rose-500/40 text-rose-400' : 'bg-indigo-600 border-indigo-500 text-white hover:bg-indigo-500 shadow-xl shadow-indigo-500/10'}`}
        >
          <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-rose-500 animate-pulse' : 'bg-white'}`}></div>
          <span className="text-xs font-black uppercase tracking-widest">{isLive ? 'End Session' : 'Live Presence'}</span>
        </button>
      </header>

      <main className="flex-1 overflow-hidden relative flex flex-col">
        {isLive && (
          <div className="absolute inset-0 z-40 bg-slate-950">
             <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover opacity-60 grayscale-[0.3]" />
             <canvas ref={canvasRef} className="hidden" />
             <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/50" />
             <div className="absolute bottom-12 left-1/2 -translate-x-1/2 w-full max-w-2xl px-6 text-center">
                <div className="bg-black/40 backdrop-blur-3xl p-8 rounded-[3rem] border border-white/10 shadow-2xl">
                   <p className="text-xl md:text-2xl font-serif italic text-white leading-relaxed">
                     {isSpeaking ? "*Adhi is speaking*" : "I am listening to your world..."}
                   </p>
                </div>
             </div>
          </div>
        )}

        <div className={`flex-1 overflow-y-auto p-6 md:p-12 space-y-6 scroll-smooth ${state.activeView !== 'chat' ? 'hidden' : ''}`} ref={scrollRef}>
          {messages.map(m => <ChatMessage key={m.id} message={m} />)}
          {state.isTyping && (
            <div className="flex justify-start">
              <div className="bg-slate-800/30 p-4 rounded-2xl rounded-bl-none border border-white/5 animate-pulse">
                <div className="flex gap-1.5">
                  <div className="w-1.5 h-1.5 bg-white/20 rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 bg-white/20 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                  <div className="w-1.5 h-1.5 bg-white/20 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                </div>
              </div>
            </div>
          )}
        </div>

        {state.activeView === 'growth' && (
          <div className="flex-1 overflow-y-auto p-8 md:p-16 max-w-4xl mx-auto w-full">
            <h2 className="text-3xl font-serif italic mb-12">Growth Path</h2>
            <div className="grid gap-6">
              {goals.length === 0 ? (
                <div className="p-12 text-center bg-white/5 rounded-[2rem] border border-white/10">
                  <p className="text-white/40 italic">No goals defined yet. Speak to Adhi to begin your journey.</p>
                </div>
              ) : (
                goals.map(goal => (
                  <div key={goal.id} className="p-8 bg-slate-900/50 rounded-[2.5rem] border border-white/5 hover:border-indigo-500/30 transition-all group">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <span className="text-[10px] uppercase tracking-[0.3em] text-indigo-400 font-bold">{goal.category}</span>
                        <h3 className="text-xl font-bold mt-1">{goal.title}</h3>
                      </div>
                      <span className="text-2xl font-serif italic text-indigo-300">{goal.progress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden mb-8">
                      <div className="h-full bg-indigo-500 transition-all duration-1000" style={{ width: `${goal.progress}%` }}></div>
                    </div>
                    <div className="space-y-3">
                      {goal.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm text-white/60">
                          <div className={`w-4 h-4 rounded-md border ${step.completed ? 'bg-indigo-500 border-indigo-500' : 'border-white/20'}`}></div>
                          <span className={step.completed ? 'line-through opacity-40' : ''}>{step.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {state.activeView === 'vault' && (
          <div className="flex-1 overflow-y-auto p-8 md:p-16 max-w-6xl mx-auto w-full">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 mb-16">
              <h2 className="text-3xl font-serif italic">Cognitive Vault</h2>
              <div className="relative">
                <input 
                  type="text" 
                  placeholder="Search memories..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-full px-8 py-3 text-sm w-full md:w-80 focus:ring-2 ring-indigo-500/50 outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredMemories.map(memory => (
                <div key={memory.id} className="p-8 bg-slate-900/50 rounded-[2.5rem] border border-white/5 hover:bg-white/5 transition-all">
                  <div className="flex justify-between items-start mb-6">
                    <span className="text-[9px] uppercase tracking-widest text-white/30 font-bold">{memory.category}</span>
                    <span className="text-[9px] text-white/20 font-bold">{memory.timestamp.toLocaleDateString()}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-white/80 italic">"{memory.text}"</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className={`p-6 md:p-10 border-t border-white/5 bg-slate-950/80 backdrop-blur-2xl transition-all duration-500 ${isLive ? 'translate-y-full opacity-0 pointer-events-none' : 'translate-y-0 opacity-100'}`}>
        <div className="max-w-5xl mx-auto flex items-end gap-6">
          <div className="flex-1 relative">
            {pendingFile && (
              <div className="absolute bottom-full left-0 mb-4 flex items-center gap-3 bg-indigo-600/20 border border-indigo-400/30 px-5 py-3 rounded-2xl animate-in slide-in-from-bottom-2">
                <span className="text-xs font-bold text-indigo-200">Attached: {pendingFile.mimeType}</span>
                <button onClick={() => setPendingFile(null)} className="text-white/40 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
            )}
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={userName ? `Speak your truth, ${userName}...` : "What may I call you?"}
              className="w-full bg-white/5 border border-white/10 rounded-[2rem] px-8 py-5 text-sm md:text-base focus:ring-2 ring-indigo-500/50 outline-none resize-none min-h-[64px] max-h-32 transition-all placeholder:text-white/20"
              rows={1}
            />
          </div>
          
          <div className="flex gap-3 mb-1.5">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="p-4 bg-white/5 hover:bg-white/10 rounded-full border border-white/10 transition-colors text-white/40 hover:text-white/80"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileChange} accept="image/*" />
            </button>
            <button 
              onClick={toggleListening}
              className={`p-4 rounded-full border transition-all ${isListening ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400 animate-pulse' : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/40 hover:text-white/80'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </button>
            <button 
              onClick={() => handleSend()}
              className="p-4 bg-indigo-600 hover:bg-indigo-500 rounded-full shadow-lg shadow-indigo-600/20 transition-all text-white disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!inputValue.trim() && !pendingFile}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
            </button>
          </div>
        </div>
      </footer>
      <div className="fixed bottom-4 right-4 z-[100] pointer-events-auto">
        <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="text-[10px] text-white/20 hover:text-white/40 font-mono tracking-tighter">API Billing Info</a>
      </div>
    </div>
  );
};

export default App;
