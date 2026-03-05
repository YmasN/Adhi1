
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { ADHI_SYSTEM_PROMPT } from "../constants";
import { AdhiMood, Goal, Memory, FileData, AdhiVoice, MessageSource, SpeakingPace } from "../types";

export interface AdhiResponse {
  mood: AdhiMood;
  text: string;
  userName?: string;
  insightToSave?: string;
  goalUpdate?: {
    title: string;
    suggestedStep?: string;
    progressUpdate?: number;
  };
  sources?: MessageSource[];
}

export const getAdhiResponse = async (
  message: string,
  history: any[],
  goals: Goal[],
  memories: Memory[],
  userName: string | null,
  fileData?: FileData
): Promise<AdhiResponse> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const contextPrompt = `
Current Context:
User Name: ${userName || 'Unknown'}
User Goals: ${goals.map(g => `${g.title} (${g.progress}% done)`).join(', ') || 'None yet'}
Key Memories: ${memories.map(m => m.text).slice(-5).join('; ') || 'None yet'}
`;

  const userParts: any[] = [{ text: message }];
  if (fileData) {
    userParts.push({
      inlineData: {
        data: fileData.data,
        mimeType: fileData.mimeType
      }
    });
  }

  const rawHistory = history.slice(-10);
  const validHistory: any[] = [];
  let lastRole = '';
  for (const msg of rawHistory) {
    if (msg.role !== lastRole) {
      validHistory.push({ role: msg.role, parts: [...msg.parts] });
      lastRole = msg.role;
    } else {
      validHistory[validHistory.length - 1].parts.push(...msg.parts);
    }
  }

  // If validHistory ends with 'user', and we are about to append another 'user' message, combine them
  if (validHistory.length > 0 && validHistory[validHistory.length - 1].role === 'user') {
    validHistory[validHistory.length - 1].parts.push(...userParts);
    userParts.length = 0; // Clear userParts so we don't append it again
  }

  // The Gemini API requires the first message in the contents array to be from the user.
  if (validHistory.length > 0 && validHistory[0].role === 'model') {
    validHistory.shift();
  }

  try {
    const contents = [...validHistory];
    if (userParts.length > 0) {
      contents.push({ role: 'user', parts: userParts });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview', 
      contents,
      config: {
        systemInstruction: ADHI_SYSTEM_PROMPT + "\n\n" + contextPrompt,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mood: { type: Type.STRING, enum: Object.values(AdhiMood) },
            text: { type: Type.STRING },
            userName: { type: Type.STRING, description: "The user's name if they just provided it." },
            insightToSave: { type: Type.STRING },
            goalUpdate: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                suggestedStep: { type: Type.STRING },
                progressUpdate: { type: Type.NUMBER }
              }
            }
          },
          required: ["mood", "text"]
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    
    // Extract search grounding sources
    const sources: MessageSource[] = [];
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (groundingChunks) {
      groundingChunks.forEach((chunk: any) => {
        if (chunk.web && chunk.web.uri && chunk.web.title) {
          sources.push({
            title: chunk.web.title,
            uri: chunk.web.uri
          });
        }
      });
    }

    return {
      mood: result.mood as AdhiMood || AdhiMood.NEUTRAL,
      text: result.text || "I am right here.",
      userName: result.userName,
      insightToSave: result.insightToSave,
      goalUpdate: result.goalUpdate,
      sources: sources.length > 0 ? sources : undefined
    };
  } catch (error) {
    console.error("Adhi Error:", error);
    return {
      mood: AdhiMood.COMPASSIONATE,
      text: "*reaches out gently* I am tuning my frequency to match yours. Stay with me."
    };
  }
};

export const getAdhiSpeech = async (
  text: string, 
  voiceName: AdhiVoice = 'Kore',
  pace: SpeakingPace = 'normal'
): Promise<string | undefined> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    // Remove italicized actions for speech
    const cleanText = text.replace(/\*[^*]+\*/g, '').trim();
    if (!cleanText) return undefined;

    // Direct model-driven pace instruction
    const paceInstruction = pace === 'slow' ? 'Say very slowly' : pace === 'fast' ? 'Say quickly' : 'Say at a natural pace';
    const promptedText = `${paceInstruction}: ${cleanText}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: promptedText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (error) {
    console.error("Adhi TTS Error:", error);
    return undefined;
  }
};
