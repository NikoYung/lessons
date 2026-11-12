// Фото и файлы: сжатие картинок, превью, перевод в текст для резервной копии.
import { uid } from './logic.js';

const MAX_SIDE = 2000;

export const isImage = (m) => /^image\//.test(m.type);
export const kindIcon = (m) => (isImage(m) ? '🖼' : /^video\//.test(m.type) ? '🎬' : /^audio\//.test(m.type) ? '🎧' : /pdf/.test(m.type) ? '📄' : '📎');

/** Картинки уменьшаем до 2000 px и сохраняем в JPEG — фото с iPhone весят в 5–10 раз меньше. */
async function shrink(file) {
  if (!isImage(file) || /gif|svg/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 1.5e6) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // HEIC и прочее, что браузер не умеет открыть, — храним как есть
  }
}

export async function fromFile(file, { studentId = null, lessonId = null } = {}) {
  const blob = await shrink(file);
  return {
    id: uid(), studentId, lessonId, name: file.name || 'файл', type: blob.type || file.type || 'application/octet-stream',
    size: blob.size, blob, text: '', createdAt: Date.now(),
  };
}

const urls = new Map();
/** Ссылка на Blob для <img>/<video>; одна на файл, пока он не удалён. */
export function urlOf(m) {
  if (!urls.has(m.id)) urls.set(m.id, URL.createObjectURL(m.blob));
  return urls.get(m.id);
}
export function forget(id) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

export const sizeText = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1e3))} КБ`);

/* Резервная копия: Blob ↔ data:URL */
export function toDataURL(blob) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
}
export async function fromDataURL(url) {
  return (await fetch(url)).blob();
}

export async function share(m) {
  const file = new File([m.blob], m.name, { type: m.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  const a = document.createElement('a');
  a.href = urlOf(m);
  a.download = m.name;
  a.click();
}
