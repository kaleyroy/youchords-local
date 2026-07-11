import os
import subprocess
from pathlib import Path

# Get the directory where this script is located
APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Paths relative to app directory
TEMP_DIR = os.path.join(APP_DIR, "temp")
TARGET_WAV_SAMPLE_RATE = int(os.environ.get("TARGET_WAV_SAMPLE_RATE", "22050"))

def convert_to_wav(input_file):
    """
    Converts an audio file to WAV format.
    """
    input_path = Path(input_file)
    output_file = Path(TEMP_DIR) / f"{input_path.stem}_converted.wav"
    
    cmd = [
        'ffmpeg',
        '-i', str(input_path),
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', str(TARGET_WAV_SAMPLE_RATE),
        # Mono cuts I/O and RAM usage roughly in half for downstream steps.
        '-ac', '1',
        str(output_file),
        '-y'
    ]
    
    print(f"\nConverting file: {input_path.name} -> {output_file.name}")
    
    subprocess.run(cmd, check=True)
    
    print(f"Conversion completed successfully: {output_file}")
    return str(output_file)
