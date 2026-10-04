/**
 * Raw WebGL globe renderer — no external 3D dependency.
 *
 * A real UV-sphere mesh with:
 *   - a base albedo texture (terrain colours, ice, vegetation, hillshading)
 *   - a data overlay texture, colormapped on the GPU through a 1D LUT texture
 *   - day/night terminator, a faint atmosphere rim, optional graticule
 *
 * Layer switching only re-uploads a 1x256 colormap plus the small data texture,
 * never the base map.
 */

import { LAYERS, rampLut } from '../core/colors.js';

const VERT = `
attribute vec3 aPos;
attribute vec2 aUv;

uniform mat4 uMvp;
uniform float uRadius;

varying vec3 vDir;
varying vec2 vUv;

void main() {
  vDir = normalize(aPos);
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos * uRadius, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform sampler2D uBase;
uniform sampler2D uOverlay;
uniform sampler2D uLut;
uniform vec4 uLight;      // x,y,z = sun direction, w = 1 when the day/night terminator is on
uniform vec4 uParams;     // x = atmosphere, y = graticule, z = overlayActive, w = overlay opacity
uniform vec4 uLutRange;   // x = vMin, y = vMax, z = valid-mask threshold, w = unused
uniform float uTint;

varying vec3 vDir;
varying vec2 vUv;

const float PI = 3.14159265359;

void main() {
  vec3 n = normalize(vDir);
  vec2 uv = vUv;

  vec3 outc = texture2D(uBase, uv).rgb;

  // --- data overlay -------------------------------------------------------
  if (uParams.z > 0.5) {
    vec4 ov = texture2D(uOverlay, uv);
    float mask = step(uLutRange.z, ov.b);
    float k = (ov.r * 255.0 * 256.0 + ov.g * 255.0) / 65535.0;
    float t = clamp(k, 0.0, 1.0);
    vec3 mapped = texture2D(uLut, vec2(t * 0.98 + 0.01, 0.5)).rgb;
    outc = mix(outc, mapped, clamp(uParams.w * mask, 0.0, 0.95));
  } else {
    outc = mix(outc, outc * vec3(1.02, 0.99, 0.97), uTint);
  }

  // --- lighting -----------------------------------------------------------
  // uLight.w == 0 turns the terminator off and renders every point fully lit,
  // which is what you want when reading a data layer rather than admiring the
  // day/night shading.
  float term = 1.0;
  float shading = 1.05;
  if (uLight.w > 0.5) {
    float ndl = dot(n, normalize(uLight.xyz));
    term = smoothstep(-0.12, 0.24, ndl);
    shading = mix(0.34, 1.05, term);
  }
  outc *= shading;

  // limb darkening for depth
  float rim = pow(1.0 - abs(dot(n, vec3(0.0, 0.0, 1.0))), 1.7);
  outc *= 1.0 - 0.15 * rim;

  // --- atmosphere halo ---------------------------------------------------
  if (uParams.x > 0.001) {
    float edge = pow(1.0 - abs(dot(n, vec3(0.0, 0.0, 1.0))), 3.0);
    outc += vec3(0.15, 0.26, 0.40) * edge * uParams.x * (0.35 + 0.65 * term);
  }

  // --- graticule ---------------------------------------------------------
  if (uParams.y > 0.5) {
    float lat = asin(clamp(n.z, -1.0, 1.0)) / PI * 180.0;
    float lon = atan(n.y, n.x) / PI * 180.0;
    float gl = abs(fract(lat / 15.0 + 0.5) - 0.5) * 15.0;
    float gn = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0;
    float grid = smoothstep(0.4, 0.0, min(gl, gn));
    float eq = smoothstep(1.4, 0.0, abs(lat));
    outc = mix(outc, vec3(0.72, 0.80, 0.88), grid * 0.15 + eq * 0.10);
  }

  gl_FragColor = vec4(outc, 1.0);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

function link(gl, vert, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('program link failed: ' + log);
  }
  return p;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/**
 * UV sphere: rings along latitude, segments along longitude.
 *
 * The UVs must span the *whole* texture: `u = i / segments` runs 0…1 over the
 * full 360° and `v = j / rings` runs 0…1 pole to pole. The previous
 * `(i + 0.5) / (segments + 1)` convention (texel centres of a grid the mesh does
 * not have) left the last mesh column and the polar rings unsampled, so ~2.5° of
 * longitude at the antimeridian was dropped and the map looked stitched together
 * with an offset seam.
 */
function buildSphere(rings = 72, segments = 144) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;              // 0 at north pole
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = sinPhi * Math.cos(theta);
      const y = sinPhi * Math.sin(theta);
      const z = cosPhi;
      positions.push(x, y, z);
      uvs.push(i / segments, j / rings);
    }
  }
  const stride = segments + 1;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices.length > 65535 ? new Uint32Array(indices) : indices),
    indexCount: indices.length,
  };
}

export class GlobeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.error = null;
    this.rot = { yaw: -0.55, pitch: 0.34, dist: 3.0 };
    this.sun = { hour: 12, showNight: true, shadow: true };
    this.state = {
      overlay: 'none', base: 'surface', graticule: false,
      atmosphere: true, spin: false, nightLights: 0.5, tempTint: 0.35,
    };
    this.overlayOpacity = 0.74;
    this.lutName = null;
    this._init();
  }

  _init() {
    const opts = { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: true, premultipliedAlpha: false };
    const gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    if (!gl) { this.error = 'WebGL 不可用'; return; }
    this.gl = gl;
    try {
      this.program = link(gl, VERT, FRAG);
    } catch (e) {
      this.error = e.message;
      console.error(e);
      return;
    }
    const p = this.program;
    this.attr = {
      pos: gl.getAttribLocation(p, 'aPos'),
      uv: gl.getAttribLocation(p, 'aUv'),
    };
    this.uni = {};
    for (const name of ['uMvp', 'uRadius', 'uBase', 'uOverlay', 'uLut', 'uLight', 'uParams', 'uLutRange', 'uTint']) {
      this.uni[name] = gl.getUniformLocation(p, name);
    }

    const mesh = buildSphere(72, 144);
    this.vertexCount = mesh.indexCount;
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    // interleaved: x,y,z,u,v
    const interleaved = new Float32Array(mesh.positions.length / 3 * 5);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      interleaved[i * 5] = mesh.positions[i * 3];
      interleaved[i * 5 + 1] = mesh.positions[i * 3 + 1];
      interleaved[i * 5 + 2] = mesh.positions[i * 3 + 2];
      interleaved[i * 5 + 3] = mesh.uvs[i * 2];
      interleaved[i * 5 + 4] = mesh.uvs[i * 2 + 1];
    }
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.indexType = mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    if (this.indexType === gl.UNSIGNED_INT && !gl.getExtension('OES_element_index_uint')) {
      this.error = 'WebGL 缺少 32 位索引支持';
      return;
    }

    this.texBase = this._newTexture();
    this.texOverlay = this._newTexture();
    this.texLut = this._newTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(256 * 3));

    gl.clearColor(0.028, 0.036, 0.047, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.ok = true;
    this.resize();
  }

  _newTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // WebGL1 only allows REPEAT / mipmapping on power-of-two textures. The
    // equirectangular maps are 360x180, so we must use CLAMP_TO_EDGE with
    // LINEAR filtering — anything else makes the texture incomplete, and an
    // incomplete texture samples as solid black.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  resize() {
    if (!this.gl) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const parent = this.canvas.parentElement;
    const cssW = this.canvas.clientWidth || parent?.clientWidth || 800;
    const cssH = this.canvas.clientHeight || parent?.clientHeight || 600;
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this.aspect = w / h;
  }

  /* ---------------- texture uploads ---------------- */

  /**
   * Upload the base map as a GX+1 wide texture whose extra column repeats column
   * 0. WebGL1 forbids REPEAT on non-power-of-two textures (an NPOT texture with
   * REPEAT is incomplete and samples as black), so the map is clamped instead —
   * and clamping without the duplicated column leaves a one-texel discontinuity
   * exactly at the antimeridian. The duplicate makes u = 1 land on a copy of
   * column 0, so the seam interpolates correctly.
   */
  uploadBase(rgba, GX, GY) {
    if (!this.ok) return;
    const gl = this.gl;
    const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer || rgba);
    const w = GX + 1;
    const buf = new Uint8Array(w * GY * 4);
    for (let y = 0; y < GY; y++) {
      const rowIn = y * GX * 4;
      const rowOut = y * w * 4;
      buf.set(src.subarray(rowIn, rowIn + GX * 4), rowOut);
      buf.set(src.subarray(rowIn, rowIn + 4), rowOut + GX * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texBase);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, GY, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.baseSize = [GX, GY];
  }

  /** Upload a data layer as a 16-bit value texture (blue channel = valid mask). */
  uploadOverlay(values, GX, GY, range) {
    if (!this.ok) return;
    const gl = this.gl;
    const w = GX + 1;                       // see uploadBase: duplicated wrap column
    if (!this._overlayBuf || this._overlayKey !== `${GX}x${GY}`) {
      this._overlayBuf = new Uint8Array(w * GY * 4);
      this._overlayKey = `${GX}x${GY}`;
      this._blank = true;
    }
    const buf = this._overlayBuf;
    const span = Math.max(1e-6, range.max - range.min);
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < w; x++) {
        const xi = x < GX ? x : 0;          // wrap column
        const v = values[xi + y * GX];
        const o = (x + y * w) * 4;
        if (!isFinite(v)) { buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 255; continue; }
        const t = Math.max(0, Math.min(1, (v - range.min) / span));
        const q = Math.round(t * 65535);
        buf[o] = (q >> 8) & 0xff;
        buf[o + 1] = q & 0xff;
        buf[o + 2] = 255;
        buf[o + 3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texOverlay);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, GY, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.overlayRange = range;
    this._blank = false;
  }

  /**
   * `rampFn` lets the caller substitute the user's chosen colourbar; without it
   * the layer's registered default ramp is used.
   */
  uploadLut(layerKey, rampFn) {
    if (!this.ok) return;
    const layer = LAYERS[layerKey] || LAYERS.none;
    const fn = rampFn || layer.ramp;
    if (layer.kind === 'none' || !fn) { this.lutName = null; return; }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, rampLut(fn, 256));
    this.lutName = layerKey;
    this.lutRampId = rampFn ? 'custom' : 'default';
  }

  /* ---------------- interaction ---------------- */

  setState(patch) { Object.assign(this.state, patch); }

  /**
   * Default oblique view: centred on ~30°N / 0°E with the north pole visible
   * near the top. In this parametrisation `pitch = 90° − centred latitude` and
   * `yaw = centred longitude − 90°`, so pitch = 60° centres 30°N.
   */
  resetView() {
    this.rot.yaw = -Math.PI / 2;
    this.rot.pitch = Math.PI / 3;
    this.rot.dist = 3.0;
  }

  /**
   * Jump the camera to a named orientation.
   *
   * The camera sits on +z looking at the origin, and `yaw`/`pitch` are applied to
   * the *planet* (Rx(-pitch)·Ry(yaw)). A point is therefore centred on screen
   * exactly when its rotated position is (0,0,1), which gives:
   *
   *   north pole            pitch = 0                (the rotation axis points at the camera)
   *   equator at longitude λ pitch = +π/2, yaw = λ − π/2
   *   south pole            pitch = π                (the planet is turned over)
   *
   * so "赤道 / 北极 / 南极" really do put the equator region / the north pole /
   * the south pole in the middle of the viewport.
   */
  setViewPreset(name, lon = 0) {
    const lam = (((lon + 180) % 360) + 360) % 360 - 180;
    const lamRad = lam * Math.PI / 180;
    switch (name) {
      case 'northPole':
        this.rot.pitch = 0;
        this.rot.yaw = lamRad + Math.PI;
        break;
      case 'southPole':
        this.rot.pitch = Math.PI;
        this.rot.yaw = lamRad + Math.PI;
        break;
      case 'equator':
        // −π/2 rather than +π/2 so the northern hemisphere stays *up* on screen
        this.rot.pitch = -Math.PI / 2;
        this.rot.yaw = lamRad + Math.PI / 2;
        break;
      case 'globe':
      default:
        this.resetView();
        return;
    }
    this.rot.dist = Math.min(this.rot.dist, 3.2);
  }

  /** Pitch limits for dragging: the pole-on views sit at 0 and π. */
  static pitchRange() { return { min: 0, max: Math.PI }; }

  zoomBy(factor) { this.rot.dist = Math.max(1.22, Math.min(9, this.rot.dist * factor)); }

  sunDirection() {
    const t = (this.sun.hour / 24) * Math.PI * 2;
    const tilt = 0.41;
    return [Math.cos(t) * Math.cos(tilt), Math.sin(t) * Math.cos(tilt), Math.sin(tilt)];
  }

  /** Model -> world rotation, applied to a point or direction. */
  _rotate(v) {
    const cy = Math.cos(this.rot.yaw), sy = Math.sin(this.rot.yaw);
    const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
    // R = Rx(-pitch) · Ry(yaw): spin the planet about its own axis first, then tilt
    const x = cy * v[0] + sy * v[1];
    const y = -sy * v[0] + cy * v[1];
    const z = v[2];
    return [x, cp * y - sp * z, sp * y + cp * z];
  }

  _mvp() {
    const d = this.rot.dist;
    const proj = perspective(0.62, this.aspect || 1.6, 0.1, 60);
    const cy = Math.cos(this.rot.yaw), sy = Math.sin(this.rot.yaw);
    const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
    // column-major Rx(-pitch)·Ry(yaw)
    const rot = [
      cy, -sy * cp, -sy * sp,
      sy, cy * cp, cy * sp,
      0, -sp, cp,
    ];
    // view translation
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -d, 1];
    const mv = multiply(view, rot4(rot));
    return multiply(proj, mv);
  }

  /**
   * Project a lat/lon to canvas pixels.
   *
   * `_mvp()` already contains the rotation, so this must use the *object-space*
   * unit vector — feeding it the rotated one applied the rotation twice, which
   * put every overlay drawn on the globe (probe markers, wind/current arrows,
   * the editor's brush ring) at a wrong position.
   */
  project(lat, lon) {
    if (!this.ok) return null;
    const v = this._objectVector(lat, lon);
    const m = this._mvp();
    const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
    const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    if (w <= 1e-4) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (x / w * 0.5 + 0.5) * rect.width,
      y: (0.5 - y / w * 0.5) * rect.height,
      facing: this._facing(lat, lon),
    };
  }

  /** Unit vector in the planet's own frame (no camera rotation). */
  _objectVector(lat, lon) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const cl = Math.cos(la);
    return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
  }

  /** Unit vector in camera space (rotation applied). */
  _unitVector(lat, lon) {
    return this._rotate(this._objectVector(lat, lon));
  }

  _facing(lat, lon) {
    const v = this._unitVector(lat, lon);
    const cam = [0, 0, this.rot.dist];
    const dx = cam[0] - v[0], dy = cam[1] - v[1], dz = cam[2] - v[2];
    const len = Math.hypot(dx, dy, dz);
    // visible when the surface normal points toward the camera
    return (v[0] * dx + v[1] * dy + v[2] * dz) / Math.max(1e-6, len) > 0.02;
  }

  /** Unproject a canvas point onto the sphere; returns {lat, lon} or null. */
  pick(clientX, clientY) {
    if (!this.ok) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const tanFov = Math.tan(0.62 / 2);
    const aspect = rect.width / rect.height;
    const dir = [ndcX * tanFov * aspect, ndcY * tanFov, -1];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    const origin = [0, 0, this.rot.dist];
    const b = 2 * (origin[0] * d[0] + origin[1] * d[1] + origin[2] * d[2]);
    const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - 1;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / 2;
    if (t <= 0) return null;
    const hit = [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t];
    const inv = this._unrotate(hit);
    const lat = Math.asin(Math.max(-1, Math.min(1, inv[2]))) * 180 / Math.PI;
    let lon = Math.atan2(inv[1], inv[0]) * 180 / Math.PI;
    if (lon < -180) lon += 360;
    if (lon > 180) lon -= 360;
    return { lat, lon };
  }

  _unrotate(v) {
    const cy = Math.cos(-this.rot.yaw), sy = Math.sin(-this.rot.yaw);
    const cp = Math.cos(-this.rot.pitch), sp = Math.sin(-this.rot.pitch);
    // inverse of Rx(-pitch)·Ry(yaw) is Ry(-yaw)·Rx(pitch)
    const x = v[0];
    const y1 = cp * v[1] + sp * v[2];
    const z1 = -sp * v[1] + cp * v[2];
    return [cy * x - sy * y1, sy * x + cy * y1, z1];
  }

  /* ---------------- render ---------------- */

  render(dt = 0) {
    if (!this.ok) return;
    const gl = this.gl;
    if (this.state.spin) this.rot.yaw += dt * 0.3;
    this.resize();

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.attr.pos);
    gl.vertexAttribPointer(this.attr.pos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.attr.uv);
    gl.vertexAttribPointer(this.attr.uv, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);

    gl.uniformMatrix4fv(this.uni.uMvp, false, this._mvp());
    gl.uniform1f(this.uni.uRadius, 1.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texBase);
    gl.uniform1i(this.uni.uBase, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texOverlay);
    gl.uniform1i(this.uni.uOverlay, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texLut);
    gl.uniform1i(this.uni.uLut, 2);

    const s = this.sunDirection();
    const shadows = this.sun.shadow === false ? 0 : 1;
    gl.uniform4f(this.uni.uLight, s[0], s[1], s[2], shadows);
    const overlayActive = this.lutName && !this._blank ? 1 : 0;
    gl.uniform4f(this.uni.uParams, this.state.atmosphere ? 1 : 0, this.state.graticule ? 1 : 0,
      overlayActive, overlayActive ? this.overlayOpacity : 0);
    gl.uniform4f(this.uni.uLutRange, 0.15, 0.95, 0.5, 0);
    gl.uniform1f(this.uni.uTint, this.state.tempTint ?? 0.35);

    gl.drawElements(gl.TRIANGLES, this.vertexCount, this.indexType, 0);
  }

  snapshot() {
    try { this.render(0); return this.canvas.toDataURL('image/png'); } catch (e) { return null; }
  }
}

function rot4(m3) {
  return [
    m3[0], m3[1], m3[2], 0,
    m3[3], m3[4], m3[5], 0,
    m3[6], m3[7], m3[8], 0,
    0, 0, 0, 1,
  ];
}
