// services/transcribeService.js
// Modular Whisper speech-to-text service backed by Groq's hosted Whisper API.
import { toFile } from 'groq-sdk';
import { config, getGroq } from '../config/clients.js';

/**
 * Transcribe an uploaded audio buffer into plain text using Groq Whisper.
 */
export async function transcribeAudio({ buffer, filename = 'recording.webm', mimetype = 'audio/webm' }, deps = {}) {
  if (!buffer || !buffer.length) {
    throw Object.assign(new Error('No audio data received. Please try recording again.'), { status: 400 });
  }

  const t0 = Date.now();
  const groqClient = deps.groq || getGroq();
  const toFileFn = deps.toFile || toFile;

  const file = await toFileFn(buffer, filename, { type: mimetype });
  const result = await groqClient.audio.transcriptions.create({
    file,
    model: config.groq.whisperModel,
    response_format: 'json',
  });

  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  return {
    text,
    tookMs: Date.now() - t0,
  };
}

