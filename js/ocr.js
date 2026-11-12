// Распознавание на устройстве: Tesseract лежит в vendor/, картинки никуда не уходят.
let workerPromise = null;
let onProgress = () => {};

const abs = (p) => new URL(p, location.href).href;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error('Не удалось загрузить модуль распознавания'));
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(abs('vendor/tesseract.min.js'));
      const worker = await window.Tesseract.createWorker(['rus', 'eng'], 1, {
        workerPath: abs('vendor/worker.min.js'),
        corePath: abs('vendor/core'),
        langPath: abs('vendor/lang'),
        gzip: true,
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') onProgress(m.progress);
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/**
 * Чёрно-белая картинка: всё, что заметно отличается от фона (самый частый тон), — чёрное.
 * Так одинаково читаются тёмная тема, цветные блоки календаря и пузыри переписки.
 */
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(2, Math.max(1, 1800 / bitmap.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const y = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
    px[i] = y;
    hist[y]++;
  }
  let bg = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.abs(px[i] - bg) > 60 ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @returns {{lines: {text: string, conf: number, box: {x0, y0, x1, y1}}[], text: string}} */
export async function recognize(file, progress = () => {}) {
  onProgress = progress;
  const worker = await getWorker();
  const canvas = await prepare(file);
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) lines.push({ text: l.text.trim(), conf: l.confidence, box: l.bbox });
    }
  }
  return { lines: lines.length ? lines : data.text.split('\n').map((text) => ({ text, conf: 100 })), text: data.text };
}
