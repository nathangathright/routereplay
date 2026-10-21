"""Pure geographic motion shared by the globe, labels and aircraft prepass.

The cinematic observer height and illustrative aircraft altitude are independent.
All vectors are Earth-fixed; the camera basis is always east, north, outward.
"""
import math
from bisect import bisect_right
import numpy as np
from trip import Trip


def unit(lat, lon):
    a, b = np.radians([lat, lon])
    return np.array([np.cos(a)*np.cos(b), np.cos(a)*np.sin(b), np.sin(a)])


def ease(x):
    x = np.clip(x, 0, 1)
    return x*x*x*(x*(x*6-15)+10)


def slerp(a, b, amount):
    angle = np.arccos(np.clip(a @ b, -1, 1))
    amount = np.asarray(amount)[..., None]
    if angle < 1e-7:
        point = (1-amount)*a+amount*b
        return point/np.maximum(np.linalg.norm(point,axis=-1,keepdims=True),1e-15)
    if math.pi-angle < 1e-7:
        raise ValueError("An antipodal segment needs an intermediate waypoint")
    return (np.sin((1-amount)*angle)*a + np.sin(amount*angle)*b)/np.sin(angle)


def basis(lat, lon):
    a, b = np.radians([lat, lon])
    return (np.array([-np.sin(b), np.cos(b), 0]),
            np.array([-np.sin(a)*np.cos(b), -np.sin(a)*np.sin(b), np.cos(a)]),
            unit(lat, lon))


