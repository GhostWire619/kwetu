/**
 * Kwetu shell — procedural textures for the placeholder test world.
 *
 * [PLACEHOLDER — ADR-003] every texture here is generated at runtime on a
 * 2D canvas: no image assets, no load cost, no fidelity claim. They exist so
 * camera-relative motion is visible (graticule/checker) and the Sun reads as
 * a disc (billboard gradient). ADR-003 lands the real planet basemap/LOD
 * strategy; ASSET_STRATEGY.md owns the real asset pipeline.
 */
import * as THREE from 'three';

/** Earth graticule + 15 deg checker, equirectangular 2:1. */
export function makeEarthTexture(): THREE.CanvasTexture {
  const width = 2048;
  const height = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('textures: 2D canvas context unavailable');

  // Ocean base + 15-degree checker (24 x 12 cells) — motion needs texture
  // variation at every flight scale, and the checker gives coarse parallax.
  ctx.fillStyle = '#0b2e4f';
  ctx.fillRect(0, 0, width, height);
  const cellW = width / 24;
  const cellH = height / 12;
  ctx.fillStyle = '#10406b';
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 12; j++) {
      if ((i + j) % 2 === 0) {
        ctx.fillRect(i * cellW, j * cellH, cellW, cellH);
      }
    }
  }

  // Graticule every 15 degrees.
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const x = (i * width) / 24;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let j = 0; j <= 12; j++) {
    const y = (j * height) / 12;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Equator and prime meridian, brighter — fixed reference lines.
  ctx.strokeStyle = 'rgba(255,215,80,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, height);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Radial-gradient Sun billboard sprite (constant angular size, not physical). */
export function makeSunSpriteTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('textures: 2D canvas context unavailable');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,240,1)');
  gradient.addColorStop(0.25, 'rgba(255,240,180,0.95)');
  gradient.addColorStop(0.6, 'rgba(255,180,80,0.35)');
  gradient.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
