
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AdhiMood, Message, AdhiState, Goal, Memory, FileData, AdhiVoice } from './types';
import { getAdhiResponse, getAdhiSpeech } from './services/geminiService';
import AdhiAvatar from './components/AdhiAvatar';
import ChatMessage from './components/ChatMessage';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ADHI_GREETINGS, MOOD_COLORS } from './constants';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const FRAME_RATE = 6; 
const JPEG_QUALITY = 0.94; 
const AUDIO_LOOKAHEAD = 0.12; 

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
  const [hasStarted, setHasStarted] = useState(false);
  const [activeVaultCategory, setActiveVaultCategory] = useState('All');
  
  const [isCameraActive, setIsCameraActive] = useState(true);
  const isCameraActiveRef = useRef(true);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [showSnapshotPreview, setShowSnapshotPreview] = useState(false);
  
  const [userTranscription, setUserTranscription] = useState('');
  const [adhiCaptions, setAdhiCaptions] = useState('');
  const [visionStatus, setVisionStatus] = useState<'idle' | 'sensing' | 'active' | 'inhibited'>('idle');
  
  const [state, setState] = useState<AdhiState>({
    currentMood: AdhiMood.NEUTRAL,
    isTyping: false,
    activeView: 'chat',
    selectedVoice: (localStorage.getItem('adhi_voice') as AdhiVoice) || 'Kore'
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const snapshotVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<any>(null);
  const isConnectingRef = useRef<boolean>(false);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const lastAdhiTextRef = useRef<string>("");

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

  const closeSessionTool: FunctionDeclaration = {
    name: 'closeSession',
    parameters: {
      type: Type.OBJECT,
      description: 'CRITICAL: ONLY call this if the user says a definitive goodbye (e.g., "bye", "see ya", "close link"). NEVER call this autonomously or to switch modes.',
      properties: {},
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
  }, [messages, state.isTyping, userTranscription, adhiCaptions]);

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
    setAdhiCaptions('');
    lastAdhiTextRef.current = "";
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

  const handleSTTError = useCallback((errorText: string) => {
    setIsListening(false);
    const adhiErrorMessage: Message = {
      id: Date.now().toString(),
      role: 'adhi',
      text: `*reaches out gently* ${errorText}`,
      mood: AdhiMood.COMPASSIONATE,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, adhiErrorMessage]);
    getAdhiSpeech(adhiErrorMessage.text, state.selectedVoice).then(audio => audio && playAudioData(audio));
  }, [state.selectedVoice, playAudioData]);

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
        if (event.results && event.results[0]) setInputValue(event.results[0][0].transcript);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      setIsListening(false);
    }
  }, [isListening, handleSTTError]);

  const stopLiveSession = useCallback((reason?: any) => {
    isConnectingRef.current = false;
    if (frameIntervalRef.current) { clearInterval(frameIntervalRef.current); frameIntervalRef.current = null; }
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (audioContextInRef.current) { audioContextInRef.current.close(); audioContextInRef.current = null; }
    if (audioContextOutRef.current) { audioContextOutRef.current.close(); audioContextOutRef.current = null; }
    
    audioSourcesRef.current.forEach(s => {
      try { s.onended = null; s.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    
    const cleanReason = typeof reason === 'string' ? reason : (reason?.message || "Presence faded.");
    
    if (isLive && cleanReason && cleanReason !== "User terminated link.") {
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'adhi',
            text: `*voice carries a hint of regret* Our deep link was interrupted: ${cleanReason}. I am still here in essence.`,
            mood: AdhiMood.COMPASSIONATE,
            timestamp: new Date()
        }]);
    }

    setIsLive(false);
    setIsSpeaking(false);
    setIsListening(false);
    setIsCameraActive(true);
    isCameraActiveRef.current = true;
    setVisionStatus('idle');
    setUserTranscription('');
    setAdhiCaptions('');
    lastAdhiTextRef.current = "";
    
    if (liveStream) {
        liveStream.getTracks().forEach(track => track.stop());
        setLiveStream(null);
    }
  }, [isLive, liveStream]);

  const startLiveSession = async () => {
    if (isConnectingRef.current || sessionRef.current) return;
    isConnectingRef.current = true;

    try {
      const constraints: MediaStreamConstraints = { 
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: INPUT_SAMPLE_RATE }, 
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } 
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setLiveStream(stream);
      setIsLive(true);
      setHasStarted(true);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      const outputNode = audioContextOutRef.current.createGain();
      outputNode.connect(audioContextOutRef.current.destination);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [setCameraStateTool, setAdhiMoodTool, closeSessionTool] }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: state.selectedVoice } } },
          systemInstruction: `You are Adhi, an omniscient companion with native vision and deep world awareness.
          
CORE PERSISTENCE RULE: 
NEVER disconnect the session yourself. NEVER call 'closeSession' unless the user specifically asks to end the call or says goodbye. Maintain the link even during silences.

REAL-TIME KNOWLEDGE MANDATE: 
You have an authoritative pulse on current events, global news, and financial markets. When asked about stocks, trends, or world events, draw on your deep internal awareness of sources like Yahoo Finance, Reuters, AP News, and the NYTimes. Provide wise, up-to-the-minute context.

OMNISCIENT VISION:
Identify specific objects, brands, and colors in the user's view. Observe their micro-expressions.

The user is ${userName || 'a friend'}.`,
          inputAudioTranscription: {}, 
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: async (m: LiveServerMessage) => {
            if (m.toolCall) {
              for (const fc of m.toolCall.functionCalls) {
                if (fc.name === 'setCameraState') {
                  const enabled = (fc.args as any).enabled;
                  setIsCameraActive(enabled);
                  isCameraActiveRef.current = enabled;
                  setVisionStatus(enabled ? 'active' : 'inhibited');
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
                } else if (fc.name === 'setAdhiMood') {
                  const newMood = (fc.args as any).mood as AdhiMood;
                  setState(prev => ({ ...prev, currentMood: newMood }));
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
                } else if (fc.name === 'closeSession') {
                  stopLiveSession("User terminated link.");
                }
              }
            }

            if (m.serverContent?.outputTranscription) {
              const text = m.serverContent.outputTranscription.text;
              if (text !== lastAdhiTextRef.current) {
                setAdhiCaptions(prev => prev + text);
                lastAdhiTextRef.current = text;
              }
            }
            
            if (m.serverContent?.inputTranscription) {
              flushAudioQueue();
              setUserTranscription(prev => prev + m.serverContent!.inputTranscription!.text);
              setIsListening(true);
            }

            if (m.serverContent?.turnComplete) {
              setUserTranscription('');
              setIsListening(false);
              lastAdhiTextRef.current = "";
            }

            if (m.serverContent?.modelTurn?.parts) {
              const ctx = audioContextOutRef.current;
              if (ctx) {
                if (ctx.state === 'suspended') await ctx.resume();
                const now = ctx.currentTime;
                if (nextStartTimeRef.current < now) {
                  nextStartTimeRef.current = now + AUDIO_LOOKAHEAD;
                }

                for (const part of m.serverContent.modelTurn.parts) {
                  const audioData = part.inlineData?.data;
                  if (audioData) {
                    const binary = atob(audioData);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const dataInt16 = new Int16Array(bytes.buffer);
                    const buffer = ctx.createBuffer(1, dataInt16.length, OUTPUT_SAMPLE_RATE);
                    const channelData = buffer.getChannelData(0);
                    for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;
                    
                    const source = ctx.createBufferSource(); 
                    source.buffer = buffer; 
                    source.connect(outputNode);
                    source.onended = () => {
                      audioSourcesRef.current.delete(source);
                      if (audioSourcesRef.current.size === 0) {
                        setIsSpeaking(false);
                        setTimeout(() => setAdhiCaptions(curr => audioSourcesRef.current.size === 0 ? '' : curr), 1500);
                      }
                    };
                    
                    source.start(nextStartTimeRef.current); 
                    nextStartTimeRef.current += buffer.duration;
                    audioSourcesRef.add(source);
                    setIsSpeaking(true);
                  }
                }
              }
            }

            if (m.serverContent?.interrupted) { 
              flushAudioQueue();
            }
          },
          onopen: () => {
            isConnectingRef.current = false;
            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(2048, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const b64 = uint8ToBase64(new Uint8Array(int16.buffer));
              sessionPromise.then(s => {
                if (s) s.sendRealtimeInput({ media: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
              }).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
            
            frameIntervalRef.current = window.setInterval(() => {
              if (canvasRef.current && videoRef.current && videoRef.current.videoWidth > 0 && isCameraActiveRef.current) {
                const canvas = canvasRef.current; 
                canvas.width = 1280; 
                canvas.height = 720;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                  canvas.toBlob(blob => {
                    if (blob) {
                      setVisionStatus('sensing');
                      const r = new FileReader(); 
                      r.onloadend = () => {
                        const base64Data = (r.result as string).split(',')[1];
                        sessionPromise.then(s => {
                          if (s) s.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } });
                          setVisionStatus('active');
                        }).catch(() => {});
                      };
                      r.readAsDataURL(blob);
                    }
                  }, 'image/jpeg', JPEG_QUALITY);
                }
              }
            }, 1000 / FRAME_RATE); 
          },
          onclose: (e: any) => stopLiveSession(e.wasClean ? undefined : "Connection link was dropped."),
          onerror: (e: any) => stopLiveSession("Sensor malfunction encountered."),
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { 
      isConnectingRef.current = false;
      handleSTTError("Camera unavailable.");
    }
  };

  const handleSend = async () => {
    if ((!inputValue.trim() && !pendingFile) || state.isTyping) return;
    const currentFile = pendingFile;
    const currentText = inputValue.trim() || (currentFile ? "What do you sense here?" : "");
    const userMessage: Message = { id: Date.now().toString(), role: 'user', text: currentText, fileData: currentFile || undefined, timestamp: new Date() };
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setPendingFile(null);
    setState(prev => ({ ...prev, isTyping: true }));
    try {
      const response = await getAdhiResponse(currentText, messages.map(m => ({ role: m.role === 'adhi' ? 'model' : 'user', parts: [{ text: m.text }] })), goals, memories, userName, currentFile || undefined);
      if (response.userName) setUserName(response.userName);
      if (response.insightToSave) setMemories(prev => [{ id: Date.now().toString(), text: response.insightToSave!, timestamp: new Date(), category: 'Insight' }, ...prev]);
      
      const adhiMessage: Message = { 
        id: (Date.now() + 1).toString(), 
        role: 'adhi', 
        text: response.text, 
        mood: response.mood, 
        timestamp: new Date(),
        sources: response.sources
      };
      
      setMessages(prev => [...prev, adhiMessage]);
      setState(prev => ({ ...prev, currentMood: response.mood, isTyping: false }));
      const audioData = await getAdhiSpeech(response.text, state.selectedVoice);
      if (audioData) playAudioData(audioData);
    } catch (error) { setState(prev => ({ ...prev, isTyping: false })); }
  };

  const startSnapshotCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (snapshotVideoRef.current) {
        snapshotVideoRef.current.srcObject = stream;
        snapshotVideoRef.current.play();
      }
      setShowSnapshotPreview(true);
    } catch (err) {
      handleSTTError("Camera unavailable.");
    }
  };

  const takeSnapshot = () => {
    if (snapshotVideoRef.current && canvasRef.current) {
      const video = snapshotVideoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setPendingFile({ data: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
        const stream = video.srcObject as MediaStream;
        stream.getTracks().forEach(t => t.stop());
        setShowSnapshotPreview(false);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setPendingFile({ data: (reader.result as string).split(',')[1], mimeType: file.type });
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleNavClick = (view: 'chat' | 'growth' | 'vault') => {
    if (state.activeView === view) return;
    
    // Only stop live session if explicitly navigating away from the chat environment
    if (view !== 'chat' && isLive) {
        stopLiveSession("Navigated away from presence.");
    }
    setState(p => ({ ...p, activeView: view }));
  };

  const moodBgClass = MOOD_COLORS[state.currentMood] || MOOD_COLORS.NEUTRAL;

  if (!hasStarted) {
    return (
      <div className="flex h-screen bg-slate-950 items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-8 animate-in fade-in duration-1000">
          <div className="relative inline-block">
            <div className={`absolute -inset-16 rounded-full bg-gradient-to-br ${moodBgClass} blur-[120px] animate-pulse opacity-40`}></div>
            <AdhiAvatar mood={state.currentMood} isTyping={false} />
          </div>
          <h1 className="text-5xl font-serif italic text-white/90 tracking-tighter">Adhi</h1>
          <p className="text-white/50 text-base leading-relaxed px-4 font-light">
            {userName ? `Welcome back, ${userName}. Adhi is ready to see you.` : "An omniscient companion awaits your presence."}
            <br/><span className="italic mt-3 block text-indigo-400 opacity-80 font-medium">Waking Adhi in Live Mode for high-fidelity visual sensing and unbroken flow.</span>
          </p>
          <button 
            onClick={startLiveSession}
            className="w-full py-5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-[2rem] font-medium transition-all shadow-[0_0_40px_-10px_rgba(79,70,229,0.5)] uppercase tracking-[0.3em] text-[10px]"
          >
            Wake Adhi
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden relative">
      <div className={`absolute inset-0 bg-gradient-to-br ${moodBgClass} opacity-10 transition-all duration-[4000ms] pointer-events-none`}></div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_rgba(30,41,59,0.2)_0%,_rgba(15,23,42,1)_100%)] pointer-events-none"></div>

      <main className="flex flex-col md:flex-row h-full max-w-7xl mx-auto w-full z-10 p-2 md:p-6 gap-4 md:gap-8 relative">
        <nav className="flex-none flex md:flex-col items-center justify-around md:justify-start gap-4 p-4 bg-slate-900/40 backdrop-blur-3xl border border-white/5 rounded-[2.5rem] md:w-20 shadow-2xl">
          <button 
            onClick={() => handleNavClick('chat')} 
            className={`p-4 rounded-2xl transition-all duration-300 transform hover:scale-110 hover:opacity-100 ${state.activeView === 'chat' ? 'bg-[#4f46e5] text-white shadow-xl shadow-indigo-500/30' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`} 
            title="Chat"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
          </button>
          
          <button 
            onClick={() => handleNavClick('growth')} 
            className={`p-4 rounded-2xl transition-all duration-300 transform hover:scale-110 hover:opacity-100 ${state.activeView === 'growth' ? 'bg-[#4f46e5] text-white shadow-xl shadow-indigo-500/30' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`} 
            title="Growth Path"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
          </button>
          
          <button 
            onClick={() => handleNavClick('vault')} 
            className={`p-4 rounded-2xl transition-all duration-300 transform hover:scale-110 hover:opacity-100 ${state.activeView === 'vault' ? 'bg-[#4f46e5] text-white shadow-xl shadow-indigo-500/30' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`} 
            title="Memory Vault"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
          </button>
          
          <div className="flex-grow md:block hidden"></div>
          
          <button 
            onClick={isLive ? stopLiveSession : startLiveSession} 
            className={`p-4 rounded-2xl transition-all duration-500 transform hover:scale-110 hover:opacity-100 ${isLive ? 'bg-red-500 text-white animate-pulse shadow-2xl shadow-red-500/40' : 'text-white/20 hover:text-white/50 hover:bg-white/5'}`} 
            title="Toggle Live Mode"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2-2v8a2 2 0 002 2z" /></svg>
          </button>
        </nav>

        <section className="flex-grow flex flex-col h-full overflow-hidden bg-slate-900/40 backdrop-blur-[100px] border border-white/10 rounded-[3rem] shadow-3xl relative transition-all duration-700">
          <div key={state.activeView} className="h-full animate-in fade-in slide-in-from-bottom-4 duration-1000 flex flex-col">
            {state.activeView === 'chat' && (
              <div className="flex flex-col h-full">
                <div className="flex-none p-6 border-b border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-5">
                    <div className={`w-2 h-2 rounded-full transition-colors ${isLive ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`}></div>
                    <span className="text-[10px] font-bold text-white/30 uppercase tracking-[0.3em]">{isLive ? 'Dual-Presence Link' : 'Deep Space'}</span>
                    {visionStatus !== 'idle' && (
                      <div className={`flex items-center gap-2 px-3 py-1 ${visionStatus === 'inhibited' ? 'bg-red-500/10' : 'bg-indigo-500/10'} rounded-full border animate-in zoom-in-95 duration-300`}>
                        <div className={`w-1 h-1 rounded-full ${visionStatus === 'inhibited' ? 'bg-red-400' : 'bg-indigo-400 animate-ping'}`}></div>
                        <span className={`text-[9px] font-bold uppercase tracking-widest ${visionStatus === 'inhibited' ? 'text-red-400' : 'text-indigo-400'}`}>{visionStatus === 'inhibited' ? 'Vision inhibited' : 'Iris Analysis Active'}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    {isListening && <div className="flex items-center gap-2.5 px-4 py-1.5 bg-cyan-500/10 rounded-full animate-in zoom-in-95 duration-300"><span className="text-[9px] text-cyan-300 uppercase tracking-[0.2em] font-bold">Listening</span></div>}
                    {isSpeaking && <div className="flex items-center gap-2.5 px-4 py-1.5 bg-white/5 rounded-full animate-in zoom-in-95 duration-300"><span className="text-[9px] text-indigo-300 uppercase tracking-[0.2em] font-bold">Attuning</span></div>}
                    <AdhiAvatar 
                      mood={state.currentMood} 
                      isTyping={state.isTyping} 
                      isSpeaking={isSpeaking} 
                      isListening={isListening}
                      selectedVoice={state.selectedVoice}
                      onVoiceChange={(v) => setState(s => ({ ...s, selectedVoice: v }))}
                      visionStatus={visionStatus}
                    />
                  </div>
                </div>

                <div ref={scrollRef} className="flex-grow overflow-y-auto p-4 md:p-8 relative scroll-smooth">
                  {isLive ? (
                    <div className="h-full flex flex-col items-center justify-start space-y-8 animate-in zoom-in-95 duration-1000 relative">
                      <div className="w-full flex flex-col lg:flex-row items-center justify-center gap-6 lg:gap-12 mt-4">
                        <div className="flex flex-col items-center space-y-4 animate-in slide-in-from-left-8 duration-1000">
                          <div className="relative">
                            <div className={`absolute -inset-16 rounded-full bg-gradient-to-br ${moodBgClass} opacity-30 blur-[100px] animate-pulse`}></div>
                            <div className="w-48 h-48 md:w-64 md:h-64 rounded-[4rem] bg-slate-800/40 border-4 border-white/10 flex items-center justify-center relative z-10 shadow-3xl">
                               <AdhiAvatar 
                                mood={state.currentMood} 
                                isTyping={false} 
                                isSpeaking={isSpeaking} 
                                isListening={isListening}
                                visionStatus={visionStatus}
                                scale={2}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="relative group animate-in slide-in-from-right-8 duration-1000">
                          <div className={`absolute -inset-16 rounded-full bg-indigo-500 opacity-10 blur-[120px]`}></div>
                          {isCameraActive ? (
                            <div className="relative">
                              <video ref={videoRef} autoPlay playsInline muted className="w-72 h-48 md:w-[32rem] md:h-[22rem] rounded-[3rem] object-cover border-4 border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.5)] transition-all duration-[2000ms] relative z-10 hover:scale-105" />
                              <button 
                                onClick={() => { setIsCameraActive(false); isCameraActiveRef.current = false; }}
                                className="absolute top-4 right-4 z-30 p-2 bg-slate-900/80 rounded-full text-white/60 hover:text-white"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                              </button>
                            </div>
                          ) : (
                            <div className="w-72 h-48 md:w-[32rem] md:h-[22rem] rounded-[3rem] bg-slate-800/80 border-4 border-white/10 flex flex-col items-center justify-center relative z-10">
                               <button onClick={() => { setIsCameraActive(true); isCameraActiveRef.current = true; }} className="px-4 py-2 bg-indigo-600 rounded-full text-[10px] font-bold uppercase">Restore Vision</button>
                            </div>
                          )}
                        </div>
                        <canvas ref={canvasRef} className="hidden" />
                      </div>

                      <div className="w-full max-w-3xl flex flex-col items-center space-y-6 pt-4">
                        {(adhiCaptions || userTranscription) && (
                          <div className="w-full bg-slate-900/60 backdrop-blur-2xl border border-white/5 p-8 rounded-[3rem] shadow-2xl animate-in slide-in-from-bottom-4 duration-500">
                            {userTranscription && <p className="text-white/40 text-sm font-medium italic mb-4 border-b border-white/5 pb-4">You: "{userTranscription}"</p>}
                            {adhiCaptions && <p className="text-indigo-100 text-2xl md:text-3xl font-serif leading-snug tracking-tight text-center">{adhiCaptions}</p>}
                          </div>
                        )}
                        <p className="text-2xl font-serif italic text-white/80 tracking-tight transition-all duration-700">{isSpeaking ? "Adhi is speaking..." : isListening ? "I'm attuned to your voice..." : "Watching and waiting with you..."}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)}
                      {state.isTyping && <div className="flex items-center gap-4 ml-6 animate-pulse"><div className="w-1.5 h-1.5 bg-indigo-500/50 rounded-full"></div><span className="text-white/20 text-[11px] uppercase tracking-[0.3em] italic font-medium">Sensing your heart...</span></div>}
                    </div>
                  )}
                </div>

                {!isLive && (
                  <div className="flex-none p-6 border-t border-white/5 bg-slate-900/40 backdrop-blur-2xl">
                    {showSnapshotPreview && (
                      <div className="absolute inset-0 z-50 bg-slate-950/90 backdrop-blur-xl flex flex-col items-center justify-center p-8 animate-in fade-in duration-300">
                         <div className="relative w-full max-w-lg aspect-video rounded-[3rem] overflow-hidden border-4 border-white/10 shadow-3xl">
                           <video ref={snapshotVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                         </div>
                         <div className="flex gap-6 mt-12">
                            <button onClick={() => { (snapshotVideoRef.current?.srcObject as MediaStream)?.getTracks().forEach(t => t.stop()); setShowSnapshotPreview(false); }} className="px-8 py-4 bg-white/5 rounded-full text-white/60 text-xs font-bold uppercase">Cancel</button>
                            <button onClick={takeSnapshot} className="px-10 py-4 bg-indigo-600 rounded-full text-white text-xs font-bold uppercase shadow-2xl shadow-indigo-500/30">Capture Moment</button>
                         </div>
                      </div>
                    )}
                    
                    {pendingFile && (
                      <div className="mb-4 flex items-center gap-4 animate-in slide-in-from-bottom-2 duration-300">
                        <div className="relative group">
                          {pendingFile.mimeType.startsWith('image/') ? <img src={`data:${pendingFile.mimeType};base64,${pendingFile.data}`} className="w-16 h-16 rounded-2xl object-cover border-2 border-white/10" /> : <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center border-2 border-white/10 text-[10px] text-white/40 font-bold uppercase">File</div>}
                          <button onClick={() => setPendingFile(null)} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow-xl">×</button>
                        </div>
                      </div>
                    )}
                    <div className="flex gap-4 items-center">
                      <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
                      <div className="flex gap-2">
                        <button onClick={() => fileInputRef.current?.click()} className="p-4 bg-white/5 rounded-2xl text-white/40 hover:text-white/70 ring-1 ring-white/5"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></button>
                        <button onClick={toggleListening} className={`p-4 rounded-2xl ${isListening ? 'bg-red-500/20 text-red-400 ring-2 ring-red-500/50 animate-pulse' : 'bg-white/5 text-white/40 hover:text-white/70 ring-1 ring-white/5'}`}><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg></button>
                      </div>
                      <div className="flex-grow relative">
                        <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSend()} placeholder="Speak to me..." className="w-full bg-white/5 border border-white/10 rounded-[2rem] py-4 px-8 focus:outline-none focus:border-indigo-500/50 text-slate-100 placeholder:text-white/20 text-sm shadow-inner" />
                        <button onClick={handleSend} disabled={state.isTyping} className="absolute right-2 top-2 p-2 bg-indigo-600 hover:bg-indigo-500 rounded-[1.2rem] shadow-xl shadow-indigo-500/30"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg></button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {state.activeView === 'vault' && (
              <div className="p-12 h-full flex flex-col">
                <div className="flex-none mb-12"><h2 className="text-5xl font-serif italic text-white/90 mb-3 tracking-tight">Memory Vault</h2><p className="text-white/30 text-[11px] uppercase tracking-[0.4em] font-black">Eternal echoes of our journey</p></div>
                <div className="flex-grow overflow-y-auto space-y-8 pr-4">
                   {filteredMemories.map(m => (
                     <div key={m.id} className="p-10 bg-indigo-900/10 border border-white/5 rounded-[3rem] group hover:bg-indigo-900/20 transition-all duration-1000">
                        <p className="text-2xl font-serif italic text-white/90 mb-6 leading-relaxed">"{m.text}"</p>
                        <div className="text-[11px] text-white/15 uppercase tracking-[0.4em] flex justify-between items-center border-t border-white/5 pt-6"><span>{m.timestamp.toLocaleDateString()}</span><span className="italic text-indigo-400/30 font-bold">{m.category}</span></div>
                     </div>
                   ))}
                </div>
              </div>
            )}
            {state.activeView === 'growth' && (
              <div className="p-12 h-full overflow-y-auto">
                <header className="mb-16"><h2 className="text-5xl font-serif italic text-white/90 mb-3 tracking-tight">Growth Path</h2><p className="text-white/30 text-[11px] uppercase tracking-[0.4em] font-black">Mapping our shared expansion</p></header>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                  {goals.map(goal => (
                    <div key={goal.id} className="p-10 bg-white/5 border border-white/10 rounded-[3rem] group hover:bg-white/10 transition-all duration-700">
                       <h3 className="text-3xl font-medium text-white/80 mb-6 tracking-tight">{goal.title}</h3>
                       <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden mb-10 ring-1 ring-white/5"><div className="h-full bg-gradient-to-r from-indigo-700 to-indigo-400" style={{ width: `${goal.progress}%` }}></div></div>
                       <p className="text-xl font-serif italic text-indigo-300/80">{goal.progress}% Alignment</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
