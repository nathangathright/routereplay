"""Optional local accelerators with explicit selection and reproducible records."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ENGINE = Path(__file__).resolve().parent / 'engine'
if str(ENGINE) not in sys.path:
    sys.path.insert(0,str(ENGINE))


def cycles_device(blender, requested='cpu', timeout=300):
    if requested not in ('cpu', 'metal', 'auto'):
        raise ValueError('Cycles device must be cpu, metal or auto.')
    if requested == 'cpu':
        return {'backend': 'cpu', 'devices': [{'name': 'CPU', 'type': 'CPU'}]}
    from cycles_device import MARKER
    try:
        result = subprocess.run([blender, '--factory-startup', '-b', '--python-exit-code', '1',
            '--python', str(ENGINE / 'cycles_device.py'), '--', '--device', requested],
            capture_output=True, text=True, timeout=timeout, check=True)
        records = [json.loads(line[len(MARKER):]) for line in result.stdout.splitlines()
                   if line.startswith(MARKER)]
        if (len(records) != 1 or not isinstance(records[0],dict)
                or records[0].get('backend') not in ('cpu', 'metal')
                or not isinstance(records[0].get('devices'),list) or not records[0]['devices']
                or (requested == 'metal' and records[0]['backend'] != 'metal')):
            raise ValueError('Blender did not return one valid device probe result.')
        return records[0]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
        reason = (exc.stderr or exc.stdout or str(exc))[-3000:] if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        if requested == 'metal':
            raise RuntimeError('Cycles Metal probe failed. Use --cycles-device cpu to render locally. '+reason) from exc
        return {'backend': 'cpu', 'devices': [{'name': 'CPU', 'type': 'CPU'}],
                'fallback_reason': 'Metal probe failed: '+reason}


def encoding_arguments(encoder):
    if encoder == 'x264':
        return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16']
    if encoder == 'videotoolbox':
        # Apple Silicon quality scale is not CRF. Hardware is mandatory; no
        # silent software substitution can invalidate the acceleration claim.
        return ['-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-q:v', '80', '-profile:v', 'high']
    raise ValueError('Encoder must be x264 or videotoolbox.')


def probe_encoder(ffmpeg, encoder):
    arguments = encoding_arguments(encoder)
    if encoder == 'videotoolbox':
        with tempfile.TemporaryDirectory(prefix='flight-encoder-') as temporary:
            try:
                subprocess.run([ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=size=1080x1920:rate=30', '-frames:v', '1', *arguments,
                    '-pix_fmt', 'yuv420p', str(Path(temporary)/'probe.mp4')],
                    capture_output=True, text=True, check=True, timeout=30)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                reason = exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
                raise RuntimeError('Hardware VideoToolbox encoding is unavailable. Use --encoder x264. '+reason) from exc
    return {'name': encoder, 'arguments': arguments,
            'ffmpeg_version': subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0]}


def compute_device(requested='cpu', *, atmosphere_view='reference'):
    """Resolve optional Metal kernels before a render cache is chosen."""
    if requested not in ('cpu','metal','auto'):
        raise ValueError('Compute device must be cpu, metal or auto.')
    if atmosphere_view not in ('reference','batched'):
        raise ValueError('Atmosphere view must be reference or batched.')
    if requested == 'cpu':
        return {'backend':'cpu','precision':'float64'}
    try:
        from metal_compute import device_info,optical_depth
        record=device_info()
        # Force compilation/evaluation here: import success alone is insufficient.
        optical_depth([[0.,0.,1.01]],[0.,0.,1.],[.01],samples=2,
            constants=[6371.,720.,57.6,8.64,.0058/7.2,.0135/7.2,.0331/7.2,.0030/7.2/.9])
        from metal_clouds import probe
        probe()
        from metal_weather import probe as weather_probe
        weather_probe()
        if atmosphere_view == 'batched':
            from metal_atmosphere import probe as atmosphere_probe
            atmosphere_probe()
        return record
    except (ImportError,OSError,RuntimeError,ValueError) as exc:
        if requested == 'metal':
            raise RuntimeError('Optional Metal compute failed its probe. Use --compute cpu. '+str(exc)) from exc
        return {'backend':'cpu','precision':'float64','fallback_reason':str(exc)}
