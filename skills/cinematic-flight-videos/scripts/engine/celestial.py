"""Finite-distance, correctly phased Moon in the shared perspective camera.

ERFA moon98 gives the geometric geocentric GCRS lunar position. c2t06a puts it
in the Earth's rotating frame. The camera's finite position is subtracted
before projection, retaining lunar parallax. Lunar surface shading is a simple
untextured reflectance approximation at the actual ~10px angular size.
"""
from functools import lru_cache
import math

import erfa
import numpy as np
from PIL import Image

from camera_geometry import EARTH_M, distance, focal_length, sphere_interval
from starfield import _time_scales
from radiometry import TransportLayer, resize_float, tone_map

AU_KM = 149_597_870.7
EARTH_KM = EARTH_M / 1000
MOON_RADIUS_KM = 1737.4


@lru_cache(maxsize=1024)
def ephemeris(dt):
    """Moon/Sun geometric Earth-fixed vectors in km for timezone-aware UTC.

    TT is used for the ephemerides and precession/nutation. UT1=UTC and zero
    polar motion match the stars. Light-time and aberration are not applied;
    these approximation errors are well below one video pixel at this FOV.
    """
    tt1, tt2, ut11, ut12 = _time_scales(dt)
    rotation = erfa.c2t06a(tt1, tt2, ut11, ut12, 0., 0.)
    moon = rotation @ erfa.moon98(tt1, tt2)['p'] * AU_KM
    sun = rotation @ (-erfa.epv00(tt1, tt2)[0]['p']) * AU_KM
    moon.setflags(write=False)
    sun.setflags(write=False)
    return moon, sun


def solar_vector(dt):
    """Unit Earth-fixed Earth-to-Sun vector, using the same lunar ephemeris."""
    sun = ephemeris(dt)[1]
    return sun / np.linalg.norm(sun)


def moon_state(bs, dt, radius, size=(1080, 1920), center=(540, 960)):
    """Return lunar position/phase and projected limb, for rendering and audit."""
    basis = np.asarray(bs, dtype=float)
    moon, sun = ephemeris(dt)
    observer = distance(radius, size[0]) * EARTH_KM * basis[2]
    relative = moon - observer
    length = float(np.linalg.norm(relative))
    direction = relative / length
    local = direction @ basis.T
    depth = -float(local[2])
    angular_radius = math.asin(MOON_RADIUS_KM / length)
    offaxis = math.acos(float(np.clip(depth, -1, 1)))
    focal = focal_length(size[0])
    max_dx = max(center[0], size[0] - center[0])
    max_dy = max(center[1], size[1] - center[1])
    corner_angle = math.atan(math.hypot(max_dx, max_dy) / focal)
    sun_from_moon = sun - moon
    sun_from_moon /= np.linalg.norm(sun_from_moon)
    phase = float((1 + sun_from_moon @ -direction) / 2)
    earth_angle = math.asin(1 / distance(radius, size[0]))
    state = {'moon_km': moon, 'sun_km': sun, 'observer_km': observer,
             'sun_from_moon': sun_from_moon, 'direction': direction,
             'distance_km': length, 'illuminated_fraction': phase,
             'angular_radius_degrees': math.degrees(angular_radius),
             'offaxis_degrees': math.degrees(offaxis),
             'earth_angular_radius_degrees': math.degrees(earth_angle),
             'earth_fully_occults': offaxis + angular_radius < earth_angle,
             'earth_partially_occults': abs(offaxis-earth_angle) < angular_radius,
             'in_frame': False, 'bbox': None, 'center': None}
    if depth <= 0 or offaxis > corner_angle + angular_radius:
        return state
    state['center'] = (center[0] + focal * local[0] / depth,
                       center[1] - focal * local[1] / depth)
    tangent = np.cross(direction, basis[1])
    if np.linalg.norm(tangent) < 1e-8:
        tangent = np.cross(direction, basis[0])
    tangent /= np.linalg.norm(tangent)
    bitangent = np.cross(direction, tangent)
    angles = np.arange(128) * (2 * np.pi / 128)
    rim = (math.cos(angular_radius) * direction + math.sin(angular_radius) *
           (np.cos(angles)[:, None] * tangent + np.sin(angles)[:, None] * bitangent))
    rim_local = rim @ basis.T
    rim_depth = -rim_local[:, 2]
    x = center[0] + focal * rim_local[:, 0] / rim_depth
    y = center[1] - focal * rim_local[:, 1] / rim_depth
    box = (float(x.min()), float(y.min()), float(x.max()), float(y.max()))
    state['bbox'] = box
    state['in_frame'] = box[2] >= 0 and box[0] < size[0] and box[3] >= 0 and box[1] < size[1]
    return state


