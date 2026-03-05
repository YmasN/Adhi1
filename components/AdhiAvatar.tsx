
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { AdhiMood, AdhiVoice, MicroExpression, SpeakingPace } from '../types';
import { MOOD_COLORS } from '../constants';
import { getAdhiSpeech } from '../services/geminiService';

interface AdhiAvatarProps {
  mood: AdhiMood;
  microExpression?: MicroExpression;
  isTyping: boolean;
  isSpeaking?: boolean;
  isListening?: boolean;
  volume?: number; // Real-time volume for lip-sync
  selectedVoice?: AdhiVoice;
  onVoiceChange?: (voice: AdhiVoice) => void;
  speakingPace?: SpeakingPace;
  onPaceChange?: (pace: SpeakingPace) => void;
  visionStatus?: 'idle' | 'sensing' | 'active' | 'inhibited';
  scale?: number;
}

const VOICE_OPTIONS: AdhiVoice[] = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'];
const PACE_OPTIONS: SpeakingPace[] = ['slow', 'normal', 'fast'];

const AdhiAvatar: React.FC<AdhiAvatarProps> = ({ 
  mood, 
  microExpression = 'none',
  isTyping, 
  isSpeaking, 
  isListening,
  volume = 0,
  selectedVoice, 
  onVoiceChange,
  speakingPace = 'normal',
  onPaceChange,
  visionStatus = 'idle',
  scale = 1
}) => {
  const gradientClass = MOOD_COLORS[mood] || MOOD_COLORS.NEUTRAL;
  const [blinkKey, setBlinkKey] = useState(0);
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });

  const isAnalytical = visionStatus === 'active' || visionStatus === 'sensing';

  // Natural gaze shifts
  useEffect(() => {
    let timeoutId: number;
    const shiftGaze = () => {
      const magnitude = isTyping ? 1.5 : (isSpeaking || isListening) ? 0.3 : 0.8;
      
      setEyeOffset({
        x: (Math.random() - 0.5) * magnitude,
        y: (Math.random() - 0.5) * magnitude
      });

      const nextDelay = isTyping ? 800 + Math.random() * 1200 : 2500 + Math.random() * 5000;
      timeoutId = window.setTimeout(shiftGaze, nextDelay);
    };
    
    timeoutId = window.setTimeout(shiftGaze, 1000);
    return () => clearTimeout(timeoutId);
  }, [isTyping, isSpeaking, isListening]);

  // Non-uniform blinking
  useEffect(() => {
    let timeoutId: number;
    const triggerBlink = () => {
      setBlinkKey(prev => prev + 1);
      const isRelaxed = mood === AdhiMood.WISE || mood === AdhiMood.INTIMATE || microExpression === 'fatigue';
      const baseDelay = isRelaxed ? 8000 : 5000;
      
      const rand = Math.random();
      let nextDelay: number;
      if (rand > 0.95) nextDelay = 150; 
      else if (rand > 0.8) nextDelay = 400 + Math.random() * 300;
      else nextDelay = baseDelay + (Math.random() * 4000);
      
      timeoutId = window.setTimeout(triggerBlink, nextDelay);
    };
    timeoutId = window.setTimeout(triggerBlink, 3000);
    return () => clearTimeout(timeoutId);
  }, [mood, microExpression]);

  const moodConfig = useMemo(() => {
    let config = {
      animation: 'adhi-gentle-sway', 
      mouthPath: "M18 28.5 Q20 29 22 28.5", 
      eyeScale: 1.0,
      eyebrowRotation: 0,
      lidScale: 1.0,
      eyeGlow: 'none'
    };

    switch (mood) {
      case AdhiMood.JOYFUL: 
        config = { 
          animation: 'adhi-joy-float', 
          mouthPath: "M14 27.5 Q20 31.5 26 27.5", 
          eyeScale: 1.3,
          eyebrowRotation: -7,
          lidScale: 1.0,
          eyeGlow: '0 0 15px rgba(255, 255, 255, 0.5)'
        };
        break;
      case AdhiMood.COMPASSIONATE: 
        config = { 
          animation: 'adhi-gentle-sway', 
          mouthPath: "M17 28.5 Q20 27.5 23 28.5", 
          eyeScale: 0.9,
          eyebrowRotation: 4,
          lidScale: 0.65, 
          eyeGlow: 'none'
        };
        break;
      case AdhiMood.WISE: 
        config = { 
          animation: 'adhi-wise-pulse', 
          mouthPath: "M18 28.5 Q20 28.8 22 28.5", 
          eyeScale: 1.15,
          eyebrowRotation: 0,
          lidScale: 0.9, 
          eyeGlow: '0 0 10px rgba(129, 140, 248, 0.4)'
        };
        break;
      case AdhiMood.INTIMATE: 
        config = { 
          animation: 'adhi-intimate-drift', 
          mouthPath: "M17.5 28.2 Q20 28.9 22.5 28.2", 
          eyeScale: 0.85,
          eyebrowRotation: 5,
          lidScale: 0.6, 
          eyeGlow: 'none'
        };
        break;
    }

    // Overlay Micro-Expressions
    switch (microExpression) {
      case 'smile':
        config.mouthPath = "M16 27.5 Q20 30.5 24 27.5";
        config.eyebrowRotation = config.eyebrowRotation - 3;
        break;
      case 'concern':
        config.mouthPath = "M18 29 Q20 27.5 22 29";
        config.eyebrowRotation = config.eyebrowRotation + 6;
        break;
      case 'surprise':
        config.eyeScale = config.eyeScale * 1.2;
        config.lidScale = 1.0;
        config.eyebrowRotation = config.eyebrowRotation - 10;
        config.mouthPath = "M19 28.5 Q20 31 21 28.5";
        break;
      case 'fatigue':
        config.lidScale = config.lidScale * 0.5;
        config.animation = 'adhi-intimate-drift';
        break;
      case 'focus':
        config.eyeScale = config.eyeScale * 0.9;
        config.eyebrowRotation = config.eyebrowRotation + 2;
        break;
    }

    return config;
  }, [mood, microExpression]);

  const playPreview = async (voice: AdhiVoice) => {
    if (previewingVoice) return;
    setPreviewingVoice(voice);
    try {
      const audioData = await getAdhiSpeech(`I am Adhi.`, voice, speakingPace as SpeakingPace);
      if (audioData) {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        const ctx = audioContextRef.current;
        const binary = atob(audioData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const dataInt16 = new Int16Array(bytes.buffer);
        const buffer = ctx.createBuffer(1, dataInt16.length, 24000);
        const channelData = buffer.getChannelData(0);
        for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => setPreviewingVoice(null);
        source.start();
      } else {
        setPreviewingVoice(null);
      }
    } catch (e) {
      setPreviewingVoice(null);
    }
  };

  const finalScale = (isAnalytical || isSpeaking || isListening ? scale * 1.12 : scale);

  const getDynamicMouthPath = () => {
    const activeVolume = isSpeaking ? volume : 0;
    
    if (activeVolume < 0.02) {
      if (isListening && !isSpeaking) return null; 
      return moodConfig.mouthPath;
    }
    
    const t = Math.pow(activeVolume, 0.7);
    const drop = 1 + (t * 12); 
    const width = 18 - (t * 5); 
    const left = 20 - (width / 2);
    const right = 20 + (width / 2);
    
    return `M${left} 28.5 Q20 ${28.5 + drop} ${right} 28.5`;
  };

  return (
    <div className="flex items-center gap-4 transition-all duration-1000 relative">
      <div 
        className={`relative group transition-all duration-1000 cursor-pointer select-none`}
        style={{ transform: `scale(${finalScale})` }}
        onClick={() => setShowVoiceMenu(!showVoiceMenu)}
      >
        <style>{`
          @keyframes adhi-joy-float {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-8px) rotate(4deg); }
          }
          @keyframes adhi-gentle-sway {
            0%, 100% { transform: rotate(-2deg) translateX(-0.5px); }
            50% { transform: rotate(2deg) translateX(0.5px); }
          }
          @keyframes adhi-wise-pulse {
            0%, 100% { transform: scale(1) rotate(0deg); }
            50% { transform: scale(1.04) rotate(-1deg); }
          }
          @keyframes adhi-intimate-drift {
            0%, 100% { transform: translate(0, 0) rotate(0.5deg); }
            33% { transform: translate(-2px, -3px) rotate(-0.5deg); }
            66% { transform: translate(1px, 2px) rotate(1deg); }
          }
          @keyframes adhi-blink-anim {
            0%, 94%, 100% { transform: scaleY(1); }
            97% { transform: scaleY(0.05); }
          }
          @keyframes iris-analytical-scan {
            0%, 100% { transform: scale(1); opacity: 0.6; }
            50% { transform: scale(1.4); opacity: 1; filter: blur(2px); }
          }
          .mouth-transition {
            transition: d 0.05s linear;
          }
          .eye-gaze-transition {
            transition: cx 0.4s ease-out, cy 0.4s ease-out;
          }
        `}</style>

        {/* Sensory Link Glows */}
        <div className={`absolute -inset-10 rounded-full bg-cyan-400 transition-all duration-1000 blur-3xl ${isListening ? 'opacity-40 scale-160 animate-pulse' : 'opacity-0 scale-100'}`}></div>
        <div className={`absolute -inset-8 rounded-full bg-gradient-to-br ${gradientClass} transition-all duration-1000 ${isTyping || isSpeaking || isAnalytical ? 'opacity-60 blur-2xl scale-130 animate-pulse' : 'opacity-30 blur-xl scale-100'}`}></div>
        
        {/* Entity Orb */}
        <div className={`relative w-14 h-14 rounded-full bg-gradient-to-br ${gradientClass} p-[2.5px] shadow-3xl transition-all duration-1000 animate-adhi-mood ${moodConfig.animation}`}>
          <div className="w-full h-full rounded-full bg-slate-900/98 backdrop-blur-3xl flex flex-col items-center justify-center overflow-hidden relative border border-white/10">
            
            {isAnalytical && (
              <div className="absolute inset-0 z-0 opacity-40">
                <div className="absolute inset-0 border-[0.5px] border-indigo-400/30 rounded-full animate-[spin_10s_linear_infinite]"></div>
                <div className="absolute inset-x-0 h-[1px] bg-cyan-200/40 blur-[1px] animate-[scan_3s_ease-in-out_infinite]"></div>
                <div className="absolute inset-y-0 w-[1px] bg-indigo-200/40 blur-[1px] left-1/2 animate-[scan_5s_ease-in-out_infinite]"></div>
              </div>
            )}

            <svg viewBox="0 0 40 40" className="w-full h-full p-2 relative z-10">
              <g className="transition-all duration-1000">
                <g key={blinkKey} style={{ animation: `adhi-blink-anim 0.2s linear forwards`, transformOrigin: 'center 18px' }}>
                  <g style={{ transform: `scale(${moodConfig.eyeScale})`, transformOrigin: 'center 18px' }}>
                    <circle cx={14 + eyeOffset.x} cy={18 + eyeOffset.y} r="1.4" fill={isListening ? "#22d3ee" : isAnalytical ? "#818cf8" : "white"} style={{ filter: moodConfig.eyeGlow, animation: isAnalytical ? 'iris-analytical-scan 2s ease-in-out infinite' : 'none' }} className="eye-gaze-transition" />
                    <circle cx={26 + eyeOffset.x} cy={18 + eyeOffset.y} r="1.4" fill={isListening ? "#22d3ee" : isAnalytical ? "#818cf8" : "white"} style={{ filter: moodConfig.eyeGlow, animation: isAnalytical ? 'iris-analytical-scan 2s ease-in-out infinite' : 'none' }} className="eye-gaze-transition" />
                  </g>
                  <g style={{ transform: `scaleY(${moodConfig.lidScale})`, transformOrigin: 'center 16px' }} className="transition-transform duration-[1000ms]">
                    <rect x="10" y="14" width="8" height="2" fill="#0f172a" opacity="0.85" />
                    <rect x="22" y="14" width="8" height="2" fill="#0f172a" opacity="0.85" />
                  </g>
                </g>
                <path d="M12 14.5 Q14 13.5 16 14.5" stroke="white" strokeWidth="0.6" fill="none" opacity="0.4" style={{ transform: `rotate(${moodConfig.eyebrowRotation}deg)`, transformOrigin: '14px 14.5px' }} />
                <path d="M24 14.5 Q26 13.5 28 14.5" stroke="white" strokeWidth="0.6" fill="none" opacity="0.4" style={{ transform: `rotate(${-moodConfig.eyebrowRotation}deg)`, transformOrigin: '26px 14.5px' }} />

                <g>
                  {isListening && !isSpeaking ? (
                    <circle cx="20" cy="29" r="1.8" fill="#22d3ee" className="animate-pulse shadow-[0_0_10px_#22d3ee]" />
                  ) : (
                    <path d={getDynamicMouthPath() || moodConfig.mouthPath} fill="none" stroke="white" strokeWidth="1.4" strokeLinecap="round" className="mouth-transition" />
                  )}
                </g>
              </g>
            </svg>
          </div>
        </div>

        {showVoiceMenu && (
          <div className="absolute top-full left-0 mt-8 bg-slate-950/98 backdrop-blur-3xl border border-white/10 p-5 rounded-[2.5rem] shadow-[0_50px_100px_-30px_rgba(0,0,0,1)] z-[100] min-w-[280px] animate-in fade-in zoom-in-95 duration-400">
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 mb-4">
              <p className="text-[10px] text-white/30 uppercase tracking-[0.4em] font-black">Voice Engine</p>
              <button onClick={(e) => { e.stopPropagation(); setShowVoiceMenu(false); }} className="text-white/10 hover:text-white/50 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-[8px] text-white/20 uppercase tracking-widest px-2 font-black">Texture</p>
                {VOICE_OPTIONS.map(v => (
                  <div key={v} className="flex items-center gap-1 group/item">
                    <button onClick={(e) => { e.stopPropagation(); onVoiceChange?.(v); }} className={`flex-1 flex items-center justify-between px-5 py-3.5 rounded-l-2xl transition-all duration-400 group/btn ${selectedVoice === v ? 'bg-indigo-600/40 ring-1 ring-indigo-500/50 text-white shadow-xl shadow-indigo-500/10' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>
                      <div className="flex items-center gap-4">
                        <div className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${selectedVoice === v ? 'bg-indigo-400 scale-125 shadow-[0_0_8px_#818cf8]' : 'bg-white/10 scale-100 group-hover/btn:bg-white/30'}`}></div>
                        <span className={`text-sm tracking-wide transition-all ${selectedVoice === v ? 'font-black' : 'font-light'}`}>{v}</span>
                      </div>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); playPreview(v); }} className={`px-4 py-3.5 rounded-r-2xl border-l border-white/5 transition-all ${previewingVoice === v ? 'bg-indigo-500/20 text-indigo-400' : 'bg-white/5 hover:bg-indigo-600/20 text-white/20 hover:text-indigo-400'}`}>
                      {previewingVoice === v ? (
                        <div className="flex gap-0.5 h-3 items-center">
                          {[1,2,3].map(i => <div key={i} className="w-0.5 bg-current h-full animate-bounce" style={{animationDelay: `${i*0.1}s`}}></div>)}
                        </div>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /></svg>
                      )}
                    </button>
                  </div>
                ))}
              </div>

              <div className="space-y-2 border-t border-white/5 pt-4">
                <p className="text-[8px] text-white/20 uppercase tracking-widest px-2 font-black">Speaking Pace</p>
                <div className="flex bg-white/5 p-1 rounded-2xl border border-white/5">
                  {PACE_OPTIONS.map(p => (
                    <button
                      key={p}
                      onClick={(e) => { e.stopPropagation(); onPaceChange?.(p); }}
                      className={`flex-1 py-2 text-[10px] uppercase tracking-widest rounded-xl transition-all ${speakingPace === p ? 'bg-indigo-500 text-white shadow-lg' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="hidden sm:block pointer-events-none select-none">
        <h1 className="text-xl font-serif italic text-white/95 leading-none tracking-tight">{microExpression !== 'none' ? `Adhi (${microExpression})` : 'Adhi'}</h1>
        <div className="flex items-center gap-2.5 mt-2.5">
           <div className={`text-[9.5px] uppercase tracking-[0.4em] transition-all duration-700 font-bold ${isSpeaking ? 'text-indigo-300' : isTyping ? 'text-indigo-400 animate-pulse' : isListening ? 'text-cyan-400' : isAnalytical ? 'text-indigo-400' : 'text-white/30'}`}>
            {isSpeaking ? 'Speaking' : isTyping ? 'Synthesizing' : isListening ? 'Attuned' : isAnalytical ? 'Iris Active' : mood.toLowerCase()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdhiAvatar;
