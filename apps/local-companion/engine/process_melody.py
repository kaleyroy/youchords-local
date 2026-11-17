"""
Melody extraction stage for the Jianpu (numbered notation) view.

Uses Spotify's Basic Pitch (Apache-2.0) to transcribe the dominant melodic
line into note events, then reduces them to a monophonic melody timeline so
the extension can render scale degrees (1=do 2=re ...) aligned with lyrics.

Packed payload format (mirrors the downbeat payload style in main.py):
    {"notes": "start_s.dur_ms.midi.conf,...", "engine": "basic-pitch-v1"}
Old readers ignore the new "mel"/"melv" keys; old caches simply lack them —
both sides stay v2-compatible. Failures never fail the job: any error
(including Basic Pitch not being installed) returns None.
"""

import os
import time

# Note confidence floor (Basic Pitch amplitude 0..1). Env-tunable.
MELODY_MIN_CONFIDENCE = float(
    os.environ.get("YOUCHORDS_MELODY_MIN_CONF", "0.5")
)
# Drop notes shorter than this (ms) — model jitter, not real notes.
MELODY_MIN_DURATION_MS = 40
# Same-pitch notes closer than this (ms) are one sustained note split by the model.
MELODY_MERGE_GAP_MS = 60
# Overlap tolerance (ms) below which a following note still counts as "next".
MELODY_OVERLAP_TOLERANCE_MS = 30
MELODY_ENGINE_VERSION = "basic-pitch-v1"

_predict_fn = None
_predict_unavailable = False


def _get_predict():
    """
    Lazy-import Basic Pitch inference once. Returns None (and logs a single
    line) when the package or its inference backend is unavailable.
    """
    global _predict_fn, _predict_unavailable
    if _predict_fn is not None:
        return _predict_fn
    if _predict_unavailable:
        return None
    try:
        from basic_pitch.inference import predict as basic_pitch_predict
        _predict_fn = basic_pitch_predict
    except Exception as e:
        _predict_unavailable = True
        print(f"MELODY: Basic Pitch unavailable ({e}) — melody extraction disabled")
        return None
    return _predict_fn


def _clean_note_events(note_events):
    """
    Basic Pitch note events -> cleaned [(start_s, dur_ms, midi, conf)] tuples.
    Filters by confidence/duration, merges model-split sustains.
    """
    notes = []
    for event in note_events or []:
        if not event or len(event) < 4:
            continue
        try:
            start_s, end_s, midi, amplitude = (float(event[0]), float(event[1]), int(event[2]), float(event[3]))
        except (TypeError, ValueError):
            continue
        dur_ms = int(round((end_s - start_s) * 1000))
        if amplitude < MELODY_MIN_CONFIDENCE or dur_ms < MELODY_MIN_DURATION_MS:
            continue
        if not (21 <= midi <= 108):
            continue
        notes.append((round(max(start_s, 0.0), 3), dur_ms, midi, amplitude))

    notes.sort(key=lambda note: (note[0], -note[3]))

    # Merge same-pitch fragments the model split mid-sustain.
    merged = []
    for note in notes:
        if (
            merged
            and merged[-1][2] == note[2]
            and note[0] * 1000 <= merged[-1][0] * 1000 + merged[-1][1] + MELODY_MERGE_GAP_MS
        ):
            prev = merged[-1]
            end_ms = max(prev[0] * 1000 + prev[1], note[0] * 1000 + note[1])
            merged[-1] = (prev[0], int(round(end_ms - prev[0] * 1000)), prev[2], max(prev[3], note[3]))
        else:
            merged.append(note)
    return merged


def _monophonize(notes):
    """
    Reduce (possibly polyphonic) note events to a single melody line:
    keep the loudest note of any overlapping cluster. Jianpu is monophonic.
    """
    melody = []
    for note in notes:
        if not melody:
            melody.append(note)
            continue
        prev = melody[-1]
        prev_end_ms = prev[0] * 1000 + prev[1]
        if note[0] * 1000 >= prev_end_ms - MELODY_OVERLAP_TOLERANCE_MS:
            melody.append(note)
        elif note[3] > prev[3]:
            # Louder note replaces the overlap tail of the previous one.
            melody[-1] = (prev[0], max(0, int(round(note[0] * 1000 - prev[0] * 1000))), prev[2], prev[3])
            melody.append(note)
    return [note for note in melody if note[1] >= MELODY_MIN_DURATION_MS]


def _notes_to_payload_string(notes):
    """Pack [(start_s, dur_ms, midi, conf)] into "start.dur_ms.midi.conf,..."."""
    parts = []
    for start_s, dur_ms, midi, amplitude in notes:
        parts.append(f"{start_s:.3f}.{dur_ms}.{midi}.{int(round(amplitude * 100))}")
    return ",".join(parts)


def extract_melody(wav_file):
    """
    Extract the dominant melody line with Basic Pitch.
    Returns {"notes", "engine"} or None; failures never fail the job.
    """
    started_at = time.perf_counter()
    predict = _get_predict()
    if predict is None:
        return None
    try:
        print("Extracting MELODY with Basic Pitch...")
        _model_output, _midi_data, note_events = predict(str(wav_file))
        notes = _monophonize(_clean_note_events(note_events))
        if len(notes) < 4:
            print(f"MELODY: not enough stable notes ({len(notes)}) — skipped")
            return None
        elapsed = time.perf_counter() - started_at
        print(
            f"MELODY: {len(notes)} notes extracted in {elapsed:.1f}s "
            f"(min conf {MELODY_MIN_CONFIDENCE:g})"
        )
        return {
            "notes": _notes_to_payload_string(notes),
            "engine": MELODY_ENGINE_VERSION,
        }
    except Exception as e:
        print(f"MELODY error: {e}")
        return None
