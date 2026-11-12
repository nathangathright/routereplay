import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../shared/geo/vec';
import { type LabelState, visibleLabelOpacity } from '../../shared/timeline/evaluate';
import { LABEL_FONT_FAMILY } from './assets';

interface LabelTexture {
  texture: THREE.CanvasTexture;
  aspect: number;
}

function drawLabel(code: string): LabelTexture {
  const h = 128;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `700 80px ${LABEL_FONT_FAMILY}, "Avenir Next", "Segoe UI", system-ui, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(code).width + code.length * 6;
  const w = Math.ceil(textW + 64);
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  const r = 30;
  c.beginPath();
  c.roundRect(4, 4, w - 8, h - 8, r);
  c.fillStyle = 'rgba(8, 12, 22, 0.82)';
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(255, 199, 107, 0.75)';
  c.stroke();
  c.font = font;
  c.letterSpacing = '6px';
  c.fillStyle = '#ffffff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(code, w / 2 + 3, h / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: w / h };
}

function drawDot(): THREE.CanvasTexture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const c = canvas.getContext('2d')!;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.32, 0, Math.PI * 2);
  c.fillStyle = '#ffc76b';
  c.fill();
  c.lineWidth = s * 0.1;
  c.strokeStyle = 'rgba(8, 12, 22, 0.9)';
  c.stroke();
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Fraction of the frame height an airport label uses at a viewport of the given width ÷ height, for phone
 * legibility: 0.085 at 16:9, 0.065 square, 0.046 at 9:16, blended in between and held beyond.
 */
export function labelHeightFor(aspect: number): number {
  const wide = 16 / 9;
  const tall = 9 / 16;
  const a = Math.min(wide, Math.max(tall, Number.isFinite(aspect) && aspect > 0 ? aspect : wide));
  return a >= 1
    ? 0.065 + (0.085 - 0.065) * (Math.log(a) / Math.log(wide))
    : 0.046 + (0.065 - 0.046) * (Math.log(a / tall) / Math.log(1 / tall));
}

export function Labels({
  labels,
  codes,
  camera,
  fovDeg,
  heightFraction,
  lift,
}: {
  labels: LabelState[];
  codes: string[];
  camera: Vec3;
  fovDeg: number;
  heightFraction: number;
  /** Label offset above its airport, in label heights; larger when the aircraft sits on the anchor. */
  lift: number;
}) {
  const textures = useMemo(() => new Map(codes.map((c) => [c, drawLabel(c)])), [codes]);
  const dotTexture = useMemo(drawDot, []);
  const materials = useMemo(() => new Map<number, { label: THREE.SpriteMaterial; dot: THREE.SpriteMaterial }>(), []);
  const viewScale = 2 * Math.tan(((fovDeg * Math.PI) / 180) / 2);
  return (
    <group>
      {labels.map((l) => {
        const tex = textures.get(l.code);
        if (!tex) return null;
        const opacity = visibleLabelOpacity(l, camera);
        if (opacity <= 0.001) return null;
        let m = materials.get(l.index);
        if (!m) {
          m = {
            label: new THREE.SpriteMaterial({ map: tex.texture, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }),
            dot: new THREE.SpriteMaterial({ map: dotTexture, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }),
          };
          materials.set(l.index, m);
        }
        m.label.map = tex.texture;
        m.label.opacity = opacity;
        m.dot.opacity = opacity;
        const h = heightFraction * viewScale;
        const p = l.position;
        return (
          <group key={l.index} position={[p[0] * 1.002, p[1] * 1.002, p[2] * 1.002]}>
            <sprite material={m.dot} scale={[h * 0.32, h * 0.32, 1]} renderOrder={10} />
            <sprite material={m.label} scale={[h * tex.aspect, h, 1]} center={new THREE.Vector2(0.5, -lift)} renderOrder={11} />
          </group>
        );
      })}
    </group>
  );
}
