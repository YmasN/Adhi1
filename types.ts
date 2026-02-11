
export enum AdhiMood {
  NEUTRAL = 'NEUTRAL',
  COMPASSIONATE = 'COMPASSIONATE',
  JOYFUL = 'JOYFUL',
  WISE = 'WISE',
  INTIMATE = 'INTIMATE'
}

export type MicroExpression = 'smile' | 'concern' | 'surprise' | 'fatigue' | 'focus' | 'none';

export type AdhiVoice = 'Zephyr' | 'Kore' | 'Puck' | 'Charon' | 'Fenrir';

export interface GoalStep {
  text: string;
  completed: boolean;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  steps: GoalStep[];
  progress: number; // 0 to 100
  category: 'Skill' | 'Habit' | 'Emotional' | 'General';
}

export interface Memory {
  id: string;
  text: string;
  timestamp: Date;
  category: string;
}

export interface FileData {
  data: string; // base64
  mimeType: string;
}

export interface MessageSource {
  title: string;
  uri: string;
}

export interface Message {
  id: string;
  role: 'user' | 'adhi';
  text: string;
  mood?: AdhiMood;
  fileData?: FileData;
  timestamp: Date;
  sources?: MessageSource[];
}

export interface AdhiState {
  currentMood: AdhiMood;
  microExpression?: MicroExpression;
  isTyping: boolean;
  activeView: 'chat' | 'growth' | 'vault';
  selectedVoice: AdhiVoice;
}