def moon_transport(bs, dt, radius, size=(1080, 1920), center=(540, 960)):
    """Scene-linear lunar transport at true angular size, behind the Earth.

    Supersampled rays intersect the finite lunar sphere. Both the phase and
    bright-limb angle follow the Sun in 3D; Earth occultation is evaluated along
    each ray. The later Earth/terrain/cloud pass provides the detailed limb.
    """
    size, center = tuple(size), tuple(center)
    radiance = np.zeros((size[1], size[0], 3), np.float32)
    transmittance = np.ones((size[1], size[0], 1), np.float32)
    state = moon_state(bs, dt, radius, size, center)
    if not state['in_frame'] or state['earth_fully_occults']:
        return TransportLayer(radiance, transmittance)
    left, top, right, bottom = state['bbox']
    left, top = max(0, math.floor(left)-2), max(0, math.floor(top)-2)
    right, bottom = min(size[0], math.ceil(right)+3), min(size[1], math.ceil(bottom)+3)
    if left >= right or top >= bottom:
        return TransportLayer(radiance, transmittance)
    supersample = 8
    yy, xx = np.mgrid[:(bottom-top)*supersample, :(right-left)*supersample]
    x = left + (xx+.5)/supersample
    y = top + (yy+.5)/supersample
    focal = focal_length(size[0])
    east, north, outward = np.asarray(bs, dtype=float)
    ray = ((x-center[0])/focal)[..., None]*east + ((center[1]-y)/focal)[..., None]*north - outward
    ray /= np.linalg.norm(ray, axis=-1, keepdims=True)
    relative_origin = state['observer_km'] - state['moon_km']
    near, _, hit = sphere_interval(relative_origin, ray, MOON_RADIUS_KM)
    # A full analytic Earth mask avoids a lunar leak at a shared-camera limb.
    earth_near, _, earth_hit = sphere_interval(state['observer_km'], ray, EARTH_KM)
    hit &= ~(earth_hit & (earth_near < near))
    normal = (relative_origin + near[..., None]*ray) / MOON_RADIUS_KM
    mu0 = np.maximum(0, normal @ state['sun_from_moon'])
    mu = np.maximum(0, np.sum(normal * -ray, axis=-1))
    # Lunar regolith is not Lambertian; a simple Lommel-Seeliger/Lambert blend
    # keeps the small disk readable without changing its geometric phase.
    reflection = .65 * (2 * mu0 / np.maximum(mu0 + mu, 1e-8)) + .35 * mu0
    intensity = (.006 + .994 * np.maximum(reflection, 0)) * .72
    # Filter premultiplied light and coverage separately in float. An unlit
    # portion of the lunar disk still blocks stars behind it.
    patch = resize_float(intensity[..., None] * np.array([1., .98, .94]) * hit[..., None],
                         (right-left, bottom-top))
    alpha = resize_float(hit.astype(np.float32), (right-left, bottom-top))
    radiance[top:bottom, left:right] = patch
    transmittance[top:bottom, left:right, 0] = 1 - alpha
    return TransportLayer(radiance, transmittance)


def moon_layer(bs, dt, radius, size=(1080, 1920), center=(540, 960)):
    """Display preview adapter; the scene compositor uses moon_transport."""
    layer = moon_transport(bs, dt, radius, size, center)
    alpha = 1 - layer.transmittance
    color = np.divide(layer.radiance, alpha, out=np.zeros_like(layer.radiance), where=alpha > 0)
    rgba = np.concatenate((tone_map(color), alpha), axis=-1)
    return Image.fromarray(np.rint(rgba * 255).astype(np.uint8))
