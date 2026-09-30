"""Local JSON-lines speech worker. Audio and transcripts never leave this process via networking."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_XET'] = '1'
import argparse
import json
import queue
import sys
import threading
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--model', default=str(Path(__file__).parent / 'models' / 'turbo'))
parser.add_argument('--language', default='ru')
parser.add_argument('--audio-root', required=True)
args = parser.parse_args()
root = Path(args.audio_root).resolve()
jobs = queue.Queue()

# Load native extensions before starting the blocking stdin reader. On this
# Windows runtime, importing NumPy after that thread starts can deadlock.
import numpy as np
import av
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def reader():
    # A killed bridge closes stdin. Exit even if recognition is currently running in CTranslate2.
    for line in sys.stdin:
        try:
            if len(line) > 32768:
                raise ValueError()
            jobs.put(json.loads(line))
        except (ValueError, TypeError):
            emit({'type': 'error', 'code': 'speech-protocol'})
    os._exit(0)

threading.Thread(target=reader, daemon=True).start()
emit({'type': 'ready', 'protocol': 1})
model = None

class SpeechFailure(Exception):
    pass

def recognize(filename):
    global model
    source = Path(filename).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        raise SpeechFailure('speech-file-unavailable')
    if source.stat().st_size > 20 * 1024 * 1024:
        raise SpeechFailure('speech-too-large')
    try:
        with av.open(str(source)) as container:
            if container.duration is not None and container.duration / av.time_base > 600:
                raise SpeechFailure('speech-too-long')
        audio = decode_audio(str(source), sampling_rate=16000)
    except SpeechFailure:
        raise
    except Exception:
        raise SpeechFailure('speech-invalid-audio') from None
    duration = len(audio) / 16000
    if duration > 600:
        raise SpeechFailure('speech-too-long')
    if not len(audio) or np.max(np.abs(audio)) < 0.00001:
        raise SpeechFailure('speech-empty')
    if not (Path(args.model) / 'model.bin').is_file():
        raise SpeechFailure('speech-model-unavailable')
    if model is None:
        model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    segments, info = model.transcribe(audio, language=args.language, beam_size=5,
                                     vad_filter=True, condition_on_previous_text=False)
    parts = [segment for segment in segments if segment.text.strip()]
    text = ' '.join(segment.text.strip() for segment in parts).strip()
    if not text or info.duration_after_vad <= 0:
        raise SpeechFailure('speech-empty')
    weight = sum(max(0.01, p.end - p.start) for p in parts)
    confidence = sum(p.avg_logprob * max(0.01, p.end - p.start) for p in parts) / weight
    if confidence < -1.0:
        raise SpeechFailure('speech-uncertain')
    if len(text) > 50000:
        raise SpeechFailure('speech-too-long')
    return {'text': text, 'duration': round(duration, 2), 'language': info.language}

while True:
    job = jobs.get()
    request_id = job.get('id') if isinstance(job, dict) else None
    try:
        if not isinstance(request_id, str) or not isinstance(job.get('path'), str):
            raise SpeechFailure('speech-protocol')
        result = recognize(job['path'])
        emit({'type': 'result', 'id': request_id, **result})
    except SpeechFailure as error:
        emit({'type': 'error', 'id': request_id, 'code': str(error)})
    except Exception:
        emit({'type': 'error', 'id': request_id, 'code': 'speech-engine-error'})
