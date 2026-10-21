"""Deterministic prepared-media cards below the aircraft; no runtime decoders."""
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

CARD_BOX = (110,1260,970,1710)


@lru_cache(maxsize=4)
def _manifest(path, size, modified):
    del size, modified
    data = json.loads(Path(path).read_text())
    if data.get('schema_version') != 1:
        raise ValueError('Unsupported prepared media manifest; prepare moments again')
    return data


@lru_cache(maxsize=8)
def _image(path, digest):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('Prepared moment image hash changed; prepare moments again')
    with Image.open(path) as opened:
        if opened.format != 'PNG' or opened.width > 860 or opened.height > 450:
            raise ValueError('Prepared moment image exceeds its card bounds')
        return opened.convert('RGBA')


def composite(image, t, work=None):
    """Composite a prepared card at presentation seconds ``t``, silently."""
    if not isinstance(t,(int,float)) or not math.isfinite(t):
        raise ValueError('Media overlay time must be finite')
    directory = work if work is not None else os.environ.get('FLIGHT_WORK_DIR')
    if directory is None:
        return image
    work = Path(directory).resolve()
    path = work/'media-moments.json'
    if not path.is_file():
        if directory is not None:
            raise ValueError('Media manifest is missing; prepare moments before rendering')
        return image
    stat = path.stat()
    if stat.st_size > 16*1024*1024:
        raise ValueError('Prepared media manifest exceeds its bounded size')
    manifest = _manifest(str(path),stat.st_size,stat.st_mtime_ns)
    active = [event for event in manifest['events'] if event['presentation_start_s'] <= t < event['presentation_end_s']]
    if not active:
        return image
    if len(active) != 1:
        raise ValueError('Prepared media moments overlap; validate the trip again')
    if image.size != (1080,1920):
        raise ValueError('Media overlay layout requires a 1080×1920 frame')
    event = active[0]
    ramp = min(1.,max(0.,(t-event['presentation_start_s'])/.4),max(0.,(event['presentation_end_s']-t)/.4))
    opacity = ramp*ramp*(3-2*ramp)
    if opacity <= 0:
        return image
    tick = round(t*manifest['fps'])
    record = event.get('photo') if event['kind']=='photo' else event['frames'].get(str(tick))
    if not record:
        raise ValueError(f'Moment frame {tick} was not prepared; include it in media preparation')
    source = (work/record['path']).resolve()
    if not source.is_relative_to(work):
        raise ValueError('Prepared media path must remain inside the render work directory')
    content = _image(str(source),record['sha256'])
    card = Image.new('RGBA',(860,450))
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle((0,0,859,449),radius=20,fill=(8,13,19,238),outline=(225,235,245,65),width=1)
    # A small inset preserves every source corner; rounding belongs to the card.
    fitted = ImageOps.contain(content,(836,426),Image.Resampling.LANCZOS)
    card.alpha_composite(fitted,((860-fitted.width)//2,(450-fitted.height)//2))
    scale = .96+.04*opacity
    width,height = round(860*scale),round(450*scale)
    if (width,height) != card.size:
        card = card.resize((width,height),Image.Resampling.LANCZOS)
    if opacity < 1:
        card.putalpha(card.getchannel('A').point(lambda a:round(a*opacity)))
    result = image.convert('RGBA')
    x = CARD_BOX[0]+(860-width)//2
    y = CARD_BOX[1]+round(12*(1-opacity))
    result.alpha_composite(card,(x,y))
    return result
