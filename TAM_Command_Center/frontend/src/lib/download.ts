import type { DownloadedFile } from '../types';

/** Hand a Blob from the data layer to the browser's download mechanism. */
export function saveFile(f: DownloadedFile): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
