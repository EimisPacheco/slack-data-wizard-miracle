import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Rasterizes a PDF (scanned or not) to one PNG per page using poppler's pdftoppm.
 * Scanned PDFs are images, so we render pixels regardless of any text layer.
 *
 * @param {Buffer} pdfBuffer
 * @param {object} opts { dpi=220, maxPages=20, firstPage, lastPage }
 * @returns {Promise<Buffer[]>} PNG buffers, page order
 */
export async function rasterize(pdfBuffer, opts = {}) {
  const dpi = opts.dpi || 220;
  const maxPages = opts.maxPages || 20;

  const dir = await mkdtemp(path.join(tmpdir(), 'pdfx-'));
  const pdfPath = path.join(dir, 'in.pdf');
  const outPrefix = path.join(dir, 'page');

  try {
    await writeFile(pdfPath, pdfBuffer);

    const args = ['-png', '-r', String(dpi), '-f', String(opts.firstPage || 1)];
    if (opts.lastPage) args.push('-l', String(opts.lastPage));
    else args.push('-l', String(maxPages));   // hard cap so a 500-page scan can't run away
    args.push(pdfPath, outPrefix);

    await run('pdftoppm', args);

    const files = (await readdir(dir))
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort();   // pdftoppm zero-pads page numbers, so lexical sort == page order

    if (files.length === 0) throw new Error('pdftoppm produced no pages — is this a valid PDF?');
    return Promise.all(files.map(f => readFile(path.join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', err => reject(new Error(`${cmd} failed to start: ${err.message}`)));
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`)));
  });
}
