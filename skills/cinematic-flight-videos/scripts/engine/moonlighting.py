"""Physical-clock lunar geometry and incoming illumination.

Directions, phase and parallax reuse celestial.ephemeris. Observer altitude is
un-exaggerated before computing the Moon's direction or the Earth horizon.
The scalar ratio is relative to reference sunlight at 1 AU, before atmosphere,
cloud extinction, local visibility or any explicitly cinematic gain.

Photometry uses the Krisciunas & Schaefer (1991) V-band phase approximation,
with a disclosed near-new-Moon taper. Eclipse attenuation averages finite
Sun/Earth disc overlap over 128 samples of the visible lunar disc. Refraction,
earthshine, spectral lunar reflectance and red illumination during total lunar
eclipses are omitted. This is not a calibrated spectral irradiance model.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

import numpy as np

from celestial import AU_KM, EARTH_KM, MOON_RADIUS_KM, ephemeris


SUN_RADIUS_KM = 695700.
REFERENCE_MOON_DISTANCE_KM = 384400.
# Approximate visual-band ratio from mV(Moon)~-12.74 and mV(Sun)=-26.74.
# Kept separate from artistic amplification. One is the unboosted reference.
FULL_MOON_RATIO = 2.5e-6


@dataclass(frozen=True)
class LunarIllumination:
    direction: np.ndarray
    ratio: np.ndarray
    visibility: np.ndarray
    angular_radius: np.ndarray
    phase_angle: np.ndarray
    illuminated_fraction: np.ndarray
    distance_km: np.ndarray
    eclipse_transmission: float

    def __post_init__(self):
        direction = np.array(self.direction, np.float64, copy=True)
        if direction.ndim != 2 or direction.shape[1] != 3 or not np.isfinite(direction).all():
            raise ValueError('Lunar directions must be finite N×3 vectors')
        if not np.allclose(np.linalg.norm(direction, axis=-1), 1., rtol=0, atol=1e-10):
            raise ValueError('Lunar directions must be normalized')
        direction.setflags(write=False)
        object.__setattr__(self, 'direction', direction)
        for name in ('ratio', 'visibility', 'angular_radius', 'phase_angle',
                     'illuminated_fraction', 'distance_km'):
            value = np.array(getattr(self, name), np.float64, copy=True)
            if value.shape != (len(direction),) or not np.isfinite(value).all() or np.any(value < 0):
                raise ValueError(f'Lunar {name} must be a finite nonnegative N-vector')
            if name in ('visibility', 'illuminated_fraction') and np.any(value > 1):
                raise ValueError(f'Lunar {name} must be in [0, 1]')
            if name == 'phase_angle' and np.any(value > np.pi):
                raise ValueError('Lunar phase angle must be in [0, pi]')
            if name == 'angular_radius' and np.any((value <= 0) | (value >= np.pi/2)):
                raise ValueError('Lunar angular radius must be in (0, pi/2)')
            if name == 'distance_km' and np.any(value <= MOON_RADIUS_KM):
                raise ValueError('Cloud observers must be outside the Moon')
            value.setflags(write=False)
            object.__setattr__(self, name, value)
        eclipse = float(self.eclipse_transmission)
        if not np.isfinite(eclipse) or not 0 <= eclipse <= 1:
            raise ValueError('Lunar eclipse transmission must be in [0, 1]')
        object.__setattr__(self, 'eclipse_transmission', eclipse)


def phase_brightness(phase_angle):
    """Relative V-band brightness; phase angle is radians, 0=full, pi=new.

    The empirical magnitude increment is .026*alpha + 4e-9*alpha**4 for alpha
    in degrees. It captures the nonlinear phase curve, not just illuminated
    area. Beyond 150 degrees a smooth taper removes its nonzero value at new
    Moon, where this model deliberately omits Earthshine. The taper is an
    extrapolation choice, not a term from the published model. No separate
    opposition surge or libration-dependent albedo is modeled.
    """
    phase = np.asarray(phase_angle, np.float64)
    if np.any(~np.isfinite(phase)) or np.any((phase < 0) | (phase > np.pi)):
        raise ValueError('Lunar phase angle must be finite and in [0, pi]')
    degrees = np.degrees(phase)
    value = 10**(-.4*(.026*degrees+4e-9*degrees**4))
    taper = np.clip((180-degrees)/30, 0, 1)
    return value*taper*taper*(3-2*taper)


def disc_visible_fraction(source_radius, occluder_radius, separation):
    """Unocculted source-disc area using small-angle circular overlap.

    All arguments are angular radians and broadcast together. The formula is
    exact for planar circles, and an approximation for spherical sky caps;
    lunar-eclipse Sun/Earth discs subtend only about .27/.95 degrees. Total,
    annular, tangent and disjoint cases are handled without division by zero.
    """
    r, big, d = np.broadcast_arrays(np.asarray(source_radius, np.float64),
        np.asarray(occluder_radius, np.float64), np.asarray(separation, np.float64))
    if (np.any(~np.isfinite(r)) or np.any(~np.isfinite(big)) or np.any(~np.isfinite(d))
            or np.any((r <= 0) | (r > np.pi/2)) or np.any((big < 0) | (big > np.pi/2))
            or np.any((d < 0) | (d > np.pi))):
        raise ValueError('Disc radii and separation must be finite valid angular radians')
    overlap = np.zeros_like(d)
    contained = d <= np.abs(big-r)
    overlap[contained] = np.pi*np.minimum(r[contained], big[contained])**2
    partial = (d < r+big) & ~contained
    if np.any(partial):
        a, b, x = r[partial], big[partial], d[partial]
        alpha = np.arccos(np.clip((x*x+a*a-b*b)/(2*x*a), -1, 1))
        beta = np.arccos(np.clip((x*x+b*b-a*a)/(2*x*b), -1, 1))
        radicand = (-x+a+b)*(x+a-b)*(x-a+b)*(x+a+b)
        overlap[partial] = a*a*alpha+b*b*beta-.5*np.sqrt(np.maximum(radicand, 0))
    visible = np.clip(1-overlap/(np.pi*r*r), 0, 1)
    return np.where(contained & (big >= r), 0., visible)


def eclipse_transmission(moon_km, sun_km):
    """Direct sunlight surviving Earth occultation over the lunar disc.

    Eight equal-area projected rings with sixteen azimuths sample the
    geocentrically visible lunar hemisphere. Each sample sees finite solar and
    Earth discs. Uniform projected-disc weighting approximates full-Moon
    surface radiance during an eclipse. It does not model lunar terrain or the
    refracted red light that can remain during totality. The small observer-
    dependent change to the visible lunar hemisphere is intentionally omitted.
    """
    moon = np.asarray(moon_km, np.float64)
    sun = np.asarray(sun_km, np.float64)
    if (moon.shape != (3,) or sun.shape != (3,) or not np.isfinite(moon).all()
            or not np.isfinite(sun).all()):
        raise ValueError('Eclipse geometry requires finite Moon/Sun vectors in km')
    distance = np.linalg.norm(moon)
    solar_distance = np.linalg.norm(sun-moon)
    if (not np.isfinite(distance) or not np.isfinite(solar_distance)
            or distance <= EARTH_KM+MOON_RADIUS_KM
            or solar_distance <= SUN_RADIUS_KM+MOON_RADIUS_KM):
        raise ValueError('Eclipse geometry contains overlapping or invalid bodies')
    toward_earth = -moon/distance
    toward_sun = (sun-moon)/solar_distance
    separation = np.arccos(np.clip(toward_earth@toward_sun, -1, 1))
    # Reject the ordinary uneclipsed case before the bounded disc quadrature.
    max_earth_radius = np.arcsin(EARTH_KM/(distance-MOON_RADIUS_KM))
    max_sun_radius = np.arcsin(SUN_RADIUS_KM/(solar_distance-MOON_RADIUS_KM))
    moon_spread = np.arcsin(MOON_RADIUS_KM/distance)
    if separation > max_earth_radius+max_sun_radius+2*moon_spread:
        return 1.
    tangent = toward_sun-toward_earth*(toward_sun@toward_earth)
    length = np.linalg.norm(tangent)
    if length < 1e-12:
        axis = np.eye(3)[np.argmin(np.abs(toward_earth))]
        tangent = np.cross(toward_earth, axis)
        length = np.linalg.norm(tangent)
    tangent = tangent/length
    bitangent = np.cross(toward_earth, tangent)
    radius = np.repeat(np.sqrt((np.arange(8)+.5)/8), 16)
    angle = np.tile(2*np.pi*(np.arange(16)+.5)/16, 8)
    normal = (radius[:, None]*(np.cos(angle)[:, None]*tangent+np.sin(angle)[:, None]*bitangent)
              +np.sqrt(1-radius*radius)[:, None]*toward_earth)
    point = moon+MOON_RADIUS_KM*normal
    earth_distance = np.linalg.norm(point, axis=-1)
    solar = sun-point
    sun_distance = np.linalg.norm(solar, axis=-1)
    cosine = np.sum((-point/earth_distance[:, None])*(solar/sun_distance[:, None]), axis=-1)
    visible = disc_visible_fraction(np.arcsin(SUN_RADIUS_KM/sun_distance),
        np.arcsin(EARTH_KM/earth_distance), np.arccos(np.clip(cosine, -1, 1)))
    return float(np.mean(visible))


@lru_cache(maxsize=64)
def _frame_geometry(physical_dt):
    moon, sun = (np.array(value, np.float64, copy=True) for value in ephemeris(physical_dt))
    eclipse = eclipse_transmission(moon, sun)
    moon.setflags(write=False)
    sun.setflags(write=False)
    return moon, sun, eclipse


def lunar_illumination(points, physical_dt, *, height_exaggeration=1.):
    """Return immutable lunar source geometry and photometry for N cloud points.

    Input points are displayed Earth-radius coordinates; physical cloud height
    is (|point|-1)*EARTH_KM/height_exaggeration. Pass the renderer's
    max(1, relief_exaggeration). ``physical_dt`` must be timezone-aware; weather
    replay time must never be passed here.

    ``ratio`` includes phase, inverse-square Moon distance, inverse-square
    Sun-to-Moon illumination and eclipse attenuation. It EXCLUDES local Earth
    visibility and all atmospheric/cloud attenuation. Apply those factors and
    cinematic gain once in the calling transport code. Visibility uses the
    same locally straight spherical-Earth limb approximation as solar_visibility
    with this Moon's variable angular radius. No atmospheric refraction or
    terrain horizon is included. The returned direction points sample→Moon;
    forward-scattering cosine is dot(camera_to_sample, direction).
    """
    point = np.asarray(points, np.float64)
    if point.ndim != 2 or point.shape[1] != 3 or not np.isfinite(point).all():
        raise ValueError('Lunar illumination requires finite N×3 Earth-fixed points')
    scale = float(height_exaggeration)
    if not np.isfinite(scale) or scale < 1:
        raise ValueError('Cloud height exaggeration must be finite and at least one')
    if not isinstance(physical_dt, datetime) or physical_dt.tzinfo is None or physical_dt.utcoffset() is None:
        raise ValueError('Moonlight requires a timezone-aware physical datetime')
    radius = np.linalg.norm(point, axis=-1)
    if not np.isfinite(radius).all() or np.any(radius < 1-1e-12):
        raise ValueError('Cloud points must be on or above the unit Earth')
    up = point/radius[:, None]
    physical_radius = 1+np.maximum(radius-1, 0)/scale
    observer = up*(physical_radius*EARTH_KM)[:, None]
    moon, sun, eclipse = _frame_geometry(physical_dt.astimezone(timezone.utc))
    relative = moon-observer
    distance = np.linalg.norm(relative, axis=-1)
    if not np.isfinite(distance).all() or np.any(distance <= MOON_RADIUS_KM):
        raise ValueError('Cloud observers must be outside the Moon')
    direction = relative/distance[:, None]
    angular_radius = np.arcsin(MOON_RADIUS_KM/distance)
    sun_from_moon = sun-moon
    sun_distance = np.linalg.norm(sun_from_moon)
    cosine = np.clip(-direction@(sun_from_moon/sun_distance), -1, 1)
    phase = np.arccos(cosine)
    fraction = .5*(1+cosine)
    ratio = (FULL_MOON_RATIO*phase_brightness(phase)*(REFERENCE_MOON_DISTANCE_KM/distance)**2
             *(AU_KM/sun_distance)**2*eclipse)
    altitude = np.arcsin(np.clip(np.sum(up*direction, axis=-1), -1, 1))
    depression = np.arccos(np.clip(1/physical_radius, -1, 1))
    limb = np.clip((altitude+depression)/angular_radius, -1, 1)
    visibility = .5+(np.arcsin(limb)+limb*np.sqrt(np.maximum(1-limb*limb, 0)))/np.pi
    return LunarIllumination(direction, ratio, visibility, angular_radius, phase,
                             fraction, distance, eclipse)


def lunar_incident(points, physical_dt, weather_dt, *, strength,
                   height_exaggeration=1., with_weather=True,
                   cloud_samples=None, atmosphere_samples=None):
    """Return lunar geometry and attenuated incoming RGB for surface/aircraft.

    ``points`` are N×3 Earth-radius positions. Their radial height is divided
    by ``height_exaggeration`` for physical lunar geometry, then multiplied by
    the scene's max(1, relief_exaggeration) for extinction sampling. Thus a
    physical aircraft point (scale 1) and an exaggerated surface point describe
    the same air/cloud path when they represent the same physical location.

    Both extinction helpers receive that displayed position. This intentionally
    matches the cloud source's existing convention: clouds undo the scene
    height scale internally; air uses its cinematic 7.2× density-height spread.
    It is a shared displayed-coordinate approximation, not a new physical-air
    model. Moon directions and horizon visibility always use physical height.

    The result is ``strength * ratio * visibility * exp(-cloud_tau-air_tau)``
    relative to reference sunlight. It includes no normal cosine, phase
    function, pi normalization, SOLAR_RADIANCE factor or material response.
    ``physical_dt`` controls lunar geometry; only ``weather_dt`` reaches cloud
    density. ``with_weather=False`` skips cloud queries but retains air RGB.
    Zero strength, hidden Moon and zero lunar photometry skip all extinction
    queries. Geometry remains available in every case. No terrain occlusion,
    diffuse lunar sky, refraction or below-horizon lunar twilight is added.
    """
    gain = float(strength)
    if not np.isfinite(gain) or gain < 0:
        raise ValueError('Lunar incident strength must be finite and nonnegative')
    for name, count in (('cloud_samples', cloud_samples),
                        ('atmosphere_samples', atmosphere_samples)):
        if count is not None and (isinstance(count, (bool, np.bool_))
                                  or not isinstance(count, (int, np.integer)) or count < 1):
            raise ValueError(f'{name} must be a positive integer')
    state = lunar_illumination(points, physical_dt, height_exaggeration=height_exaggeration)
    incoming = np.zeros((len(state.direction), 3), np.float32)
    active = (state.ratio > 0) & (state.visibility > 0)
    if gain == 0 or not np.any(active):
        return state, incoming

    # Runtime imports avoid the cloudvolume -> moonlighting import cycle and
    # leave disabled/night-side queries independent of weather assets.
    import atmosphere as air
    from camera_geometry import sphere_interval
    from quality import get_quality
    from runtime import TRIP

    quality = get_quality()
    scene_scale = max(1., float(TRIP.style.get('relief_exaggeration', 12.)))
    point = np.asarray(points, np.float64)[active]
    radius = np.linalg.norm(point, axis=-1)
    physical_height = np.maximum(radius-1., 0.)/float(height_exaggeration)
    query = (point/radius[:, None])*(1.+physical_height*scene_scale)[:, None]
    direction = state.direction[active]

    cloud_tau = np.zeros(len(query), np.float64)
    if with_weather:
        import cloudvolume as cloud
        cloud_tau = cloud._cloud_optical_depth(query, direction, weather_dt,
            samples=quality.cloud_sun_steps if cloud_samples is None else int(cloud_samples))

    near, far, hit = sphere_interval(query, direction, air.OUTER_KM/air.EARTH_KM)
    air_tau = np.zeros((len(query), 3), np.float64)
    in_air = hit & (far > near)
    if np.any(in_air):
        air_tau[in_air] = air.optical_depth(
            query[in_air]+direction[in_air]*near[in_air, None], direction[in_air],
            far[in_air]-near[in_air],
            samples=quality.atmosphere_sun_steps if atmosphere_samples is None else int(atmosphere_samples),weather_dt=weather_dt)
    value = ((gain*state.ratio[active]*state.visibility[active])[:, None]
             *np.exp(-air_tau-np.asarray(cloud_tau)[:, None]))
    if not np.isfinite(value).all() or np.any(value > np.finfo(np.float32).max):
        raise ValueError('Lunar incident strength exceeds finite scene irradiance')
    incoming[active] = value
    return state, incoming
