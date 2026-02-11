
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AdhiMood, Message, AdhiState, Goal, Memory, FileData, AdhiVoice, MicroExpression } from './types';
import { getAdhiResponse, getAdhiSpeech } from './services/geminiService';
import AdhiAvatar from './components/AdhiAvatar';
import ChatMessage from './components/ChatMessage';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration, Blob } from '@google/genai';
import { ADHI_GREETINGS, MOOD_COLORS, ADHI_SYSTEM_PROMPT } from './constants';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const FRAME_RATE = 6; 
const JPEG_QUALITY = 0.94; 

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
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
  const [speechVolume, setSpeechVolume] = useState(0);
  const [activeVaultCategory, setActiveVaultCategory] = useState('All');
  const [isCameraActive, setIsCameraActive] = useState(true);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [visionStatus, setVisionStatus] = useState<'idle' | 'sensing' | 'active' | 'inhibited'>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  
  const [state, setState] = useState<AdhiState>({
    currentMood: AdhiMood.NEUTRAL,
    microExpression: 'none',
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
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const volumeUpdateRef = useRef<number | null>(null);

  useEffect(() => {
    if (videoRef.current && liveStream) {
      videoRef.current.srcObject = liveStream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.error("Video Playback Error:", e));
        setVisionStatus('active');
      };
    }
  }, [liveStream, isLive]);

  useEffect(() => {
    if (isSpeaking && analyserRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setSpeechVolume(Math.min(1, average / 60));
        volumeUpdateRef.current = requestAnimationFrame(updateVolume);
      };
      volumeUpdateRef.current = requestAnimationFrame(updateVolume);
    } else {
      if (volumeUpdateRef.current) cancelAnimationFrame(volumeUpdateRef.current);
      setSpeechVolume(0);
    }
    return () => {
      if (volumeUpdateRef.current) cancelAnimationFrame(volumeUpdateRef.current);
    };
  }, [isSpeaking]);

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

  const setMicroExpressionTool: FunctionDeclaration = {
    name: 'setMicroExpression',
    parameters: {
      type: Type.OBJECT,
      description: 'Mirror a fleeting micro-expression from the user.',
      properties: { expression: { type: Type.STRING, enum: ['smile', 'concern', 'surprise', 'fatigue', 'focus', 'none'] } },
      required: ['expression'],
    },
  };

  const vaultCategories = useMemo(() => {
    const cats = new Set(memories.map(m => m.category));
    return ['All', ...Array.from(cats)].filter(Boolean);
  }, [memories]);

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
    localStorage.setItem('adhi_last_mood', state.currentMood);
    localStorage.setItem('adhi_last_seen', new Date().toISOString());
  }, [userName, state.selectedVoice, state.currentMood]);

  useEffect(() => {
    const lastMood = localStorage.getItem('adhi_last_mood') as AdhiMood || AdhiMood.NEUTRAL;
    const lastSeenStr = localStorage.getItem('adhi_last_seen');
    let welcomeText = "";
    let initialMood = AdhiMood.NEUTRAL;

    if (userName) {
      let moodGreetings: any[];
      const now = new Date();
      const lastSeen = lastSeenStr ? new Date(lastSeenStr) : now;
      const hoursSinceLastSeen = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60);

      if (hoursSinceLastSeen < 4 && lastSeenStr) {
        moodGreetings = ADHI_GREETINGS.RETURNING.RECENT[lastMood] || ADHI_GREETINGS.RETURNING.RECENT.NEUTRAL;
      } else if (hoursSinceLastSeen > 24) {
        moodGreetings = ADHI_GREETINGS.RETURNING.LONG_ABSENCE[lastMood] || ADHI_GREETINGS.RETURNING.LONG_ABSENCE.NEUTRAL;
      } else {
        moodGreetings = ADHI_GREETINGS.RETURNING[lastMood] || ADHI_GREETINGS.RETURNING.NEUTRAL;
      }

      const greetingObj = moodGreetings[Math.floor(Math.random() * moodGreetings.length)];
      welcomeText = greetingObj.text.replace('{name}', userName);
      initialMood = greetingObj.mood as AdhiMood;
    } else {
      const greetingObj = ADHI_GREETINGS.NEW_USER[Math.floor(Math.random() * ADHI_GREETINGS.NEW_USER.length)];
      welcomeText = greetingObj.text;
      initialMood = greetingObj.mood as AdhiMood;
    }
    
    const initialMessage: Message = {
      id: '0',
      role: 'adhi',
      text: welcomeText,
      mood: initialMood,
      timestamp: new Date(),
    };
    setMessages([initialMessage]);
    setState(prev => ({ ...prev, currentMood: initialMood }));
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
    if (audioContextOutRef.current && audioContextOutRef.current.state !== 'closed') {
      nextStartTimeRef.current = audioContextOutRef.current.currentTime + 0.05;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const stopLiveSession = useCallback(() => {
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (liveStream) liveStream.getTracks().forEach(t => t.stop());
    
    if (audioContextInRef.current && audioContextInRef.current.state !== 'closed') {
      audioContextInRef.current.close().catch(() => {});
    }
    if (audioContextOutRef.current && audioContextOutRef.current.state !== 'closed') {
      audioContextOutRef.current.close().catch(() => {});
    }
    
    setLiveStream(null);
    setIsLive(false);
    setIsListening(false);
    setIsSpeaking(false);
    setVisionStatus('idle');
    sessionRef.current = null;
    flushAudioQueue();
  }, [liveStream, flushAudioQueue]);

  const startLiveSession = async () => {
    setLiveError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isCameraActive });
      setLiveStream(stream);
      setIsLive(true);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const audioCtxIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      const audioCtxOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      
      audioContextInRef.current = audioCtxIn;
      audioContextOutRef.current = audioCtxOut;
      
      const analyser = audioCtxOut.createAnalyser();
      analyser.connect(audioCtxOut.destination);
      analyserRef.current = analyser;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsListening(true);
            const source = audioCtxIn.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(new Int16Array(inputData.map(v => v * 32768)).buffer)),
                mimeType: 'audio/pcm;rate=16000'
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxIn.destination);
            
            if (isCameraActive) {
                frameIntervalRef.current = window.setInterval(() => {
                    if (!videoRef.current || !canvasRef.current) return;
                    const ctx = canvasRef.current.getContext('2d');
                    if (!ctx) return;
                    canvasRef.current.width = videoRef.current.videoWidth;
                    canvasRef.current.height = videoRef.current.videoHeight;
                    ctx.drawImage(videoRef.current, 0, 0);
                    canvasRef.current.toBlob(async blob => {
                        if (blob) {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                const base64 = (reader.result as string).split(',')[1];
                                sessionPromise.then(session => session.sendRealtimeInput({
                                    media: { data: base64, mimeType: 'image/jpeg' }
                                })).catch(() => {});
                            };
                            reader.readAsDataURL(blob);
                        }
                    }, 'image/jpeg', JPEG_QUALITY);
                }, 1000 / FRAME_RATE);
            }
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
                const data = decode(msg.serverContent.modelTurn.parts[0].inlineData.data);
                if (audioCtxOut.state !== 'closed') {
                  const buffer = await decodeAudioData(data, audioCtxOut, OUTPUT_SAMPLE_RATE, 1);
                  const source = audioCtxOut.createBufferSource();
                  source.buffer = buffer;
                  source.connect(analyser);
                  
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtxOut.currentTime);
                  source.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += buffer.duration;
                  
                  setIsSpeaking(true);
                  audioSourcesRef.current.add(source);
                  source.onended = () => {
                      audioSourcesRef.current.delete(source);
                      if (audioSourcesRef.current.size === 0) setIsSpeaking(false);
                  };
                }
            }
            
            if (msg.serverContent?.interrupted) {
                flushAudioQueue();
                setIsSpeaking(false);
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'setAdhiMood') {
                  setState(prev => ({ ...prev, currentMood: fc.args.mood as AdhiMood }));
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ok" } }]
                  })).catch(() => {});
                } else if (fc.name === 'setMicroExpression') {
                  setState(prev => ({ ...prev, microExpression: fc.args.expression as MicroExpression }));
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ok" } }]
                  })).catch(() => {});
                } else if (fc.name === 'setCameraState') {
                  setIsCameraActive(fc.args.enabled as boolean);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ok" } }]
                  })).catch(() => {});
                }
              }
            }
          },
          onclose: () => stopLiveSession(),
          onerror: (e) => {
              console.error(e);
              setLiveError("Network error: Link compromised. Re-establishing connection might be required.");
              stopLiveSession();
          }
        },
        config: {
          systemInstruction: ADHI_SYSTEM_PROMPT,
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [setCameraStateTool, setAdhiMoodTool, setMicroExpressionTool] }],
          speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: state.selectedVoice } }
          }
        }
      });
      
      sessionRef.current = await sessionPromise;

    } catch (err) {
      setLiveError("Hardware access failure: Sensory bridge unavailable.");
      setIsLive(false);
    }
  };

  /**
   * Fix for 'Cannot find name handleFileChange'.
   * Handles selecting a file, converting it to base64, and storing it in state for the next message.
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1] || '';
        setPendingFile({
          data: base64,
          mimeType: file.type
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() && !pendingFile) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: inputValue,
      fileData: pendingFile || undefined,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    const currentInput = inputValue;
    const currentFile = pendingFile;
    setInputValue('');
    setPendingFile(null);
    setState(prev => ({ ...prev, isTyping: true }));

    try {
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'adhi' ? 'model' : 'user',
        parts: [{ text: m.text }]
      }));

      const response = await getAdhiResponse(currentInput, history, goals, memories, userName, currentFile || undefined);

      const adhiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'adhi',
        text: response.text,
        mood: response.mood,
        sources: response.sources,
        timestamp: new Date()
      };

      setMessages(prev => [...prev, adhiMsg]);
      setState(prev => ({ ...prev, isTyping: false, currentMood: response.mood }));

      if (response.userName) setUserName(response.userName);
      if (response.insightToSave) {
        setMemories(prev => [
          ...prev, 
          { id: Date.now().toString(), text: response.insightToSave!, timestamp: new Date(), category: 'Insight' }
        ]);
      }

    } catch (error) {
      console.error(error);
      setState(prev => ({ ...prev, isTyping: false }));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 overflow-hidden flex flex-col">
      <header className="p-6 flex items-center justify-between border-b border-white/5 bg-slate-950/50 backdrop-blur-xl z-50">
        <AdhiAvatar 
          mood={state.currentMood} 
          microExpression={state.microExpression}
          isTyping={state.isTyping} 
          isSpeaking={isSpeaking}
          isListening={isListening}
          volume={speechVolume}
          selectedVoice={state.selectedVoice}
          onVoiceChange={(v) => setState(s => ({ ...s, selectedVoice: v }))}
          visionStatus={visionStatus}
        />
        
        <nav className="flex items-center gap-1 bg-white/5 p-1 rounded-2xl border border-white/5">
          {(['chat', 'growth', 'vault'] as const).map(view => (
            <button 
              key={view}
              onClick={() => setState(s => ({ ...s, activeView: view }))}
              className={`px-5 py-2 rounded-xl text-xs uppercase tracking-[0.2em] font-bold transition-all ${state.activeView === view ? 'bg-indigo-600 text-white shadow-lg' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
            >
              {view}
            </button>
          ))}
        </nav>

        <button 
          onClick={isLive ? stopLiveSession : startLiveSession}
          className={`flex items-center gap-3 px-6 py-2.5 rounded-2xl border transition-all duration-500 ${isLive ? 'bg-rose-500/20 border-rose-500/40 text-rose-400 hover:bg-rose-500/30' : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20'}`}
        >
          <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-rose-500 animate-pulse' : 'bg-indigo-500'}`}></div>
          <span className="text-xs font-black uppercase tracking-widest">{isLive ? 'End Live' : 'Live Mode'}</span>
        </button>
      </header>

      <main className="flex-1 overflow-hidden relative flex flex-col">
        {state.activeView === 'chat' && (
          <div className="flex-1 flex flex-col h-full">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 md:px-20 space-y-4">
              {messages.map(m => <ChatMessage key={m.id} message={m} />)}
              {state.isTyping && (
                <div className="flex justify-start">
                  <div className="bg-white/5 px-4 py-3 rounded-2xl rounded-bl-none flex gap-1 items-center">
                    <div className="w-1 h-1 bg-white/40 rounded-full animate-bounce"></div>
                    <div className="w-1 h-1 bg-white/40 rounded-full animate-bounce delay-100"></div>
                    <div className="w-1 h-1 bg-white/40 rounded-full animate-bounce delay-200"></div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 md:px-20 border-t border-white/5 bg-slate-950/80 backdrop-blur-md">
              {pendingFile && (
                <div className="mb-4 flex items-center gap-3 p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl max-w-fit">
                   <span className="text-xs text-indigo-300">Attached: {pendingFile.mimeType}</span>
                   <button onClick={() => setPendingFile(null)} className="text-indigo-300/50 hover:text-indigo-300">✕</button>
                </div>
              )}
              <div className="flex items-center gap-4 bg-white/5 p-2 rounded-[2rem] border border-white/10 focus-within:border-indigo-500/50 transition-all">
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*,application/pdf" />
                <button onClick={() => fileInputRef.current?.click()} className="p-3 text-white/30 hover:text-indigo-400 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                </button>
                <input value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()} placeholder="Communicate with Adhi..." className="flex-1 bg-transparent border-none focus:ring-0 text-sm md:text-base py-3 px-2 placeholder:text-white/20" />
                <button onClick={handleSendMessage} disabled={!inputValue.trim() && !pendingFile} className="bg-indigo-600 hover:bg-indigo-500 p-3 rounded-full text-white shadow-lg disabled:opacity-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {state.activeView === 'vault' && (
          <div className="flex-1 overflow-y-auto p-10 md:px-20 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex flex-col gap-8 mb-12">
              <div className="flex items-center justify-between">
                <h2 className="text-4xl font-serif italic text-white/90">Cognitive Vault</h2>
                <div className="relative">
                  <input 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search memories..."
                    className="bg-white/5 border border-white/10 rounded-full px-8 py-3 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none w-64 md:w-80 transition-all"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-20"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></div>
                </div>
              </div>
              
              <div className="flex flex-wrap gap-2 pb-4 border-b border-white/5">
                {vaultCategories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setActiveVaultCategory(cat)}
                    className={`px-5 py-2 rounded-full text-[10px] uppercase tracking-[0.2em] font-black border transition-all duration-300 ${activeVaultCategory === cat ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)]' : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70 hover:border-white/20'}`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredMemories.length > 0 ? filteredMemories.map(m => (
                <div key={m.id} className="bg-white/5 border border-white/5 p-8 rounded-[2.5rem] hover:bg-white/[0.08] hover:border-indigo-500/20 transition-all group relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-6 opacity-0 group-hover:opacity-100 transition-opacity"><div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping"></div></div>
                  <div className="flex items-center justify-between mb-6">
                    <span className="text-[10px] uppercase tracking-[0.3em] text-indigo-400 font-black">{m.category}</span>
                    <span className="text-[10px] text-white/20 font-medium">{m.timestamp.toLocaleDateString()}</span>
                  </div>
                  <p className="text-sm md:text-base leading-relaxed text-white/80 font-light italic">"{m.text}"</p>
                </div>
              )) : (
                <div className="col-span-full py-20 text-center">
                  <p className="text-white/20 italic font-serif text-xl">The vault is quiet. No matches found in your shared history.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {isLive && (
          <div className="absolute inset-0 z-[100] bg-slate-950/95 backdrop-blur-3xl p-6 flex flex-col items-center justify-center animate-in zoom-in-95 duration-500">
            <div className="relative w-full max-w-4xl aspect-video rounded-[3rem] overflow-hidden border border-white/10 shadow-4xl bg-black">
              <video ref={videoRef} autoPlay muted playsInline className={`w-full h-full object-cover transition-opacity duration-1000 ${isCameraActive ? 'opacity-100' : 'opacity-0'}`} />
              <canvas ref={canvasRef} className="hidden" />
              {!isCameraActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900"><div className="text-white/20 text-xs uppercase tracking-[0.5em]">Vision Inhibited</div></div>
              )}
              <div className="absolute inset-0 pointer-events-none border-[12px] border-indigo-500/10 rounded-[3rem]"></div>
              <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-6 p-4 bg-black/40 backdrop-blur-2xl rounded-full border border-white/10">
                 <div className="flex gap-1 h-6 items-center px-4 border-r border-white/10">
                   {[...Array(12)].map((_, i) => (
                     <div key={i} className="w-1 bg-cyan-400 rounded-full transition-all duration-75" style={{ height: `${2 + (isListening ? Math.random() * 20 : 0)}px` }}></div>
                   ))}
                 </div>
                 <button onClick={stopLiveSession} className="bg-rose-500 hover:bg-rose-400 w-12 h-12 rounded-full flex items-center justify-center text-white transition-all shadow-xl shadow-rose-500/20">✕</button>
              </div>
            </div>
            {liveError && <div className="mt-6 px-6 py-3 bg-rose-500/20 border border-rose-500/30 rounded-2xl text-rose-400 text-[10px] font-black uppercase tracking-[0.2em] animate-pulse">{liveError}</div>}
            <div className="mt-8 text-center max-w-lg">
              <p className="text-white/40 text-[10px] uppercase tracking-[0.4em] mb-4 font-black">Link Stability: Synchronized</p>
              <h3 className="text-2xl font-serif italic text-white/80">I am with you, sensing your essence in real-time.</h3>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