class Motion:
    def __init__(self, trip: Trip):
        self.trip = trip
        self.vectors = np.array([unit(a.lat, a.lon) for a in trip.airport_sequence])
        self.angles = np.array([leg.angle for leg in trip.legs])
        self.heights = self.angles/self.angles.max()
        self.tracks = [self._track(i) for i in range(len(trip.legs))]
        self._attitude_support = {}

    def camera(self, t, *_):
        leg = self.trip.active_leg(t)
        forward = self.route_position(leg,self.trip.progress(leg,t))
        end = self.trip.leg_intervals[leg][1]
        if leg+1 < len(self.trip.legs) and t > end:
            following = self.trip.leg_intervals[leg+1][0]
            forward = slerp(forward,self.route_position(leg+1,0),float(ease((t-end)/(following-end))))
        return basis(math.degrees(math.asin(float(np.clip(forward[2], -1, 1)))),
                     math.degrees(math.atan2(float(forward[1]), float(forward[0]))))

    def _track(self, leg_index):
        leg = self.trip.legs[leg_index]
        if not leg.trajectory:
            return None
        points = leg.trajectory.points
        times = [(p.time-leg.depart).total_seconds() for p in points]
        vectors = [unit(p.lat,p.lon) for p in points]
        altitudes = [p.altitude_m for p in points]
        observed = [True]*len(points)
        if points[0].time > leg.depart:
            times.insert(0,0.)
            vectors.insert(0,self.vectors[leg_index])
            altitudes.insert(0,0.)
            observed.insert(0,False)
        if points[-1].time < leg.arrive:
            times.append((leg.arrive-leg.depart).total_seconds())
            vectors.append(self.vectors[leg_index+1])
            altitudes.append(0.)
            observed.append(False)
        return np.array(times),np.array(vectors),np.array(altitudes),observed

    def trajectory_state(self, leg, progress):
        track = self.tracks[leg]
        if track is None:
            return {'position':slerp(self.vectors[leg],self.vectors[leg+1],progress),
                    'altitude_m':max(0.,11000*math.sin(math.pi*progress)),
                    'mode':'illustrative', 'observed':False}
        times,points,altitudes,observations = track
        seconds = float(np.clip(progress,0,1))*(self.trip.legs[leg].arrive-self.trip.legs[leg].depart).total_seconds()
        i = min(len(times)-2,max(0,bisect_right(times,seconds)-1))
        fraction = float(np.clip((seconds-times[i])/(times[i+1]-times[i]),0,1))
        gap = not (observations[i] and observations[i+1]) or times[i+1]-times[i] > self.trip.legs[leg].trajectory.max_gap_s
        observed = any(abs(seconds-times[j]) < 1e-6 and observations[j] for j in (i,i+1))
        return {'position':slerp(points[i],points[i+1],fraction),
                'altitude_m':float(altitudes[i]*(1-fraction)+altitudes[i+1]*fraction),
                'mode':'observed' if observed else 'gap_interpolation' if gap else 'track_interpolation',
                'observed':observed,
                # Only synthetic terminal anchors use zero as a placeholder.
                # Their terrain contribution tapers away before the first /
                # after the last measured MSL altitude, which is never altered.
                'terrain_fraction':(1-fraction)*float(not observations[i]) +
                                   fraction*float(not observations[i+1])}

    def route_position(self, leg, progress):
        return self.trajectory_state(leg,progress)['position']

    def route_points(self, leg, count=240, progress=1.):
        return np.array([self.route_position(leg,float(p)) for p in np.linspace(0,progress,count)])

    def route_heading(self, leg, progress):
        forward = self.route_position(leg,progress)
        # A short physical-time difference preserves recorded turns. Stationary
        # observations borrow the nearest non-stationary segment's heading.
        delta = min(.001,5./(self.trip.legs[leg].arrive-self.trip.legs[leg].depart).total_seconds())
        before=self.route_position(leg,max(0,progress-delta))
        after=self.route_position(leg,min(1,progress+delta))
        tangent=after-before
        tangent -= forward*float(tangent@forward)
        if np.linalg.norm(tangent)<1e-10:
            track=self.tracks[leg]
            if track:
                seconds=float(np.clip(progress,0,1))*(self.trip.legs[leg].arrive-self.trip.legs[leg].depart).total_seconds()
                segment_distance=np.maximum(np.maximum(track[0][:-1]-seconds, seconds-track[0][1:]),0.)
                order=np.argsort(segment_distance,kind='stable')
                candidates=((track[1][i],track[1][i+1]) for i in order)
            else:
                candidates=[(self.vectors[leg],self.vectors[leg+1])]
            for a,b in candidates:
                normal=np.cross(a,b)
                if np.linalg.norm(normal)>1e-10:
                    tangent=np.cross(normal,forward)
                    break
        east,north,_=basis(math.degrees(math.asin(float(np.clip(forward[2],-1,1)))),
                           math.degrees(math.atan2(float(forward[1]),float(forward[0]))))
        return math.degrees(math.atan2(float(tangent@east),float(tangent@north)))%360

    def heading(self, t, *_):
        leg = self.trip.active_leg(t)
        end = self.trip.leg_intervals[leg][1]
        if leg + 1 < len(self.trip.legs) and t > end:
            following = self.trip.leg_intervals[leg+1][0]
            first, second = self.route_heading(leg, 1), self.route_heading(leg+1, 0)
            turn = (second-first+180) % 360-180
            return first+turn*float(ease((t-end)/(following-end)))
        return self.route_heading(leg, self.trip.progress(leg, t))

    def zoom(self, t):
        leg = self.trip.active_leg(t)
        p = self.trip.progress(leg, t)
        height = 4*p*(1-p)*self.heights[leg]
        ground, summit = self.trip.style['ground_radius'], self.trip.style['summit_radius']
        return ground/(1+(ground/summit-1)*height)

    def altitude(self, t, terrain_m=0.):
        leg=self.trip.active_leg(t)
        state=self.trajectory_state(leg,self.trip.progress(leg,t))
        # A recorded MSL altitude is never modified. Missing terminal positions
        # use an illustrative interpolation; terrain clearance is reported separately.
        if self.tracks[leg] is not None:
            return state["altitude_m"] + float(terrain_m)*state.get("terrain_fraction",0.)
        return max(0.,terrain_m)+state["altitude_m"]

    def attitude(self, t):
        """Modeled bank/pitch from physical-time route curvature and climb.

        Bank is positive for right-wing-down; pitch is positive nose-up.
        Recorded routes use a weighted quadratic fit over a physical window
        determined by observation cadence and leg duration, never video timing.
        Spherical log displacements share a tangent plane, so meridian
        convergence creates no bank. The fit suppresses waypoint noise and
        deliberately attenuates maneuvers shorter than its reliable support.
        This is modeled coordinated-turn/climb attitude, never measured pose.
        Gaps, stationary intervals and holds stay level; reliable motion fades
        over the physical support window. Caps use smooth tanh limiting.
        """
        config=getattr(self.trip,'attitude',None)
        level=lambda mode:{'bank_deg':0.,'pitch_deg':0.,'mode':mode}
        if not config or not config.get('enabled',False):return level('disabled')
        t=self.trip._time(t)
        leg=self.trip.active_leg(t);start,end=self.trip.leg_intervals[leg]
        if t<=start or t>=end:return level('hold')
        flight=self.trip.legs[leg]
        duration=(flight.arrive-flight.depart).total_seconds()
        seconds=(self.trip.travel_time(t)-flight.depart).total_seconds()
        track=self.tracks[leg]
        lower,upper=0.,duration
        window=15.
        mode='illustrative' if track is None else 'modeled_trajectory'
        if track is not None:
            if leg not in self._attitude_support:
                times,points,_,observations=track
                intervals=np.diff(times)
                angles=np.arctan2(np.linalg.norm(np.cross(points[:-1],points[1:]),axis=-1),
                                  np.sum(points[:-1]*points[1:],axis=-1))
                observed=np.asarray(observations,bool)
                valid=observed[:-1]&observed[1:]&(intervals<=flight.trajectory.max_gap_s)
                moving=angles*6371000./intervals>1.
                good=valid&moving
                bounds=[]
                first=0
                for index in range(len(good)):
                    if not good[index]:first=index+1
                    bounds.append([first,index+1])
                last=len(good)
                for index in range(len(good)-1,-1,-1):
                    if not good[index]:last=index
                    bounds[index][1]=last
                cadence=float(np.median(intervals[good])) if np.any(good) else 15.
                # Target two observation intervals on either side, with a
                # broader cruise scale for long flights. No output fps, film
                # duration or presentation pacing participates in this choice.
                window=min(600.,max(30.,2*cadence,min(duration/120.,300.)))
                self._attitude_support[leg]=(valid,moving,bounds,window)
            valid,moving,bounds,window=self._attitude_support[leg]
            segment=min(len(track[0])-2,max(0,bisect_right(track[0],seconds)-1))
            if not valid[segment]:return level('gap')
            if not moving[segment]:return level('stationary')
            a,b=bounds[segment];lower,upper=track[0][a],track[0][b]
            window=min(window,(upper-lower)/2)
        margin=min(seconds-lower,upper-seconds)
        if margin<=1e-6:return level(mode)
        half_window=min(window,margin)
        current=self.trajectory_state(leg,seconds/duration)
        up=current['position']/np.linalg.norm(current['position'])
        if track is not None:
            # Fixed quadrature cost even for dense ADS-B tracks. Interpolation
            # uses only this contiguous observed/moving run and remains
            # continuous as the physical window crosses a waypoint.
            offsets=np.linspace(-1.,1.,33)
            query=seconds+offsets*half_window
            times,points,altitudes,_=track
            indices=np.clip(np.searchsorted(times,query,side='right')-1,a,b-1)
            fraction=(query-times[indices])/(times[indices+1]-times[indices])
            first,second=points[indices],points[indices+1]
            angle=np.arctan2(np.linalg.norm(np.cross(first,second),axis=-1),
                             np.sum(first*second,axis=-1))
            # sinc form is stable for near-coincident samples.
            positions=((1-fraction)*np.sinc((1-fraction)*angle/np.pi))[:,None]*first
            positions+=(fraction*np.sinc(fraction*angle/np.pi))[:,None]*second
            positions/=np.sinc(angle/np.pi)[:,None]
            cosine=np.clip(positions@up,-1,1)
            tangent=positions-cosine[:,None]*up
            sine=np.linalg.norm(tangent,axis=-1)
            factor=np.divide(np.arctan2(sine,cosine),sine,
                             out=np.ones_like(sine),where=sine>1e-14)
            displacement=tangent*factor[:,None]*6371000.
            heights=altitudes[indices]*(1-fraction)+altitudes[indices+1]*fraction
            design=np.column_stack((np.ones_like(offsets),offsets,offsets*offsets))
            weights=(1-offsets*offsets)**3
            coefficients=np.linalg.solve(design.T@(weights[:,None]*design),
                design.T@(weights[:,None]*np.column_stack((displacement,heights))))
            velocity=coefficients[1,:3]/half_window
            acceleration=2*coefficients[2,:3]/half_window**2
            speed=float(np.linalg.norm(velocity))
            if speed<=1.:return level('stationary')
            lateral=-float(up@np.cross(velocity,acceleration))/speed
            bank=math.degrees(math.atan(lateral/9.80665))
            climb=float(coefficients[1,3]/half_window)
        else:
            before=self.trajectory_state(leg,(seconds-half_window)/duration)
            after=self.trajectory_state(leg,(seconds+half_window)/duration)
            angle=math.atan2(float(np.linalg.norm(np.cross(before['position'],after['position']))),
                             float(before['position']@after['position']))
            speed=angle*6371000./(2*half_window)
            if speed<=1.:return level('stationary')
            bank=0. # An illustrative route is one great-circle segment.
            climb=(after['altitude_m']-before['altitude_m'])/(2*half_window)
        pitch=math.degrees(math.atan2(climb,speed))
        confidence=float(ease(margin/max(30.,window)))
        strength=float(config.get('strength',1.))
        def limited(value,maximum):
            return confidence*maximum*math.tanh(value*strength/maximum) if maximum>0 else 0.
        return {'bank_deg':limited(bank,float(config.get('max_bank_deg',25.))),
                'pitch_deg':limited(pitch,float(config.get('max_pitch_deg',12.))),'mode':mode}

    def aircraft_mix(self, t):
        """One or two aircraft indices and weights, changing within each layover."""
        leg = self.trip.active_leg(t)
        end = self.trip.leg_intervals[leg][1]
        if leg+1 < len(self.trip.legs) and t > end:
            hold = self.trip.leg_intervals[leg+1][0]-end
            amount = float(ease((t-end-hold*.25)/(hold*.5)))
            return [(i, w) for i, w in ((leg, 1-amount), (leg+1, amount)) if w > 0]
        return [(leg, 1.)]
