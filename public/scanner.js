// Barcode decoding for the live camera and for still photos. Uses the
// browser's built-in BarcodeDetector when present (Chrome on Android, Edge)
// and the ZXing library everywhere else (iPhone Safari, Firefox).

const NATIVE_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
  'itf', 'qr_code', 'data_matrix', 'pdf417', 'aztec'];

let detectorPromise;
function getDetector() {
  if (!('BarcodeDetector' in window)) return Promise.resolve(null);
  detectorPromise ??= (async () => {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      return formats.length ? new window.BarcodeDetector({ formats }) : null;
    } catch {
      return null;
    }
  })();
  return detectorPromise;
}

let zxingPromise;
function getZXing() {
  zxingPromise ??= new Promise((resolve, reject) => {
    if (window.ZXing) return resolve(window.ZXing);
    const script = document.createElement('script');
    script.src = '/vendor/zxing/index.min.js';
    script.onload = () => resolve(window.ZXing);
    script.onerror = () => reject(new Error('Could not load the barcode decoder'));
    document.head.append(script);
  }).then((Z) => {
    const f = Z.BarcodeFormat;
    const formats = [f.CODE_128, f.CODE_39, f.CODE_93, f.CODABAR, f.EAN_13, f.EAN_8, f.UPC_A, f.UPC_E,
      f.ITF, f.QR_CODE, f.DATA_MATRIX, f.PDF_417];
    const reader = (tryHarder) => {
      const r = new Z.MultiFormatReader();
      const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, formats]]);
      if (tryHarder) hints.set(Z.DecodeHintType.TRY_HARDER, true);
      r.setHints(hints);
      return r;
    };
    return { Z, fast: reader(false), thorough: reader(true) };
  });
  zxingPromise.catch(() => { zxingPromise = null; });
  return zxingPromise;
}

function zxingDecode({ Z }, reader, canvas) {
  try {
    const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    return reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(source))).getText();
  } catch {
    return null; // ZXing throws when nothing is found
  }
}

function drawToCanvas(image, width, height, rotate = 0) {
  const canvas = document.createElement('canvas');
  const turned = rotate % 180 !== 0;
  canvas.width = turned ? height : width;
  canvas.height = turned ? width : height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate((rotate * Math.PI) / 180);
  g.drawImage(image, -width / 2, -height / 2, width, height);
  return canvas;
}

// Reads the first barcode in a photo. Resolves null when none is found.
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const upright = drawToCanvas(bitmap, w, h);
    const detector = await getDetector();
    if (detector) {
      try {
        const found = await detector.detect(upright);
        if (found.length) return found[0].rawValue;
      } catch { /* fall through to ZXing */ }
    }
    const zx = await getZXing();
    return zxingDecode(zx, zx.thorough, upright) ?? zxingDecode(zx, zx.thorough, drawToCanvas(bitmap, w, h, 90));
  } finally {
    bitmap.close?.();
  }
}

let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1320;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.08);
  } catch { /* sound is optional */ }
  navigator.vibrate?.(60);
}

// Live camera scanner shown in a <dialog>. In continuous mode it keeps
// scanning after each hit (for audits); otherwise it closes on the first code.
export class CameraScanner {
  constructor(dialog) {
    this.dialog = dialog;
    this.video = dialog.querySelector('video');
    this.status = dialog.querySelector('[data-status]');
    this.last = dialog.querySelector('[data-last]');
    this.title = dialog.querySelector('[data-title]');
    this.torchBtn = dialog.querySelector('[data-torch]');
    this.frame = document.createElement('canvas');
    this.running = false;
    dialog.addEventListener('close', () => this.stop());
    this.torchBtn.addEventListener('click', () => this.toggleTorch());
  }

  static supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
  }

  async open({ title = 'Scan a barcode', continuous = false, onCode }) {
    this.onCode = onCode;
    this.continuous = continuous;
    this.lastCode = null;
    this.title.textContent = title;
    this.last.hidden = true;
    this.torchBtn.hidden = true;
    this.status.textContent = 'Starting camera…';
    try { audio ??= new AudioContext(); audio.resume(); } catch { /* optional */ }
    this.dialog.showModal();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (err) {
      this.status.textContent = err.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or use Photo.'
        : 'No camera is available. Use Photo instead.';
      return;
    }
    if (!this.dialog.open) return this.stop();
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    const track = this.stream.getVideoTracks()[0];
    this.torch = false;
    this.torchBtn.hidden = !track.getCapabilities?.().torch;
    [this.detector, this.zx] = await Promise.all([getDetector(), getDetector().then((d) => (d ? null : getZXing()))]);
    this.status.textContent = 'Hold the barcode inside the frame';
    this.running = true;
    this.loop();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    this.torch = !this.torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: this.torch }] });
      this.torchBtn.setAttribute('aria-pressed', String(this.torch));
    } catch { this.torch = !this.torch; }
  }

  // The centre of the frame, matching the on-screen guide box.
  cropFrame() {
    const v = this.video;
    const cw = v.videoWidth * 0.85;
    const ch = v.videoHeight * 0.6;
    const scale = Math.min(1, 1000 / cw);
    this.frame.width = Math.round(cw * scale);
    this.frame.height = Math.round(ch * scale);
    const g = this.frame.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, (v.videoWidth - cw) / 2, (v.videoHeight - ch) / 2, cw, ch, 0, 0, this.frame.width, this.frame.height);
    return this.frame;
  }

  async loop() {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.videoWidth) {
      let code = null;
      try {
        if (this.detector) code = (await this.detector.detect(this.video))[0]?.rawValue ?? null;
        else if (this.zx) code = zxingDecode(this.zx, this.zx.fast, this.cropFrame());
      } catch { /* try the next frame */ }
      if (code && this.running) this.found(code.trim());
    }
    if (this.running) this.timer = setTimeout(() => this.loop(), this.detector ? 90 : 150);
  }

  found(code) {
    const now = Date.now();
    if (!code || (code === this.lastCode && now - this.lastAt < 2500)) return;
    this.lastCode = code;
    this.lastAt = now;
    beep();
    if (this.continuous) {
      this.last.hidden = false;
      this.last.textContent = code;
      this.onCode(code);
    } else {
      this.close();
      this.onCode(code);
    }
  }
}
