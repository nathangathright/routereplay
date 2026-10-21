"""Use an installed condensed sans if available; keep the skill portable."""
import os
from functools import lru_cache
from pathlib import Path
from PIL import ImageFont


def flap_font(size):
    override = os.environ.get('FLIGHT_FONT')
    candidates = [override] if override else [
        '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
        str(Path(os.environ.get('WINDIR', 'C:/Windows'))/'Fonts'/'arialbd.ttf'),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    if override:
        raise ValueError('FLIGHT_FONT must name an existing TrueType/OpenType font.')
    return ImageFont.load_default(size=size)


@lru_cache(maxsize=16)
def telemetry_font(size, weight=600, override=None):
    """Portable rounded numerals; callers pass the override so cache identity agrees."""
    bundled = Path(__file__).resolve().parents[2]/'assets/fonts/dosis/Dosis-Variable.ttf'
    path = Path(override) if override else bundled
    if not path.is_file():
        raise ValueError('FLIGHT_TELEMETRY_FONT must name an existing TrueType/OpenType font.'
                         if override else 'Bundled Dosis telemetry font is missing; reinstall the skill.')
    font = ImageFont.truetype(str(path), size)
    if not override:
        font.set_variation_by_axes([weight])
    return font
