import { useState, useRef, useCallback } from "react";
import { transcribeAudio } from "../connection/supabase-client";

interface UseSTTReturn {
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  transcript: string | null;
  error: string | null;
}

export function useSTT(): UseSTTReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setIsTranscribing(true);
        try {
          const result = await transcribeAudio(blob, "recording.webm");
          setTranscript(result.text);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed.");
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      setError("Microphone access denied.");
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  }, []);

  return { startRecording, stopRecording, isRecording, isTranscribing, transcript, error };
}
