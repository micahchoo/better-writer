# Local models only; Whisper swapped for sherpa-onnx

All inference is local (carried from Elicit's ADR-0001). Buffertab ships OpenAI Whisper for dictation; that hosted dependency is removed, and dictation runs on Elicit's local sherpa-onnx Parakeet STT. No hosted API, ever.
