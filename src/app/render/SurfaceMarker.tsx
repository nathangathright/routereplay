import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../shared/geo/vec';
import { ROUTE_COLOR } from './Routes';

/** The marker's diameter as a fraction of the frame's short side: well under the aircraft, well over an airport's dot. */
export const MARKER_SHORT_SIDE_FRACTION = 0.042;

function drawMarker(): THREE.CanvasTexture {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const c = canvas.getContext('2d')!;
  const mid = s / 2;
  // A soft halo keeps it legible over bright ground and cloud.
  const halo = c.createRadialGradient(mid, mid, s * 0.2, mid, mid, s * 0.5);
  halo.addColorStop(0, 'rgba(8, 12, 22, 0.55)');
  halo.addColorStop(1, 'rgba(8, 12, 22, 0)');
  c.fillStyle = halo;
  c.fillRect(0, 0, s, s);
  c.beginPath();
  c.arc(mid, mid, s * 0.3, 0, Math.PI * 2);
  c.fillStyle = ROUTE_COLOR;
  c.fill();
  c.beginPath();
  c.arc(mid, mid, s * 0.17, 0, Math.PI * 2);
  c.fillStyle = '#ffffff';
  c.fill();
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The traveller on a train, bus, car, or ferry leg: one marker for every mode, the same size on screen at any
 * zoom, drawn over clouds as the aircraft is. `size` is its diameter in world units at its distance from the
 * camera. `opacity` below 1 dissolves it into or out of an aircraft at a connection.
 */
export function SurfaceMarker({ ground, size, opacity = 1 }: { ground: Vec3; size: number; opacity?: number }) {
  const material = useMemo(
    () =>
      new THREE.SpriteMaterial({ map: drawMarker(), depthTest: false, depthWrite: false, transparent: true, toneMapped: false }),
    [],
  );
  useEffect(
    () => () => {
      material.map?.dispose();
      material.dispose();
    },
    [material],
  );
  material.opacity = opacity;
  const r = 1.002;
  // Above the airport dots (render order 10), so at a stop the marker covers the dot it waits on instead of
  // merging into it, but under the label panels (11), as the aircraft is: arriving, the marker can pass beneath
  // the destination's label, and the code must stay readable.
  return (
    <sprite
      material={material}
      position={[ground[0] * r, ground[1] * r, ground[2] * r]}
      scale={[size, size, 1]}
      renderOrder={10.5}
      frustumCulled={false}
    />
  );
}
