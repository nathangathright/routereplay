import { Canvas, invalidate, useFrame, useThree } from '@react-three/fiber';
import { type MutableRefObject, type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { EARTH_RADIUS_KM, GreatCircle } from '../../shared/geo/greatCircle';
import { moonPosition, sunDirection } from '../../shared/geo/solar';
import { adaptExposure, meterGlobe, targetExposure } from '../../shared/timeline/exposure';
import { cloudFieldAt, pinnedCloudRun } from '../../shared/weather/gfs';
import { type Vec3, add, cross, dot, normalize, scale } from '../../shared/geo/vec';
import { AIRCRAFT_DESIGNATORS, type AircraftType } from '../../shared/scene/aircraft';
import { Aircraft } from './Aircraft';
import { type EarthTextures, type Quality, currentSurfaceMonth, loadEarthTextures } from './assets';
import { type CloudSet, Clouds, type WeatherStep, cloudFrameAt, loadWeatherStep, releaseWeatherStep } from './Clouds';
import { Atmosphere, Earth } from './Earth';
import { skyLights } from './lighting';
import { Stars } from './Stars';
import { SunlitButton } from './SunlitButton';
import { Moon, Sun, sunVisibleFraction } from './SunAndMoon';

const DEG = Math.PI / 180;
const CAMERA_DISTANCE = 3.4;
const CAMERA_FOV = 32;
/** Where the camera starts: over the middle of the contiguous United States. */
const START_VIEW = { lat: 39.5 * DEG, lon: -98.35 * DEG };
const LAT_RANGE = [-70 * DEG, 80 * DEG] as const;
/** Simulated seconds per real second: a full day and night pass in 96 s. */
const TIME_SCALE = 900;
/** Planes in the air near the view at once; replacements take a moment, so 2–3 are visible. */
const FLIGHTS = 3;
const CRUISE_KMH = 850;
/** Great-circle arc a plane covers per real second, in radians. */
const FLIGHT_RATE = (CRUISE_KMH / EARTH_RADIUS_KM / 3600) * TIME_SCALE;
const FLIGHT_ALTITUDE = 0.006;
/** Each plane flies a great circle this far either side of a point in view (radians). */
const FLIGHT_REACH = 0.9;
/** New planes start at least this far (about 12°) from planes already in the air. */
const MIN_SPACING_COS = Math.cos(12 * DEG);
const HOUR = 3_600_000;
/** Weather steps every 6 simulated hours (one download per 24 s on screen), carried by the wind in between. */
const CLOUD_STEP_HOURS = 6;

/**
 * How far below the camera's line of sight to place the globe so the planet's top edge
 * appears at `horizon`, a fraction of the frame height from the top. The edge is the surface
 * (radius 1): the atmosphere's faint outer glow, which varies with the lighting, sits just above it.
 */
function globeDrop(horizon: number): number {
  const half = (CAMERA_FOV * Math.PI) / 360;
  const below = Math.atan((2 * horizon - 1) * Math.tan(half));
  return (1 + CAMERA_DISTANCE * Math.sin(below)) / Math.cos(below);
}

/**
 * The place the camera hovers over is shown in the middle of the band of Earth visible below
 * the hero. This is how far above the globe's camera-facing equator that middle point is.
 */
function viewLatitude(horizon: number, drop: number): number {
  const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
  const ndcY = (1 - 2 * horizon - 1) / 2; // halfway between the horizon and the bottom edge
  const dir = new THREE.Vector3(0, ndcY * tanHalf, -1).normalize();
  const hit = new THREE.Ray(new THREE.Vector3(0, 0, CAMERA_DISTANCE), dir).intersectSphere(
    new THREE.Sphere(new THREE.Vector3(0, -drop, 0), 1),
    new THREE.Vector3(),
  );
  if (!hit) return 45 * DEG;
  return Math.atan2(hit.y + drop, hit.z);
}

/** Where the camera hovers (radians), plus the momentum a flick leaves behind. */
interface View {
  lat: number;
  lon: number;
  vLat: number;
  vLon: number;
  dragging: boolean;
}

interface Flight {
  id: number;
  /** Any type in the library, so the homepage shows them off. */
  type: AircraftType;
  circle: GreatCircle;
  /** Progress along the circle, 0 to 1. */
  f: number;
  /** Whether it has been on screen yet: once it leaves, it's retired. */
  seen: boolean;
  born: number;
}

const clampLat = (lat: number) => Math.min(LAT_RANGE[1], Math.max(LAT_RANGE[0], lat));
const toThree = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);

