"""Immutable frame inputs; shared units and explicit physical/weather/edit clocks."""
from dataclasses import dataclass
from datetime import datetime
import math
import numpy as np
from astronomy import sun_direction
from camera_geometry import distance


@dataclass(frozen=True)
class FrameContext:
    presentation_s: float
    physical_utc: datetime
    weather_utc: datetime
    camera_basis: tuple
    globe_radius_px: float
    camera_distance_earth: float
    sun_world: tuple
    sun_camera: tuple
    heading_deg: float
    terrain_m: float
    aircraft_altitude_m: float
    trajectory_mode: str
    rendered_altitude_m: float
    bank_deg: float = 0.
    pitch_deg: float = 0.
    attitude_mode: str = 'disabled'

    def to_dict(self):
        return {'presentation_s':self.presentation_s,'physical_utc':self.physical_utc.isoformat(),
                'weather_utc':self.weather_utc.isoformat(),'camera_basis':self.camera_basis,
                'globe_radius_px':self.globe_radius_px,'camera_distance_earth':self.camera_distance_earth,
                'sun_world':self.sun_world,'sun_camera':self.sun_camera,'heading_deg':self.heading_deg,
                'terrain_m':self.terrain_m,'aircraft_altitude_m':self.aircraft_altitude_m,
                'terrain_clearance_m':self.aircraft_altitude_m-self.terrain_m,
                'rendered_altitude_m':self.rendered_altitude_m,
                'trajectory_mode':self.trajectory_mode,
                'bank_deg':self.bank_deg,'pitch_deg':self.pitch_deg,'attitude_mode':self.attitude_mode}


def context_at(motion, t, terrain=None):
    t=motion.trip._time(t)
    physical=motion.trip.travel_time(t)
    camera=np.asarray(motion.camera(t))
    ground=float(terrain.sample(camera[2])) if terrain is not None else 0.
    sun=sun_direction(physical)
    leg=motion.trip.active_leg(t)
    mode=motion.trajectory_state(leg,motion.trip.progress(leg,t))['mode']
    attitude=motion.attitude(t)
    return FrameContext(t,physical,motion.trip.weather_time(t),tuple(tuple(row) for row in camera),
                        motion.zoom(t),distance(motion.zoom(t)),tuple(sun),tuple(camera@sun),
                        motion.heading(t),ground,motion.altitude(t,terrain_m=ground),mode,
                        motion.altitude(t,terrain_m=ground)*max(1.,motion.trip.style['relief_exaggeration']),
                        attitude['bank_deg'],attitude['pitch_deg'],attitude['mode'])


def solar_visibility(sun_elevation_cosine, altitude_m):
    # Geometric solar-disc fraction; optical refraction is outside this model.
    elevation=math.asin(float(np.clip(sun_elevation_cosine,-1,1)))
    horizon=-math.acos(6371000/(6371000+max(0.,altitude_m)))
    x=float(np.clip((elevation-horizon)/math.radians(.265),-1,1))
    return (math.acos(-x)+x*math.sqrt(max(0,1-x*x)))/math.pi
