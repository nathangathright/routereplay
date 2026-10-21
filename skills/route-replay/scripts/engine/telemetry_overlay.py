"""Quiet screen-space telemetry; physical measurements never use the zoom arc.

All cells have fixed anchors and tabular digit advances. Rendering is stateless,
so out-of-order workers, previews and resumed exports produce identical pixels.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter
from fonts import telemetry_font
from telemetry import sample

ESTIMATED = {'estimated', 'illustrative'}


def readouts(state, units='aviation'):
    """Return label, formatted value, unit and estimate flag for each fixed cell."""
    factors = (1/1852, 1/.3048, 3600/1852) if units == 'aviation' else (.001, 1., 3.6)
    symbols = ('NM', 'FT', 'KT') if units == 'aviation' else ('KM', 'M', 'KM/H')
    fields = (('DISTANCE', 'distance_m', 'distance_basis'),
              ('ALTITUDE · MSL', 'altitude_m', 'altitude_basis'),
              ('GROUND SPEED', 'ground_speed_mps', 'speed_basis'))
    result = []
    for (label, key, basis), factor, symbol in zip(fields, factors, symbols):
        raw = state[key]
        estimated = raw is not None and state[basis] in ESTIMATED
        value = '—' if raw is None or not math.isfinite(raw) else f'{round(raw*factor):,}'
        result.append((label, value, symbol, estimated))
    return result


def _advance(text, font):
    digit = max(font.getlength(c) for c in '0123456789')
    return sum(digit if c.isdigit() else font.getlength(c) for c in text)


def _number(draw, xy, text, font, fill):
    x, y = xy
    digit = max(font.getlength(c) for c in '0123456789')
    baseline = y-font.getbbox('0123456789',anchor='ls')[1]
    for char in text:
        width = digit if char.isdigit() else font.getlength(char)
        draw.text((x+(width-font.getlength(char))/2,baseline),char,font=font,fill=fill,anchor='ls')
        x += width


def composite(image, trip, t):
    if not trip.telemetry or not trip.telemetry['enabled']:
        return image
    if image.size != (1080,1920):
        raise ValueError('Telemetry layout requires the renderer’s 1080×1920 frame.')
    # Top safe area is separate from airport slots and the center aircraft.
    # Leave social app controls at the right/bottom unobstructed.
    alpha = 1-(1-min(1.,max(0.,float(t)/.6)))**3
    if alpha == 0:
        return image
    offset = round(10*(1-alpha))
    state = sample(trip,t)
    values = readouts(state,trip.telemetry['units'])
    override = os.environ.get('FLIGHT_TELEMETRY_FONT')
    label_font = telemetry_font(24,500,override)
    unit_font = telemetry_font(24,500,override)
    value_font = telemetry_font(56,600,override)
    layer = Image.new('RGBA', image.size)
    # A feathered scrim preserves contrast over both bright clouds and black sky.
    scrim = Image.new('RGBA', image.size)
    ImageDraw.Draw(scrim).rounded_rectangle((58,240,955,406),radius=36,fill=(3,9,16,130))
    layer = Image.alpha_composite(layer,scrim.filter(ImageFilter.GaussianBlur(20)))
    draw = ImageDraw.Draw(layer)
    for x, (label, value, unit, estimated) in zip((88,380,672),values):
        draw.text((x,270),label,font=label_font,fill=(200,215,224,255),anchor='lt')
        text = ('≈' if estimated else '')+value
        font = value_font
        # Fit unusually long cumulative distances without moving other cells.
        for size in range(56,27,-2):
            font = telemetry_font(size,600,override)
            if _advance(text,font) <= 260:
                break
        _number(draw,(x,310),text,font,(247,250,252,255))
        draw.text((x,376),unit,font=unit_font,fill=(200,215,224,255),anchor='lt')
    if any(row[3] for row in values):
        draw.text((88,425),'≈ Estimated',font=unit_font,fill=(219,229,235,255),anchor='lt',
                  stroke_width=1,stroke_fill=(3,9,16,160))
    if alpha < 1:
        layer.putalpha(layer.getchannel('A').point(lambda a:round(a*alpha)))
    result = image.convert('RGBA')
    result.alpha_composite(layer,(0,offset))
    return result