/**
 * An endless, live Earth: the real Sun, Moon, sunlight, and turning sky for an accelerated clock that starts now,
 * seen from a camera that stays over one place (the globe never drifts on its own), with a few
 * unlabelled planes crossing the view.
 */
function LiveEarth({
  textures,
  horizon,
  view,
  animate,
  sunlitTarget,
}: {
  textures: EarthTextures;
  horizon: number;
  view: MutableRefObject<View>;
  animate: boolean;
  sunlitTarget?: RefObject<HTMLElement | null>;
}) {
  const { camera, gl } = useThree();
  const globe = useRef<THREE.Group>(null);
  // The camera's exposure, metered on the globe in view and adapting as a camera does (Reinhard tone mapping).
  const exposure = useRef(0);
  // Stars and the Sun ride with the camera so they sit at infinity.
  const sky = useRef<THREE.Group>(null);
  const sunVisible = useRef(1);
  const [startUtc] = useState(() => Date.now());
  // Real clouds: today's weather-model run, loaded a step ahead of the clock.
  const cloudRun = useMemo(() => pinnedCloudRun(startUtc), [startUtc]);
  const cloudSteps = useRef(new Map<number, WeatherStep>());
  const cloudRequested = useRef(new Set<number>());
  const cloudFade = useRef(0);
  const clock = useRef(0);
  const flights = useRef<Flight[]>([]);
  const nextSpawn = useRef(-1);
  const nextId = useRef(0);
  const [, setFrame] = useState(0);
  const drop = globeDrop(horizon);
  const centreLatitude = useMemo(() => viewLatitude(horizon, drop), [horizon, drop]);
  const reach = Math.hypot(CAMERA_DISTANCE, drop) - 1;
  const tools = useMemo(() => ({ ray: new THREE.Raycaster(), sphere: new THREE.Sphere(), ndc: new THREE.Vector2() }), []);
  // Sunlight on the planes points at the Earth's center, which is only the world origin before the globe is moved.
  const lightTarget = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    const g = globe.current;
    if (!g) return;
    const dt = Math.min(delta, 0.1);
    const v = view.current;
    if (!v.dragging && (v.vLat || v.vLon)) {
      // A flick keeps turning the globe briefly, then the camera settles over the new place.
      v.lon += v.vLon * dt;
      v.lat = clampLat(v.lat + v.vLat * dt);
      const k = Math.exp(-4 * dt);
      v.vLon *= k;
      v.vLat *= k;
      if (Math.abs(v.vLon) + Math.abs(v.vLat) < 0.002) v.vLon = v.vLat = 0;
      else if (!animate) invalidate();
    }
    if (animate) clock.current += dt;
    const nowUtc = startUtc + clock.current * 1000 * TIME_SCALE;
    const step = CLOUD_STEP_HOURS * HOUR;
    // The two steps around now, and the next once we're halfway to it.
    const current = Math.floor(nowUtc / step) * step;
    const wanted = [current, current + step, ...(nowUtc - current > step / 2 ? [current + 2 * step] : [])];
    for (const v of wanted) {
      if (cloudRequested.current.has(v)) continue;
      cloudRequested.current.add(v);
      const field = cloudFieldAt(v, cloudRun);
      if (field) {
        void loadWeatherStep(field).then((s) => {
          if (!s) return;
          cloudSteps.current.set(v, s);
          invalidate(); // a paused scene redraws once with the new clouds
        });
      }
    }
    // Steps already passed are let go, textures and all.
    for (const v of cloudSteps.current.keys()) {
      if (v >= current) continue;
      cloudSteps.current.delete(v);
      cloudRequested.current.delete(v);
      const field = cloudFieldAt(v, cloudRun);
      if (field) releaseWeatherStep(field);
    }
    // Clouds fade in when they first arrive; without motion they simply appear.
    if (cloudSteps.current.size) cloudFade.current = animate ? Math.min(1, cloudFade.current + dt / 1.5) : 1;

    g.position.set(0, -drop, 0);
    g.rotation.set(v.lat - centreLatitude, -Math.PI / 2 - v.lon, 0);
    g.updateMatrixWorld(true);
    const cameraLocal = g.worldToLocal(camera.position.clone());
    sky.current?.position.copy(cameraLocal);
    const sunNow = sunDirection(startUtc + clock.current * 1000 * TIME_SCALE);
    sunVisible.current = sunVisibleFraction([cameraLocal.x, cameraLocal.y, cameraLocal.z], sunNow);
    const inverse = g.quaternion.clone().invert();
    const forward = camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(inverse);
    const up = camera.up.clone().applyQuaternion(inverse);
    const target = targetExposure(
      meterGlobe([cameraLocal.x, cameraLocal.y, cameraLocal.z], [forward.x, forward.y, forward.z], [up.x, up.y, up.z], Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360), sunNow),
    );
    exposure.current = exposure.current && animate ? adaptExposure(exposure.current, target, dt) : target;
    gl.toneMappingExposure = exposure.current;
    const onScreen = (p: Vec3) => {
      if (p[0] * cameraLocal.x + p[1] * cameraLocal.y + p[2] * cameraLocal.z < 1.02) return false; // behind the horizon
      const ndc = g.localToWorld(toThree(p)).project(camera);
      return Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1;
    };

    /** A great circle through a random visible point, entering from off screen (or already in view). */
    const spawn = (inView: boolean): Flight | null => {
      tools.sphere.set(g.getWorldPosition(new THREE.Vector3()), 1);
      const horizonNdc = 1 - 2 * horizon;
      // Aim through the lower three-quarters of the visible Earth, away from the horizon.
      const top = horizonNdc - 0.25 * (horizonNdc + 1);
      for (let attempt = 0; attempt < 12; attempt++) {
        tools.ndc.set(Math.random() * 1.5 - 0.75, -0.9 + Math.random() * Math.max(0.1, top + 0.9));
        tools.ray.setFromCamera(tools.ndc, camera);
        const hit = tools.ray.ray.intersectSphere(tools.sphere, new THREE.Vector3());
        if (!hit) continue;
        const l = g.worldToLocal(hit);
        const through = normalize([l.x, l.y, l.z]);
        // Keep planes apart so they read as separate flights.
        if (flights.current.some((fl) => fl.f <= 1 && dot(fl.circle.at(fl.f), through) > MIN_SPACING_COS)) continue;
        const east = normalize(cross([0, 1, 0], through), [0, 0, 1]);
        const north = cross(through, east);
        // Roughly east or west, so planes cross the screen side to side rather than over the horizon.
        const bearing = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 70 * DEG;
        const dir = add(scale(east, Math.cos(bearing)), scale(north, Math.sin(bearing)));
        const from = add(scale(through, Math.cos(FLIGHT_REACH)), scale(dir, -Math.sin(FLIGHT_REACH)));
        const to = add(scale(through, Math.cos(FLIGHT_REACH)), scale(dir, Math.sin(FLIGHT_REACH)));
        const circle = new GreatCircle(from, to);
        let f = 0.5 + (Math.random() - 0.5) * 0.3;
        if (!inView) {
          // Start just outside the frame so the plane flies in rather than appearing.
          f = 0;
          for (let s = 0.5; s >= 0; s -= 0.01) {
            if (!onScreen(circle.at(s))) {
              f = s;
              break;
            }
          }
        }
        const type = AIRCRAFT_DESIGNATORS[Math.floor(Math.random() * AIRCRAFT_DESIGNATORS.length)]!;
        return { id: nextId.current++, type, circle, f, seen: false, born: clock.current };
      }
      return null;
    };

    // Planes: fly, retire once they have left the view, and replace them from just off screen.
    for (const fl of flights.current) {
      if (animate) fl.f += (FLIGHT_RATE * dt) / fl.circle.angle;
      const visible = fl.f < 1 && onScreen(fl.circle.at(fl.f));
      if (visible) fl.seen = true;
      if (fl.f >= 1 || (fl.seen && !visible) || (!fl.seen && clock.current - fl.born > 8)) fl.f = Infinity;
    }
    flights.current = flights.current.filter((fl) => fl.f !== Infinity);
    // The first planes start in view; later ones fly in. Without motion, planes are placed in view.
    const opening = nextSpawn.current < 0;
    // Without motion the clock stands still, so replacements can't wait on it: fill the view at once.
    while (flights.current.length < FLIGHTS && (clock.current >= nextSpawn.current || !animate)) {
      const fl = spawn(opening || !animate);
      if (!fl) break;
      flights.current.push(fl);
      if (!opening) nextSpawn.current = clock.current + 1 + Math.random() * 3;
    }
    if (opening) nextSpawn.current = 0;
    setFrame((n) => n + 1);
  });

  const utc = startUtc + clock.current * 1000 * TIME_SCALE;
  const lights = skyLights(utc);
  const sun = lights.sun;
  const cloudSet: CloudSet = { stepHours: CLOUD_STEP_HOURS, steps: cloudSteps.current, originMs: startUtc };
  const cloudFrame = cloudFrameAt(cloudSet, utc);
  const clouds = cloudFrame && { ...cloudFrame, presence: cloudFrame.presence * cloudFade.current };
  // Everything lives in the Earth's frame, so the Sun, Moon, stars, sunlight, and planes stay true
  // to the clock while the globe is turned to put the camera's place in front.
  return (
    <>
      <group ref={globe}>
        <group ref={sky}>
          <Stars seed={7} utcMs={utc} />
          <Sun direction={sun} visible={sunVisible.current} />
        </group>
        <Moon position={moonPosition(utc)} sun={sun} />
        <ambientLight intensity={0.5} />
        <primitive object={lightTarget} />
        <directionalLight position={scale(sun, 10) as [number, number, number]} target={lightTarget} intensity={2.4} />
        <Earth textures={textures} lights={lights} segments={128} clouds={clouds} />
        {clouds && <Clouds frame={clouds} lights={lights} night={textures.night} segments={128} />}
        <Atmosphere sun={sun} segments={96} />
        {flights.current.map((fl) => (
          <Aircraft
            key={fl.id}
            type={fl.type}
            ground={fl.circle.at(fl.f)}
            heading={fl.circle.tangent(fl.f)}
            altitude={FLIGHT_ALTITUDE}
            size={0.024 * reach}
            sun={sun}
            clock={performance.now() / 1000}
          />
        ))}
      </group>
      {sunlitTarget && <SunlitButton target={sunlitTarget} globe={globe} sun={sun} utcMs={utc} sunVisible={sunVisible.current} />}
    </>
  );
}

