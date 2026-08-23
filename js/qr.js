// qr.js — tiny QR encoder (inlined, MIT-style — the single allowed extra
// dependency per spec §6). Byte mode, EC level L, versions 1–5 (single EC
// block each, up to 106 chars), fixed mask 0. Shared by the couch host page
// and the head-to-head player page.

const QR_VERSIONS = [
  // [version, totalCodewords, dataCodewords] at EC level L
  [1, 26, 19],
  [2, 44, 34],
  [3, 70, 55],
  [4, 100, 80],
  [5, 134, 108],
];
const QR_ALIGN_CENTER = { 2: 18, 3: 22, 4: 26, 5: 30 };

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor) {
      for (let j = 0; j < gen.length - 1; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// BCH(15,5) format bits for (EC level, mask). EC level L = 1.
function qrFormatBits(ecLevel, mask) {
  const data = (ecLevel << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

// Returns a size×size matrix of 0/1, or null if text is too long.
// Exported for the test suite; pages only use drawQr.
export function qrEncode(text) {
  const bytes = new TextEncoder().encode(text);
  const spec = QR_VERSIONS.find(([, , dc]) => bytes.length <= dc - 2);
  if (!spec) return null;
  const [version, , dataCw] = spec;
  const ecCw = spec[1] - dataCw;
  const size = 17 + 4 * version;

  // --- bit stream: mode 0100, 8-bit length, data, terminator, padding ---
  const bits = [];
  const pushBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = data.concat(rsEncode(data, ecCw));

  // --- matrix: null = free for data; true/false = function modules ---
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const stampFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        m[rr][cc] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  stampFinder(0, 0);
  stampFinder(size - 7, 0);
  stampFinder(0, size - 7);

  const ac = QR_ALIGN_CENTER[version];
  if (ac) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        m[ac + r][ac + c] =
          r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }

  // Format info (EC L, mask 0), placed twice, plus the fixed dark module.
  const fmt = qrFormatBits(1, 0);
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
    if (i < 8) m[8][size - 1 - i] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][14 - i] = bit;
  }
  m[size - 8][8] = true;

  // Zigzag data placement with mask 0: (row+col) % 2 === 0.
  let byteIdx = 0, bitIdx = 7, row = size - 1, inc = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] !== null) continue;
        let dark =
          byteIdx < codewords.length &&
          ((codewords[byteIdx] >>> bitIdx) & 1) === 1;
        if ((row + (col - c)) % 2 === 0) dark = !dark;
        m[row][col - c] = dark;
        if (--bitIdx === -1) { byteIdx++; bitIdx = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
  return m.map((r) => r.map((v) => (v ? 1 : 0)));
}

export function drawQr(canvas, text) {
  const matrix = qrEncode(text);
  if (!matrix) { canvas.style.display = "none"; return; }
  const quiet = 4, scale = 8;
  const n = matrix.length + quiet * 2;
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  matrix.forEach((rowArr, r) =>
    rowArr.forEach((v, c) => {
      if (v) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    })
  );
}
