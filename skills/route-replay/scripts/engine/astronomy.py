"""Approximate NOAA solar geometry; all scene lighting uses the same UTC clock."""
import math
from datetime import timezone
from calendar import isleap
from motion import unit

def sun_direction(dt):
    # NOAA's General Solar Position Calculations: equation of time and solar
    # declination. The sun vector is geographic, independent of the camera.
    # https://gml.noaa.gov/grad/solcalc/solareqns.PDF
    dt=dt.astimezone(timezone.utc)
    hour=dt.hour+dt.minute/60+dt.second/3600+dt.microsecond/3.6e9
    gamma=2*math.pi/(366 if isleap(dt.year) else 365)*(dt.timetuple().tm_yday-1+(hour-12)/24)
    equation=229.18*(.000075+.001868*math.cos(gamma)-.032077*math.sin(gamma)
                     -.014615*math.cos(2*gamma)-.040849*math.sin(2*gamma))
    decl=(.006918-.399912*math.cos(gamma)+.070257*math.sin(gamma)
          -.006758*math.cos(2*gamma)+.000907*math.sin(2*gamma)
          -.002697*math.cos(3*gamma)+.00148*math.sin(3*gamma))
    longitude=180-(hour*60+equation)/4
    return unit(math.degrees(decl),longitude)