/**
 * `horizon`: where Earth's top edge should sit, as a fraction of the frame height from the top.
 * `sunlitTarget`: a button over the globe to paint as an object lit by the scene (SunlitButton).
 */
export function IdleEarth({
  quality,
  horizon,
  sunlitTarget,
}: {
  quality: Quality;
  horizon: number;
  sunlitTarget?: RefObject<HTMLElement | null>;
}) {
  const [textures, setTextures] = useState<EarthTextures | null>(null);
  useEffect(() => {
    let alive = true;
    let release: ReturnType<typeof setTimeout> | undefined;
    // This month's surface. Show the light set immediately, then upgrade on capable devices.
    const month = currentSurfaceMonth();
    loadEarthTextures('low', month)
      .then((low) => {
        if (alive) setTextures(low);
        if (quality !== 'standard') return;
        return loadEarthTextures('standard', month).then((t) => {
          if (!alive) return;
          setTextures(t);
          // Once the sharper set is on screen, free the light set's GPU copies (the day textures are large).
          // three.js uploads them again if anything uses them later.
          release = setTimeout(() => {
            for (const k of ['day', 'night', 'water'] as const) if (low[k] !== t[k]) low[k].dispose();
          }, 2000);
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      clearTimeout(release);
    };
  }, [quality]);
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Rest when unseen: stop the render loop while the globe is off screen or the tab is hidden.
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let onScreen = true;
    const update = () => setVisible(onScreen && !document.hidden);
    const io = typeof IntersectionObserver !== 'undefined' && container.current
      ? new IntersectionObserver(([entry]) => { onScreen = !!entry?.isIntersecting; update(); })
      : null;
    if (io && container.current) io.observe(container.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      io?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  // Dragging moves the camera to hover over a new place; the surface follows the pointer,
  // which looks like spinning the globe. A flick carries on briefly.
  const view = useRef<View>({ ...START_VIEW, vLat: 0, vLon: 0, dragging: false });
  const drag = useRef<{ x: number; y: number; time: number; id: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, time: e.timeStamp, id: e.pointerId };
    view.current.dragging = true;
    view.current.vLat = view.current.vLon = 0;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture only keeps the drag alive outside the element; dragging works without it.
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // About one globe radius of drag per radian, so the surface stays roughly under the pointer.
    const perPx = 2 / Math.max(1, e.currentTarget.clientHeight);
    const dLon = -(e.clientX - d.x) * perPx;
    const dLat = (e.clientY - d.y) * perPx;
    const v = view.current;
    v.lon += dLon;
    v.lat = clampLat(v.lat + dLat);
    const seconds = Math.max(0.008, (e.timeStamp - d.time) / 1000);
    v.vLon = v.vLon * 0.5 + (dLon / seconds) * 0.5;
    v.vLat = v.vLat * 0.5 + (dLat / seconds) * 0.5;
    drag.current = { x: e.clientX, y: e.clientY, time: e.timeStamp, id: d.id };
    invalidate();
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    // A pause before letting go means no flick.
    if (e.timeStamp - drag.current.time > 80) view.current.vLat = view.current.vLon = 0;
    drag.current = null;
    view.current.dragging = false;
    invalidate();
  };

  // A two-finger trackpad drag arrives as wheel events, not pointer events. It moves the view like a drag
  // anywhere on the page, which never scrolls (.landing in styles.css). The system sends its own momentum
  // afterwards, so there is no flick. A pinch (ctrlKey) stays the browser's zoom. Handling the event also keeps
  // a sideways swipe from going back in history.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (!dx && !dy) return;
      e.preventDefault();
      // The same scale as a drag; scrolling right or down moves the view east or south, so the surface
      // follows the fingers with natural scrolling.
      const perPx = 2 / Math.max(1, container.current?.clientHeight ?? window.innerHeight);
      const v = view.current;
      v.vLat = v.vLon = 0;
      v.lon += dx * perPx;
      v.lat = clampLat(v.lat - dy * perPx);
      invalidate();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={container}
      className="globe-scrub"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <Canvas
        dpr={[1, quality === 'standard' ? 2 : 1]}
        camera={{ fov: CAMERA_FOV, near: 0.1, far: 200, position: [0, 0, CAMERA_DISTANCE] }}
        frameloop={reduceMotion || !visible ? 'demand' : 'always'}
        gl={{ antialias: true, toneMapping: THREE.ReinhardToneMapping }}
        aria-hidden="true"
      >
        <color attach="background" args={['#02040a']} />
        {textures && <LiveEarth textures={textures} horizon={horizon} view={view} animate={!reduceMotion} sunlitTarget={sunlitTarget} />}
      </Canvas>
    </div>
  );
}
