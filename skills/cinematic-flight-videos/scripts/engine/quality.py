"""Sampling budgets only: all profiles share geometry, fields, clocks and seeds."""
from dataclasses import asdict, dataclass
import os


@dataclass(frozen=True)
class Quality:
    name: str
    terrain_scale: float
    terrain_bisections: int
    limb_steps: int
    cloud_scale: float
    cloud_substeps: int
    cloud_sun_steps: int
    atmosphere_scale: float
    atmosphere_view_steps: int
    atmosphere_sun_steps: int
    aircraft_samples: int

    def to_dict(self):
        return asdict(self)


PROFILES = {
    'preview': Quality('preview', 3., 12, 128, 6., 1, 4, 4., 12, 6, 12),
    'delivery': Quality('delivery', 1.5, 14, 512, 3., 2, 8, 2., 24, 10, 32),
    'high': Quality('high', 1., 17, 768, 2., 3, 12, 1.5, 40, 16, 64),
}


def get_quality(name=None):
    selected = name or os.environ.get('FLIGHT_QUALITY', 'delivery')
    if selected not in PROFILES:
        raise ValueError('Quality must be preview, delivery or high')
    return PROFILES[selected]
