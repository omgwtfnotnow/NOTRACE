import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Function to generate a random 6-character alphanumeric room code
export function generateRoomCode(length: number = 6): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Function to generate a random anonymous user name
export function generateRandomName(): string {
  const adjectives = [
    'Silent', 'Hidden', 'Quiet', 'Secret', 'Ghostly', 'Unknown',
    'Shadowy', 'Lone', 'Masked', 'Mystic', 'Wandering', 'Invisible',
    'Fleeting', 'Furtive', 'Obscure', 'Veiled', 'Cryptic', 'Subtle'
    ];
  const nouns = [
    'Walker', 'Specter', 'Nomad', 'Cipher', 'Echo', 'Phantom',
    'Drifter', 'Scribe', 'Watcher', 'Whisper', 'Traveler', 'Agent',
    'Riddle', 'Void', 'Enigma', 'Shade', 'Visitor', 'Alias'
    ];

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];

  return `${adj}${noun}`;
}
