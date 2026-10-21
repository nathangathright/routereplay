"""Experimental metric ENU chase camera, independent of the overhead renderer.

This is a modeled maneuver, not observed aircraft attitude or a flight track.
The local frame is east, north, up at a spherical sea-level origin. Aircraft
axes are +X starboard, +Y nose, +Z up; camera axes match Blender (+X right,
+Y up, -Z view). Physical seconds alone determine every pose. The path is a
short, constant-altitude tangent-plane approximation, suitable for a local clip.
"""
from dataclasses import dataclass
import math
import numpy as np

EARTH_M = 6_371_000.
GRAVITY_MPS2 = 9.80665
_NODES, _WEIGHTS = np.polynomial.legendre.leggauss(32)
_NODES.setflags(write=False)
_WEIGHTS.setflags(write=False)


def _finite(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.number)):
        raise ValueError(f'{name} must be a finite number')
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f'{name} must be a finite number')
    return result


def _vector(value, name):
    result = np.asarray(value, dtype=np.float64)
    if result.shape != (3,) or not np.isfinite(result).all():
        raise ValueError(f'{name} must be a finite 3-vector')
    return result


def enu_basis(lat_deg, lon_deg):
    """Return the orthonormal ENU-to-ECEF matrix (east/north/up columns)."""
    lat, lon = _finite(lat_deg, 'latitude'), _finite(lon_deg, 'longitude')
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError('Latitude/longitude must be within [-90,90]/[-180,180]')
    a, b = math.radians(lat), math.radians(lon)
    return np.array([[-math.sin(b), -math.sin(a)*math.cos(b), math.cos(a)*math.cos(b)],
                     [math.cos(b), -math.sin(a)*math.sin(b), math.cos(a)*math.sin(b)],
                     [0., math.cos(a), math.sin(a)]])


def enu_to_ecef(points_m, lat_deg, lon_deg, origin_altitude_m=0.):
    """Convert (...,3) metric ENU positions to spherical-Earth ECEF metres."""
    points = np.asarray(points_m, dtype=np.float64)
    if points.ndim < 1 or points.shape[-1] != 3 or not np.isfinite(points).all():
        raise ValueError('ENU positions must have finite shape (...,3)')
    basis = enu_basis(lat_deg, lon_deg)
    height = _finite(origin_altitude_m, 'origin altitude')
    return points @ basis.T + basis[:, 2]*(EARTH_M+height)


def ecef_to_enu(points_m, lat_deg, lon_deg, origin_altitude_m=0.):
    """Inverse of enu_to_ecef, using the same spherical origin."""
    points = np.asarray(points_m, dtype=np.float64)
    if points.ndim < 1 or points.shape[-1] != 3 or not np.isfinite(points).all():
        raise ValueError('ECEF positions must have finite shape (...,3)')
    basis = enu_basis(lat_deg, lon_deg)
    height = _finite(origin_altitude_m, 'origin altitude')
    return (points-basis[:, 2]*(EARTH_M+height)) @ basis


def look_at(camera_position_m, target_m, up_hint=(0., 0., 1.)):
    """Return camera-local-to-ENU rotation with its optical axis on target.

    The projected up hint makes a horizontal ENU horizon level. Parallel or
    degenerate inputs raise instead of silently selecting a discontinuous roll.
    """
    eye, target, up = (_vector(value, name) for value, name in
                       ((camera_position_m, 'camera'), (target_m, 'target'), (up_hint, 'up hint')))
    forward = target-eye
    length = np.linalg.norm(forward)
    if length <= 1e-9:
        raise ValueError('Camera and target must be distinct')
    forward /= length
    right = np.cross(forward, up)
    length = np.linalg.norm(right)
    if length <= 1e-9:
        raise ValueError('Up hint must not be parallel to the camera view')
    right /= length
    return np.column_stack((right, np.cross(right, forward), -forward))


