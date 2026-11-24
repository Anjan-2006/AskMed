import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2, Mic, Square, X } from 'lucide-react';
import { transcribeVoice } from '../api/askmedApi';

interface ComposerProps {
  onSend: (text: string) => void;
  isSending: boolean;
  focusTrigger: string | null;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function Composer({ onSend, isSending, focusTrigger }: ComposerProps) {
  const [value, setValue] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);

  const micSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  useEffect(() => {
    resize();
  }, [value]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusTrigger]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  // Clean up media tracks if component unmounts mid-recording
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (!micSupported || isSending || isTranscribing || isRecording) return;
    setVoiceError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      cancelledRef.current = false;

      const mimeType = pickAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopTracks();
        recorderRef.current = null;
        setIsRecording(false);
        setRecordSeconds(0);

        if (cancelledRef.current) {
          chunksRef.current = [];
          return;
        }

        const blobType = mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: blobType });
        chunksRef.current = [];
        if (blob.size < 100) return;

        setIsTranscribing(true);
        try {
          const ext = blobType.includes('ogg') ? 'ogg' : blobType.includes('mp4') ? 'm4a' : 'webm';
          const { text } = await transcribeVoice(blob, `recording.${ext}`);
          if (text) {
            setValue((prev) => {
              const trimmed = prev.trimEnd();
              const combined = trimmed ? `${trimmed} ${text}` : text;
              return combined.slice(0, 1000);
            });
            window.requestAnimationFrame(() => textareaRef.current?.focus());
          } else {
            setVoiceError('No speech was detected. Try speaking a bit closer to the microphone.');
          }
        } catch (err) {
          setVoiceError(
            err instanceof Error ? err.message : 'Could not transcribe audio. Please try again.'
          );
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setRecordSeconds(0);
      setIsRecording(true);
    } catch (err) {
      stopTracks();
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setVoiceError('Microphone access was denied. Enable microphone permission in your browser settings.');
      } else if (name === 'NotFoundError') {
        setVoiceError('No microphone was found on this device.');
      } else {
        setVoiceError('Unable to start microphone recording.');
      }
    }
  };

  const stopRecording = () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    cancelledRef.current = false;
    recorderRef.current.stop();
  };

  const cancelRecording = () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') {
      stopTracks();
      setIsRecording(false);
      setRecordSeconds(0);
      return;
    }
    cancelledRef.current = true;
    recorderRef.current.stop();
  };

  const canSend = value.trim().length > 0 && !isSending && !isRecording && !isTranscribing;

  const submit = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue('');
    setVoiceError(null);
    onSend(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-dock">
      <form
        className="composer-shell"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (voiceError) setVoiceError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            isRecording
              ? 'Listening… click stop when finished'
              : isTranscribing
                ? 'Transcribing voice note…'
                : 'Ask anything…'
          }
          aria-label="Message AskMed"
          disabled={isSending || isRecording || isTranscribing}
          maxLength={1000}
        />

        {voiceError && (
          <div className="composer-voice-error" role="alert">
            <span>{voiceError}</span>
            <button
              type="button"
              className="voice-error-dismiss"
              onClick={() => setVoiceError(null)}
              aria-label="Dismiss microphone notice"
            >
              <X size={13} />
            </button>
          </div>
        )}

        <div className="composer-bar">
          {isRecording ? (
            <div className="recording-status" role="status" aria-live="polite">
              <span className="recording-dot" aria-hidden="true" />
              <span>Recording {formatDuration(recordSeconds)}</span>
            </div>
          ) : isTranscribing ? (
            <div className="recording-status" role="status" aria-live="polite">
              <Loader2 size={13} className="spinner" />
              <span>Transcribing…</span>
            </div>
          ) : (
            <span className="composer-hint">Enter to send · Shift+Enter for new line</span>
          )}

          <div className="composer-controls">
            {isRecording ? (
              <>
                <button
                  type="button"
                  className="mic-cancel-btn"
                  onClick={cancelRecording}
                  aria-label="Cancel recording"
                  title="Cancel recording"
                >
                  <X size={15} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  className="mic-stop-btn"
                  onClick={stopRecording}
                  aria-label="Stop recording and transcribe"
                  title="Stop & transcribe"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              </>
            ) : (
              micSupported && (
                <button
                  type="button"
                  className="mic-btn"
                  disabled={isSending || isTranscribing}
                  onClick={startRecording}
                  aria-label="Start voice input"
                  title="Voice input"
                >
                  {isTranscribing ? (
                    <Loader2 size={15} className="spinner" />
                  ) : (
                    <Mic size={16} strokeWidth={1.8} />
                  )}
                </button>
              )
            )}

            <button
              type="submit"
              className="send-btn"
              disabled={!canSend}
              aria-label={isSending ? 'Sending message' : 'Send message'}
              title={isSending ? 'Sending…' : 'Send message'}
            >
              {isSending ? (
                <Loader2 size={16} className="spinner" />
              ) : (
                <ArrowUp size={17} strokeWidth={2.2} />
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
