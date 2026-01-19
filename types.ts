
export enum VoiceName {
  ZEPHYR = 'Zephyr',
  PUCK = 'Puck',
  CHARON = 'Charon',
  KORE = 'Kore',
  FENRIR = 'Fenrir'
}

export interface TranscriptionEntry {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface SessionConfig {
  voice: VoiceName;
  systemInstruction: string;
}