@dataclass(frozen=True)
class ChaseConfig:
    origin_lat_deg: float
    origin_lon_deg: float
    altitude_m: float
    heading_deg: float
    speed_mps: float
    duration_s: float = 6.
    bank_deg: float = 15.
    bank_envelope: str = 'smooth'
    aircraft_length_m: float = 45.
    distance_lengths: float = 3.4
    port_azimuth_deg: float = 25.
    elevation_deg: float = 12.
    heading_lag_s: float = .35

    def __post_init__(self):
        for name in self.__dataclass_fields__:
            if name != 'bank_envelope':
                object.__setattr__(self, name, _finite(getattr(self, name), name))
        enu_basis(self.origin_lat_deg, self.origin_lon_deg)
        if self.altitude_m < 0 or not 0 < self.speed_mps <= 1000:
            raise ValueError('Altitude must be nonnegative and speed in (0,1000] m/s')
        if not 0 < self.duration_s <= 120:
            raise ValueError('This local clip requires a duration in (0,120] physical seconds')
        if abs(self.bank_deg) > 45 or self.bank_envelope not in ('steady', 'smooth'):
            raise ValueError('Bank must be within +/-45 degrees with a steady or smooth envelope')
        # Bound the oscillation of the fixed quadrature, including pathological
        # near-zero speeds that cannot represent this fixed-wing local fixture.
        peak_sweep = GRAVITY_MPS2*abs(math.tan(math.radians(self.bank_deg)))*self.duration_s/self.speed_mps
        if not math.isfinite(peak_sweep) or peak_sweep > 2*math.pi:
            raise ValueError('Local chase fixture supports at most one full peak-rate turn per clip')
        if not 0 < self.aircraft_length_m <= 100 or not 1.5 <= self.distance_lengths <= 10:
            raise ValueError('Aircraft length must be in (0,100]m and camera distance in [1.5,10] lengths')
        if not 0 <= self.port_azimuth_deg <= 75 or not 0 < self.elevation_deg < 60:
            raise ValueError('Rear-quarter camera needs port azimuth [0,75] and elevation (0,60) degrees')
        if not 0 <= self.heading_lag_s <= min(2., self.duration_s):
            raise ValueError('Heading lag must be in [0,min(2,duration)] seconds')


class ChaseCamera:
    """Stateless sampling of a coordinated turn and level-horizon chase rig."""
    def __init__(self, config):
        if not isinstance(config, ChaseConfig):
            raise TypeError('ChaseCamera requires a ChaseConfig')
        self.config = config
        self._heading0 = math.radians(config.heading_deg)
        self._peak_rate = GRAVITY_MPS2*math.tan(math.radians(config.bank_deg))/config.speed_mps

    def _heading(self, seconds):
        if self.config.bank_envelope == 'steady':
            integral = seconds
        else:
            duration = self.config.duration_s
            # tan(bank), hence heading rate, rolls smoothly from peak to zero.
            integral = .5*seconds + duration/(2*math.pi)*np.sin(math.pi*seconds/duration)
        return self._heading0+self._peak_rate*integral

    def sample(self, physical_seconds):
        """Return a JSON-serializable pose dict; times outside the clip raise.

        Smooth bank rolls from bank_deg to zero. Heading obeys omega=g*tan(bank)/v.
        Position integrates this heading with fixed Gaussian quadrature; it never
        advances from a previous frame. Analytic heading lag is theta-lag*omega,
        without a mutable spring or a dependency on output fps. Plane attitude
        does not roll the camera. The target is the aircraft's local origin.
        """
        t = _finite(physical_seconds, 'physical seconds')
        cfg = self.config
        if not 0 <= t <= cfg.duration_s:
            raise ValueError('Physical seconds must lie within [0,duration]')
        envelope = 1. if cfg.bank_envelope == 'steady' else .5*(1+math.cos(math.pi*t/cfg.duration_s))
        bank = math.atan(math.tan(math.radians(cfg.bank_deg))*envelope)
        heading = float(self._heading(t))
        rate = self._peak_rate*envelope
        times = t*.5*(_NODES+1)
        headings = self._heading(times)
        position = np.array([cfg.speed_mps*t*.5*float(_WEIGHTS @ np.sin(headings)),
                             cfg.speed_mps*t*.5*float(_WEIGHTS @ np.cos(headings)), cfg.altitude_m])
        yaw = np.array([[math.cos(heading), math.sin(heading), 0.],
                        [-math.sin(heading), math.cos(heading), 0.], [0., 0., 1.]])
        roll = np.array([[math.cos(bank), 0., math.sin(bank)], [0., 1., 0.],
                         [-math.sin(bank), 0., math.cos(bank)]])
        rotation = yaw @ roll
        follow = heading-cfg.heading_lag_s*rate
        nose = np.array([math.sin(follow), math.cos(follow), 0.])
        starboard = np.array([math.cos(follow), -math.sin(follow), 0.])
        azimuth, elevation = math.radians(cfg.port_azimuth_deg), math.radians(cfg.elevation_deg)
        distance = cfg.aircraft_length_m*cfg.distance_lengths
        offset = distance*math.cos(elevation)*(-math.cos(azimuth)*nose-math.sin(azimuth)*starboard)
        offset[2] = distance*math.sin(elevation)
        camera = position+offset
        camera_rotation = look_at(camera, position)
        return {'physical_seconds': t, 'mode': 'modeled_chase_maneuver',
                'aircraft_position_m': position.tolist(), 'aircraft_rotation': rotation.tolist(),
                'heading_deg': math.degrees(heading), 'bank_deg': math.degrees(bank), 'pitch_deg': 0.,
                'ground_speed_mps': cfg.speed_mps, 'turn_rate_rad_s': rate,
                'camera_position_m': camera.tolist(), 'camera_target_m': position.tolist(),
                'camera_up': camera_rotation[:, 1].tolist(), 'camera_rotation': camera_rotation.tolist()}
