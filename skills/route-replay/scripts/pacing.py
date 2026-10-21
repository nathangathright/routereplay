"""Optional deterministic pacing from immutable flight geometry, without Trip imports.

Presentation intervals and holds belong to Trip. This module maps only normalized
progress within one leg. Altitude trends and turns are editorial cues derived
from contiguous supplied observations, not a certified flight-phase classifier.
"""
from bisect import bisect_left, bisect_right
from collections import OrderedDict
from dataclasses import dataclass
import math

EARTH_M = 6371000.
CACHE_SIZE = 32
MAX_VERTICAL_CUES = 16
MAX_TURN_CUES = 8
MIN_VERTICAL_RATE_MPS = .8
MIN_VERTICAL_CHANGE_M = 100.
MIN_CUE_SECONDS = 20.
TURN_WINDOW_SECONDS = 60.
MIN_TURN_DEGREES = 20.
MIN_TURN_ARM_M = 500.
_CACHE = OrderedDict()


def _fraction(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError('Pacing progress must be a finite number')
    return min(1.,max(0.,float(value)))


def _smooth(value):return value**3*(value*(value*6.-15.)+10.)


def _vector(lat,lon):
    lat,lon=math.radians(lat),math.radians(lon)
    return math.cos(lat)*math.cos(lon),math.cos(lat)*math.sin(lon),math.sin(lat)


def _dot(a,b):return sum(x*y for x,y in zip(a,b))


def _unit(vector):
    length=math.sqrt(_dot(vector,vector))
    return tuple(x/length for x in vector) if length>1e-12 else None


def _angle(a,b):
    cross=(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
    return math.atan2(math.sqrt(_dot(cross,cross)),max(-1.,min(1.,_dot(a,b))))


def _interpolate(times,points,seconds):
    exact=bisect_left(times,seconds)
    if exact<len(times) and times[exact]==seconds:
        return points[exact][1],points[exact][2]
    index=min(max(bisect_right(times,seconds)-1,0),len(times)-2)
    a,b=points[index],points[index+1]
    fraction=min(1.,max(0.,(seconds-times[index])/(times[index+1]-times[index])))
    angle=_angle(a[1],b[1])
    if angle<1e-8:
        position=_unit(tuple(x*(1-fraction)+y*fraction for x,y in zip(a[1],b[1])))
    else:
        denominator=math.sin(angle)
        if abs(denominator)<1e-10:raise ValueError('Pacing track has an ambiguous antipodal segment')
        first=math.sin((1-fraction)*angle)/denominator;last=math.sin(fraction*angle)/denominator
        position=tuple(x*first+y*last for x,y in zip(a[1],b[1]))
    return position,a[2]*(1-fraction)+b[2]*fraction


@dataclass(frozen=True)
class _Cue:
    phase: str
    start: float
    end: float
    strength: float
    basis: str
    detail: float = 0.

    @property
    def center(self):return (self.start+self.end)*.5


@dataclass(frozen=True)
class _Plan:
    duration: float
    source: str
    points_count: int
    max_gap_s: float | None
    covered_seconds: float
    gaps: tuple
    cues: tuple
    x: tuple
    y: tuple
    slopes: tuple

    def map(self,normalized_presentation):
        u=_fraction(normalized_presentation)
        if u==0 or u==1:return u
        q=_smooth(u)
        index=min(max(bisect_right(self.x,q)-1,0),len(self.x)-2)
        width=self.x[index+1]-self.x[index];s=(q-self.x[index])/width
        a,b=self.y[index],self.y[index+1]
        # Monotone Hermite interpolation; adjacent pieces share first derivatives.
        value=((2*s**3-3*s**2+1)*a+(s**3-2*s**2+s)*width*self.slopes[index]
               +(-2*s**3+3*s**2)*b+(s**3-s**2)*width*self.slopes[index+1])
        return min(b,max(a,value))

    def inverse(self,normalized_physical):
        target=_fraction(normalized_physical)
        if target==0 or target==1:return target
        low,high=0.,1.
        for _ in range(56):
            middle=(low+high)*.5
            if self.map(middle)<target:low=middle
            else:high=middle
        return (low+high)*.5


def _monotone_slopes(x,y):
    widths=[b-a for a,b in zip(x,x[1:])]
    secants=[(b-a)/h for a,b,h in zip(y,y[1:],widths)]
    slopes=[secants[0]]
    for index in range(1,len(x)-1):
        before,after=widths[index-1],widths[index]
        weight1=2*after+before;weight2=after+2*before
        slopes.append((weight1+weight2)/(weight1/secants[index-1]+weight2/secants[index]))
    slopes.append(secants[-1])
    # Positive one-sided secants at the endpoints avoid an overshooting extension.
    return tuple(slopes)


def _observations(leg,duration):
    trajectory=getattr(leg,'trajectory',None)
    if trajectory is None:return (),None,'No recorded trajectory; endpoint emphasis is artistic'
    max_gap=float(trajectory.max_gap_s)
    if not math.isfinite(max_gap) or max_gap<=0:raise ValueError('Pacing requires a positive observation gap threshold')
    points=[]
    for observation in trajectory.points:
        seconds=(observation.time-leg.depart).total_seconds()
        coordinates=(float(observation.lat),float(observation.lon),float(observation.altitude_m))
        if (not math.isfinite(seconds) or not all(math.isfinite(v) for v in coordinates) or
                not 0<=seconds<=duration or (points and seconds<=points[-1][0]) or
                not -90<=coordinates[0]<=90 or not -180<=coordinates[1]<=180):
            raise ValueError('Pacing requires finite, chronological observations within the flight')
        points.append((seconds,_vector(*coordinates[:2]),coordinates[2]))
    return tuple(points),max_gap,str(trajectory.source)


def _runs(points,max_gap):
    runs=[];start=0
    for index in range(1,len(points)):
        if points[index][0]-points[index-1][0]>max_gap:
            if index-start>=2:runs.append((start,index-1))
            start=index
    if len(points)-start>=2:runs.append((start,len(points)-1))
    return runs


def _track_cues(points,runs,duration):
    vertical=[];turns=[];times=tuple(point[0] for point in points)
    count=max(1,sum(last-first+1 for first,last in runs))
    for first,last in runs:
        begin,end=times[first],times[last];span=end-begin
        # Bounded time sampling never increases the observation count and never
        # crosses a declared gap. It smooths cue detection, not the flight path.
        sample_count=min(last-first+1,2+int(1024*(last-first+1)/count),max(2,math.ceil(span/30)+1))
        sampled=[begin+span*i/(sample_count-1) for i in range(sample_count)]
        heights=[_interpolate(times,points,when)[1] for when in sampled]
        signs=[]
        for a,b,ha,hb in zip(sampled,sampled[1:],heights,heights[1:]):
            rate=(hb-ha)/(b-a)
            signs.append(1 if rate>=MIN_VERTICAL_RATE_MPS else -1 if rate<=-MIN_VERTICAL_RATE_MPS else 0)
        index=0
        while index<len(signs):
            stop=index+1
            while stop<len(signs) and signs[stop]==signs[index]:stop+=1
            change=heights[stop]-heights[index];seconds=sampled[stop]-sampled[index]
            if signs[index] and seconds>=MIN_CUE_SECONDS and abs(change)>=MIN_VERTICAL_CHANGE_M:
                vertical.append(_Cue('climb' if signs[index]>0 else 'descent',sampled[index]/duration,
                                     sampled[stop]/duration,2.,'contiguous_track_altitude_trend',change))
            index=stop
        if last-first<2:continue
        for when in sampled[1:-1]:
            before=max(begin,when-TURN_WINDOW_SECONDS);after=min(end,when+TURN_WINDOW_SECONDS)
            if min(when-before,after-when)<MIN_CUE_SECONDS:continue
            a=_interpolate(times,points,before)[0];b=_interpolate(times,points,when)[0];c=_interpolate(times,points,after)[0]
            if min(_angle(a,b),_angle(b,c))*EARTH_M<MIN_TURN_ARM_M:continue
            incoming=_unit(tuple(bi*_dot(a,b)-ai for ai,bi in zip(a,b)))
            outgoing=_unit(tuple(ci-bi*_dot(c,b) for ci,bi in zip(c,b)))
            if incoming is None or outgoing is None:continue
            degrees=math.degrees(math.acos(max(-1.,min(1.,_dot(incoming,outgoing)))))
            if degrees>=MIN_TURN_DEGREES:
                turns.append(_Cue('turn',before/duration,after/duration,min(3.,degrees/30.),
                                  'contiguous_track_spherical_turn',degrees))
    # Rank cues deterministically, retain bounded detail, then restore chronology.
    vertical=sorted(vertical,key=lambda cue:(-abs(cue.detail),cue.start, cue.end))[:MAX_VERTICAL_CUES]
    selected=[]
    for cue in sorted(turns,key=lambda cue:(-cue.detail,cue.start,cue.end)):
        if all(abs(cue.center-other.center)*duration>=TURN_WINDOW_SECONDS*2 for other in selected):selected.append(cue)
        if len(selected)==MAX_TURN_CUES:break
    return tuple(sorted(vertical+selected,key=lambda cue:(cue.start,cue.end,cue.phase)))


def _compile(leg):
    duration=(leg.arrive-leg.depart).total_seconds()
    if not math.isfinite(duration) or duration<=0:raise ValueError('Pacing requires a positive physical flight duration')
    points,max_gap,source=_observations(leg,duration)
    runs=_runs(points,max_gap) if points else []
    coverage=[(points[first][0],points[last][0]) for first,last in runs]
    gaps=[];previous=0.
    for begin,end in coverage:
        if begin>previous:gaps.append((previous/duration,begin/duration))
        previous=end
    if previous<duration:gaps.append((previous/duration,1.))
    observed=_track_cues(points,runs,duration) if runs else ()
    # These are always named artistic endpoint cues, never inferred takeoff or
    # landing events. They also cover untracked and too-sparse observation gaps.
    cues=(_Cue('departure_endpoint',0.,.18,2.5,'artistic_endpoint_emphasis'),
          _Cue('arrival_endpoint',.82,1.,2.5,'artistic_endpoint_emphasis'))+observed
    total=1+sum(cue.strength*(cue.end-cue.start)*.5 for cue in cues)
    def cumulative(p):
        value=p
        for cue in cues:
            fraction=min(1.,max(0.,(p-cue.start)/(cue.end-cue.start)))
            value+=cue.strength*(cue.end-cue.start)*(fraction*.5-math.sin(2*math.pi*fraction)/(4*math.pi))
        return value/total
    # Retain every cue boundary/center exactly even for physically short events.
    knots={index/256 for index in range(257)}
    for cue in cues:
        for index in range(5):knots.add(cue.start+(cue.end-cue.start)*index/4)
    # Coincident cue boundaries may differ by a few floating-point ulps. Merge
    # those knots so their CDF abscissas cannot collapse to a zero-width interval.
    ordered=[]
    for value in sorted(knots):
        if not ordered or value-ordered[-1]>1e-12:ordered.append(value)
    if ordered[-1]!=1.:ordered[-1]=1.
    y=tuple(ordered);x=tuple(0. if p==0 else 1. if p==1 else cumulative(p) for p in y)
    return _Plan(duration,source,len(points),max_gap,sum(end-begin for begin,end in coverage),tuple(gaps),
                 cues,x,y,_monotone_slopes(x,y))


def _compiled(leg):
    # Flights and their trajectory/waypoint dataclasses are frozen. Identity keys
    # avoid rehashing up to 100000 coordinates on every frame query. Strong owner
    # references make id reuse impossible while entries remain in this bounded LRU.
    immutable=bool(getattr(getattr(type(leg),'__dataclass_params__',None),'frozen',False))
    if not immutable:return _compile(leg)
    key=id(leg);entry=_CACHE.get(key)
    if entry is not None and entry[0] is leg:
        _CACHE.move_to_end(key);return entry[1]
    compiled=_compile(leg);_CACHE[key]=(leg,compiled);_CACHE.move_to_end(key)
    while len(_CACHE)>CACHE_SIZE:_CACHE.popitem(last=False)
    return compiled


def progress(leg,normalized_presentation):
    """Map [0,1] presentation to physical progress; clamp finite outside values."""
    return _compiled(leg).map(normalized_presentation)


def inverse_progress(leg,normalized_physical):
    """Invert the same map for physical timestamps, without a separate clock."""
    return _compiled(leg).inverse(normalized_physical)


def plan(leg):
    """Fresh JSON-safe evidence report; contains no presentation durations/holds."""
    compiled=_compiled(leg)
    anchors=[]
    for cue in compiled.cues:
        row={'phase':cue.phase,'basis':cue.basis,
             'physical_start':cue.start,'physical_center':cue.center,'physical_end':cue.end,
             'presentation_start':compiled.inverse(cue.start),'presentation_center':compiled.inverse(cue.center),
             'presentation_end':compiled.inverse(cue.end),'attention_strength':cue.strength}
        if cue.phase in ('climb','descent'):row['altitude_change_m']=cue.detail
        if cue.phase=='turn':row['turn_degrees']=cue.detail
        anchors.append(row)
    return {'schema_version':1,'mode':'highlights','physical_duration_s':compiled.duration,
            'mapping':'C1 monotone inverse attention CDF with quintic endpoint easing; zero endpoint velocity and acceleration',
            'source':compiled.source,'observation_count':compiled.points_count,
            'usable_coverage_fraction':compiled.covered_seconds/compiled.duration,'max_gap_s':compiled.max_gap_s,
            'basis':'track_cues_with_artistic_endpoint_emphasis' if any(c.basis!='artistic_endpoint_emphasis' for c in compiled.cues)
                    else 'artistic_endpoint_emphasis_only',
            'uncovered_intervals':[{'physical_start':a,'physical_end':b} for a,b in compiled.gaps[:64]],
            'uncovered_interval_count':len(compiled.gaps),'uncovered_intervals_truncated':len(compiled.gaps)>64,
            'anchors':anchors,'limits':{'vertical_rate_threshold_mps':MIN_VERTICAL_RATE_MPS,
                'vertical_change_threshold_m':MIN_VERTICAL_CHANGE_M,'minimum_cue_duration_s':MIN_CUE_SECONDS,
                'turn_window_s':TURN_WINDOW_SECONDS,'turn_threshold_degrees':MIN_TURN_DEGREES,
                'minimum_turn_arm_m':MIN_TURN_ARM_M,'maximum_vertical_cues':MAX_VERTICAL_CUES,'maximum_turn_cues':MAX_TURN_CUES},
            'notes':['Altitude trends and turns derive only from contiguous supplied observations; phase labels are editorial cues, not detected airborne/touchdown events.',
                     'Uncovered intervals receive no inferred track cues. Endpoint emphasis is explicitly artistic.',
                     'The mapping preserves leg boundaries; total film duration, leg allocation and all holds are controlled unchanged by Trip.']}
