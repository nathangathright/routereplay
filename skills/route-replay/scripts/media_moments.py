"""Bounded local media events; decoding happens once before rendering.

A moment starts at a physical instant on a selected flight and lasts a declared
number of presentation seconds. It never changes the flight/weather clocks.
Prepared PNGs contain no source metadata or audio. No network protocols are used.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import warnings

MAX_EVENTS = 64
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_PHOTO_PIXELS = 40_000_000
MAX_VIDEO_PIXELS = 4096 * 4096
MAX_VIDEO_SECONDS = 3600.
MAX_PREPARED_FRAMES = 30_000
CARD_SIZE = (860, 450)
PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
VIDEO_EXTENSIONS = {'.mp4', '.mov'}
MANIFEST_NAME = 'media-moments.json'


def _number(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label} must be finite within {low:g}..{high:g}')
    return float(value)


def _instant(value):
    if not isinstance(value, str):
        raise ValueError('Moment time must be an ISO8601 timestamp with a UTC offset')
    try:
        when = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if when.tzinfo is None or when.utcoffset() is None:
            raise ValueError()
        return when.astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise ValueError('Moment time must be an ISO8601 timestamp with a UTC offset') from exc


def _presentation(trip, when, index):
    method = getattr(trip, 'presentation_time', None)
    if method is not None:
        return float(method(when, index))
    # Invert the flight's smootherstep independently of weather/end-hold clocks.
    leg = trip.legs[index]
    fraction = (when-leg.depart).total_seconds()/(leg.arrive-leg.depart).total_seconds()
    if fraction <= 0:
        return trip.leg_intervals[index][0]
    if fraction >= 1:
        return trip.leg_intervals[index][1]
    low, high = 0., 1.
    for _ in range(60):
        mid = (low+high)/2
        progress = mid**3*(mid*(mid*6-15)+10)
        if progress < fraction:
            low = mid
        else:
            high = mid
    start, end = trip.leg_intervals[index]
    return start+(end-start)*(low+high)/2


def validate_moments(raw, trip):
    """Normalize structural fields without reading files; return a tuple of dicts."""
    if raw is None:
        return ()
    if not isinstance(raw, (list, tuple)) or len(raw) > MAX_EVENTS:
        raise ValueError(f'moments must be a list with at most {MAX_EVENTS} events')
    normalized, windows = [], []
    for index, item in enumerate(raw):
        label = f'moments[{index}]'
        if not isinstance(item, dict) or set(item)-{'flight','time','path','duration_s','kind','start_s'}:
            raise ValueError(f'{label} supports only flight, time, path, duration_s, kind and start_s')
        flight = item.get('flight')
        if type(flight) is not int or not 1 <= flight <= len(trip.legs):
            raise ValueError(f'{label}.flight must be a one-based flight number within 1..{len(trip.legs)}')
        when = _instant(item.get('time'))
        leg = trip.legs[flight-1]
        if not leg.depart <= when <= leg.arrive:
            raise ValueError(f'{label}.time must fall within flight {flight} departure and arrival')
        path = item.get('path')
        if not isinstance(path, str) or not path.strip() or '\x00' in path or '://' in path:
            raise ValueError(f'{label}.path must name a local media file, not a URL')
        suffix = Path(path).suffix.lower()
        inferred = 'photo' if suffix in PHOTO_EXTENSIONS else 'video' if suffix in VIDEO_EXTENSIONS else None
        if inferred is None:
            raise ValueError(f'{label}.path must end in jpg, jpeg, png, webp, mp4 or mov')
        kind = item.get('kind', inferred)
        if kind != inferred:
            raise ValueError(f'{label}.kind must match its supported {inferred} extension')
        duration = _number(item.get('duration_s', 2.), f'{label}.duration_s', .8, 15.)
        if kind == 'photo' and 'start_s' in item:
            raise ValueError(f'{label}.start_s applies only to a video')
        start_s = _number(item.get('start_s', 0.), f'{label}.start_s', 0., MAX_VIDEO_SECONDS)
        start = _presentation(trip, when, flight-1)
        end = start+duration
        if end > trip.duration_s+1e-9:
            raise ValueError(f'{label} ends at {end:.3f}s beyond video duration {trip.duration_s:g}s; shorten it or extend the arrival hold')
        normalized.append({'flight':flight,'time':when.isoformat().replace('+00:00','Z'),
                           'path':path,'kind':kind,'duration_s':duration,
                           **({'start_s':start_s} if kind == 'video' else {})})
        windows.append((start,end,index))
    windows.sort()
    for previous, current in zip(windows, windows[1:]):
        if current[0] < previous[1]-1e-9:
            raise ValueError(f'moments[{previous[2]}] and moments[{current[2]}] overlap in presentation time; move or shorten a moment')
    return tuple(normalized)


def plan_moments(trip):
    moments = validate_moments(getattr(trip, 'moments', None), trip)
    return [dict(item, index=index, presentation_start_s=_presentation(trip,_instant(item['time']),item['flight']-1),
                 presentation_end_s=_presentation(trip,_instant(item['time']),item['flight']-1)+item['duration_s'])
            for index,item in enumerate(moments)]


def resolve_moments(trip, trip_path):
    """Resolve relative media against the ORIGINAL trip file before caching it."""
    moments = validate_moments(getattr(trip, 'moments', None), trip)
    if not moments:
        return trip
    base = Path(trip_path).expanduser().resolve().parent
    resolved = tuple(dict(item, path=str((base/Path(item['path']).expanduser()).resolve())) for item in moments)
    return replace(trip, moments=resolved)


def _sha(path):
    result = hashlib.sha256()
    count = 0
    with Path(path).open('rb') as handle:
        for block in iter(lambda:handle.read(1024*1024), b''):
            count += len(block)
            if count > MAX_FILE_BYTES:
                raise ValueError('Moment input exceeds its 512 MiB bound while being read')
            result.update(block)
    return result.hexdigest()


def _run(command, timeout=120):
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise ValueError('Local media probe/decode exceeded its bounded time limit') from exc
    except subprocess.CalledProcessError as exc:
        raise ValueError('Local media probe/decode failed: '+(exc.stderr or '')[-1200:].strip()) from exc


@lru_cache(maxsize=4)
def _tool(name):
    path = shutil.which(name)
    if not path:
        raise ValueError(f'{name} is required to prepare local video moments')
    version = _run([path, '-version'], timeout=10).stdout.splitlines()[0]
    return path, version


@lru_cache(maxsize=64)
def _video_probe(path, digest):
    del digest  # It is the immutable cache key; never trust only a path/mtime.
    ffprobe, _ = _tool('ffprobe')
    result = json.loads(_run([ffprobe,'-v','error','-protocol_whitelist','file,pipe',
                              '-enable_drefs','0','-f','mov','-show_entries',
                              'stream=index,codec_type,width,height,duration,avg_frame_rate,nb_frames,color_transfer:stream_disposition=attached_pic:format=duration',
                              '-of','json',path],30).stdout)
    streams = [s for s in result.get('streams',[]) if s.get('codec_type') == 'video' and not s.get('disposition',{}).get('attached_pic')]
    if len(streams) != 1:
        raise ValueError('Video moment must have exactly one ordinary video stream')
    stream = streams[0]
    if stream.get('color_transfer') in ('smpte2084','arib-std-b67'):
        raise ValueError('HDR PQ/HLG video moments are unsupported; export an SDR version before importing')
    width, height = stream.get('width',0), stream.get('height',0)
    if type(width) is not int or type(height) is not int or min(width,height)<1 or max(width,height)>4096 or width*height>MAX_VIDEO_PIXELS:
        raise ValueError('Video moment dimensions must be positive and at most 4096×4096')
    try:
        duration = float(stream.get('duration',result.get('format',{}).get('duration')))
        rate = stream.get('avg_frame_rate','0/1').split('/')
        fps = float(rate[0])/float(rate[1])
    except (TypeError,ValueError,ZeroDivisionError,IndexError) as exc:
        raise ValueError('Video moment needs a finite duration and frame rate') from exc
    if not math.isfinite(duration) or not 0 < duration <= MAX_VIDEO_SECONDS or not math.isfinite(fps) or not 0 < fps <= 240:
        raise ValueError('Video moment must be bounded to at most one hour and 240 frames per second')
    if stream.get('nb_frames') not in (None,'N/A') and int(stream['nb_frames']) <= 0:
        raise ValueError('Video moment has no frames')
    return {'width':width,'height':height,'duration_s':duration,'frame_rate':fps,'stream_index':stream['index']}


def _check_photo_depth(mode):
    if mode in ('I','F') or mode.startswith('I;16'):
        raise ValueError('High-depth grayscale photos are unsupported; export an 8-bit sRGB image')


def media_identity(trip):
    """Hash local inputs and validate decode bounds; suitable for render cache keys."""
    from PIL import Image, __version__ as pillow_version
    sources = []
    for event in plan_moments(trip):
        path = Path(event['path'])
        if not path.is_absolute():
            raise ValueError('Resolve moment paths against the original trip file before building a cache')
        if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE_BYTES:
            raise ValueError(f'Moment input must be a nonempty local file of at most 512 MiB: {path}')
        digest = _sha(path)
        source = {'index':event['index'],'kind':event['kind'],'sha256':digest,'bytes':path.stat().st_size}
        if event['kind'] == 'photo':
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(path) as image:
                        if image.format not in ('JPEG','PNG','WEBP') or getattr(image,'n_frames',1) != 1:
                            raise ValueError('Photo moments require a single JPEG, PNG or WebP image')
                        _check_photo_depth(image.mode)
                        if image.width*image.height > MAX_PHOTO_PIXELS:
                            raise ValueError('Photo moment exceeds 40 million pixels')
                        source.update(width=image.width,height=image.height)
                        image.verify()
            except (OSError,Image.DecompressionBombError,Image.DecompressionBombWarning) as exc:
                raise ValueError(f'Invalid or oversized photo moment: {path}') from exc
        else:
            source.update(_video_probe(str(path),digest))
            if event['start_s']+event['duration_s'] > source['duration_s']+1e-6:
                raise ValueError(f"Moment video range {event['start_s']:g}..{event['start_s']+event['duration_s']:g}s exceeds its {source['duration_s']:g}s duration; shorten the moment or choose an earlier start_s")
        sources.append(source)
    decoders = {'Pillow':pillow_version} if sources else {}
    if any(s['kind']=='video' for s in sources):
        decoders.update({name:_tool(name)[1] for name in ('ffmpeg','ffprobe')})
    return {'schema_version':1,'sources':sources,'decoders':decoders}


def _save_photo(path, output):
    from PIL import Image, ImageCms, ImageOps
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened)
        _check_photo_depth(image.mode)
        profile = image.info.get('icc_profile')
        if profile:
            if len(profile) > 1024*1024:
                raise ValueError('Photo ICC profile exceeds 1 MiB')
            try:
                source_profile = ImageCms.ImageCmsProfile(io.BytesIO(profile))
                color_space = source_profile.profile.xcolor_space.strip().upper()
                mode = {'RGB':'RGB','GRAY':'L','CMYK':'CMYK','LAB':'LAB'}.get(color_space)
                families = {'RGB':{'RGB','RGBA','P','PA','L','LA','1'},
                            'GRAY':{'L','LA','1'},'CMYK':{'CMYK'},'LAB':{'LAB'}}
                if mode is None or image.mode not in families[color_space]:
                    raise ValueError('ICC color space does not match image samples')
                # Expand indexed/gray RGB-profile inputs before LittleCMS, but
                # retain CMYK samples for a CMYK profile. Alpha is not a color.
                alpha = (image.convert('RGBA').getchannel('A')
                         if 'A' in image.getbands() or 'transparency' in image.info else None)
                image = ImageCms.profileToProfile(image.convert(mode),source_profile,
                                                 ImageCms.createProfile('sRGB'),outputMode='RGB').convert('RGBA')
                if alpha is not None:
                    image.putalpha(alpha)
            except (OSError,ValueError,ImageCms.PyCMSError) as exc:
                raise ValueError('Photo has an invalid or unsupported ICC profile; export it as sRGB') from exc
        else:
            image = image.convert('RGBA')
        image.thumbnail(CARD_SIZE,Image.Resampling.LANCZOS)
        # Construct a fresh image to discard EXIF, ICC and other private metadata.
        clean = Image.new('RGBA',image.size)
        clean.paste(image)
        clean.save(output,format='PNG')


def _valid(work, record):
    if not isinstance(record,dict) or not isinstance(record.get('path'),str):
        return False
    path = (work/record['path']).resolve()
    return path.is_relative_to(work) and path.is_file() and _sha(path) == record.get('sha256')


def _record(work, path):
    return {'path':path.relative_to(work).as_posix(),'sha256':_sha(path)}


def _first_tick(start, fps):
    """First tick satisfying the same division predicate used for selection."""
    first = max(0,math.ceil(start*fps))
    while first > 0 and start <= (first-1)/fps:
        first -= 1
    while first/fps < start:
        first += 1
    return first


def prepare_moments(trip, work, frames=None, expected_identity=None):
    """Prepare only selected presentation ticks, merging valid cached outputs.

    Fixed video seek/filter origins make a frame identical whether requested
    alone, shuffled or in a complete render. Decode is bounded to the event clip.
    """
    work = Path(work).resolve()
    events = plan_moments(trip)
    identity = media_identity(trip)
    if expected_identity is not None and identity != expected_identity:
        raise ValueError('Moment input or decoder changed since render cache identity was computed; configure a fresh cache')
    if frames is None:
        ticks = range(trip.frame_count)
    else:
        ticks = list(frames)
        if any(type(t) is not int or not 0 <= t < trip.frame_count for t in ticks):
            raise ValueError('Media preparation frames must be integer ticks within the video')
    ticks = sorted(set(ticks))
    selections = [[tick for tick in ticks if event['presentation_start_s'] <= tick/trip.fps < event['presentation_end_s']] for event in events]
    if sum(map(len,selections)) > MAX_PREPARED_FRAMES:
        raise ValueError(f'Media preparation exceeds {MAX_PREPARED_FRAMES} selected frames; use fewer or shorter moments')
    key = hashlib.sha256(json.dumps({'identity':identity,'events':events,'fps':trip.fps},sort_keys=True,separators=(',',':')).encode()).hexdigest()
    destination = work/'media'/key[:20]
    manifest_path = work/MANIFEST_NAME
    previous = {}
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text())
        except (ValueError,OSError):
            previous = {}
    if previous.get('key') != key:
        previous = {}
    old_events = {event['index']:event for event in previous.get('events',[])}
    prepared = []
    destination.mkdir(parents=True,exist_ok=True)
    for event, selected, source in zip(events,selections,identity['sources']):
        output = dict(event, frames={})
        old = old_events.get(event['index'],{})
        if event['kind'] == 'photo':
            photo = old.get('photo')
            if not _valid(work,photo):
                photo = None
            if selected and photo is None:
                target = destination/f"{event['index']:03d}-photo.png"
                _save_photo(event['path'],target)
                photo = _record(work,target)
            output['photo'] = photo
        else:
            output['frames'] = {tick:record for tick,record in old.get('frames',{}).items() if _valid(work,record)}
            missing = [tick for tick in selected if str(tick) not in output['frames']]
            if missing:
                first = _first_tick(event['presentation_start_s'],trip.fps)
                seek = event['start_s']+first/trip.fps-event['presentation_start_s']
                choose = '+'.join(f'eq(n\\,{tick-first})' for tick in missing)
                # Use display aspect ratio, including non-square source pixels.
                scale = "scale=w='max(1,trunc(min(860,450*dar)))':h='max(1,trunc(min(450,860/dar)))':flags=lanczos,setsar=1"
                filters = f'fps=fps={trip.fps}:start_time=0:round=up,select={choose},{scale}'
                with tempfile.TemporaryDirectory(prefix='decode-',dir=destination) as tmp:
                    command = [_tool('ffmpeg')[0],'-nostdin','-v','error','-xerror','-threads','1',
                               '-protocol_whitelist','file,pipe','-enable_drefs','0','-ss',f'{seek:.9f}','-f','mov','-i',event['path'],
                               '-map',f"0:{source['stream_index']}",'-an','-sn','-dn','-t',f'{(max(missing)-first+2)/trip.fps:.9f}',
                               '-vf',filters,'-fps_mode','vfr','-frames:v',str(len(missing)),
                               '-threads','1','-y',str(Path(tmp)/'%06d.png')]
                    _run(command,timeout=120)
                    decoded = sorted(Path(tmp).glob('*.png'))
                    if len(decoded) != len(missing):
                        raise ValueError('Video ended before all requested moment frames could be decoded')
                    for tick,path in zip(missing,decoded):
                        target = destination/f"{event['index']:03d}-{tick:06d}.png"
                        path.replace(target)
                        output['frames'][str(tick)] = _record(work,target)
        prepared.append(output)
    # Refuse a mixed snapshot if an input changes while it is being decoded.
    for event,source in zip(events,identity['sources']):
        if _sha(event['path']) != source['sha256']:
            raise ValueError('Moment input changed during preparation; retry with stable local files')
    manifest = {'schema_version':1,'key':key,'fps':trip.fps,'identity':identity,'events':prepared,
                'audio':'discarded','fit':'contain','card_size':list(CARD_SIZE)}
    temporary = work/(MANIFEST_NAME+'.tmp')
    temporary.write_text(json.dumps(manifest,indent=2,allow_nan=False)+'\n')
    temporary.replace(manifest_path)
    return manifest
