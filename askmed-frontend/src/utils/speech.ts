// Native browser Web Speech API (speechSynthesis) helper for clear, natural Read Aloud.

let cachedVoices: SpeechSynthesisVoice[] = [];
let voicesBound = false;
let activePlaybackId = 0;

export function isSpeechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  );
}

function refreshVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) cachedVoices = voices;
  return cachedVoices;
}

function ensureVoicesListener(): void {
  if (!isSpeechSupported() || voicesBound) return;
  voicesBound = true;
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  window.addEventListener('beforeunload', stopSpeaking);
}

/**
 * Score available system voices so natural/neural/high-quality voices are preferred
 * over harsh robotic fallbacks (such as espeak on Linux).
 */
function pickBestVoice(langPrefix = 'en'): SpeechSynthesisVoice | null {
  const voices = refreshVoices();
  if (!voices.length) return null;

  const target = langPrefix.toLowerCase();
  const matching = voices.filter((v) => v.lang?.toLowerCase().startsWith(target));
  const pool = matching.length ? matching : voices;

  const scoreVoice = (v: SpeechSynthesisVoice): number => {
    const name = `${v.name} ${v.voiceURI}`.toLowerCase();
    let score = 0;
    if (/natural|neural|online|enhanced|premium/.test(name)) score += 60;
    if (/google us english|google uk english|samantha|ava|allison|aria|jenny|guy|libby|serena|daniel/.test(name)) {
      score += 45;
    }
    if (/google/.test(name)) score += 25;
    if (/microsoft/.test(name)) score += 20;
    if (/apple|siri/.test(name)) score += 20;
    if (v.lang?.toLowerCase() === 'en-us' || v.lang?.toLowerCase() === 'en-gb') score += 10;
    if (v.default) score += 5;
    if (/espeak|festival|mbrola|compact|novelty|whisper|trinoids|zarvox|bad news/.test(name)) {
      score -= 80;
    }
    return score;
  };

  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

/**
 * Clean Markdown into clear, natural spoken prose:
 * - Removes fenced code blocks and inline code spans
 * - Removes inline document citation tags ([Title, p. 9]) and raw URLs
 * - Strips Markdown formatting, heading markers, tables, and decorative symbols
 * - Preserves meaningful numbers, units, and sentence punctuation
 */
export function cleanTextForSpeech(markdown: string): string {
  return markdown
    // Remove fenced code blocks completely
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove inline code spans
    .replace(/`[^`\n]+`/g, ' ')
    // Remove document citation tags like [WHO-FAO Healthy Diets Report, p. 9] or 【..., p. 9】
    .replace(/[\[【][^\[\]【】]+?,\s*p(?:ages?|p\.?|\.)\s*[0-9]+(?:\s*[-–,]\s*[0-9]+)*[\]】]/gi, '')
    // Replace Markdown links [label](url) with just the readable label
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|#[^)]+)\)/g, '$1')
    // Remove bare URLs
    .replace(/https?:\/\/\S+/gi, '')
    // Remove Markdown table separator rows
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    // Replace table pipes with pause punctuation
    .replace(/\|/g, ', ')
    // Remove heading markers and list bullets, adding a gentle pause at line ends
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+•–—]|\d+[.)])\s+/gm, '')
    // Remove emphasis/strikethrough/blockquote markers
    .replace(/[*_~>]+/g, '')
    // Remove decorative emojis / non-spoken symbols while keeping numbers, currency, %, +, -, /, punctuation
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    // Convert newlines into sentence pauses where punctuation is missing
    .replace(/([^\n.!?:;])\n+/g, '$1. ')
    .replace(/\n+/g, ' ')
    // Collapse repeated punctuation and extra whitespace
    .replace(/([.!?,;:])\1+/g, '$1')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Split cleaned text into natural sentence-sized chunks (~200 chars max) so browsers
 * never cut off long responses or sound garbled on giant single utterances.
 */
export function splitIntoSpeechChunks(text: string, maxChars = 220): string[] {
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      // Split very long sentences at commas/semicolons
      const clauses = sentence.split(/(?<=[,;:])\s+/);
      let part = '';
      for (const clause of clauses) {
        if (part && part.length + clause.length + 1 > maxChars) {
          chunks.push(part);
          part = clause;
        } else {
          part = part ? `${part} ${clause}` : clause;
        }
      }
      if (part) chunks.push(part);
      continue;
    }

    if (current && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function stopSpeaking(): void {
  activePlaybackId += 1;
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore browser speech errors.
  }
}

export function speakText(
  markdown: string,
  callbacks: { onEnd?: () => void; onError?: () => void } = {}
): boolean {
  if (!isSpeechSupported()) return false;
  ensureVoicesListener();

  const cleaned = cleanTextForSpeech(markdown);
  const chunks = splitIntoSpeechChunks(cleaned);
  if (!chunks.length) return false;

  // Cancel any previous playback cleanly and bind this session to a unique playbackId
  stopSpeaking();
  const playbackId = activePlaybackId;
  const preferredVoice = pickBestVoice('en');

  const speakChunk = (index: number) => {
    if (playbackId !== activePlaybackId) return;
    if (index >= chunks.length) {
      callbacks.onEnd?.();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang;
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = 0.96;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      if (playbackId !== activePlaybackId) return;
      speakChunk(index + 1);
    };
    utterance.onerror = (event) => {
      if (playbackId !== activePlaybackId) return;
      // Ignore normal cancellation events
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      callbacks.onError?.();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      if (playbackId === activePlaybackId) callbacks.onError?.();
    }
  };

  speakChunk(0);
  return true;
}
