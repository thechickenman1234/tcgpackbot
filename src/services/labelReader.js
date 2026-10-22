import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import ZXing from '@zxing/library';
import Tesseract from 'tesseract.js';
import { config } from '../config.js';

/**
 * Reads a shipping label: its tracking number, who it's to, and the "Ref"
 * line the bot's label file filled in (e.g. "TCG-6D8F15: 2x storm").
 *
 * Label Pro's PDFs are one picture per label with no text inside, so:
 *
 *   tracking  from the square DataMatrix barcode, the GS1 (91) field, which
 *             is the AusPost article id. The tall barcode is the fallback.
 *   name/ref  read off the picture with OCR (tesseract.js), from where Label
 *             Pro's layout puts the To: and Ref: boxes, or the whole picture
 *             when it's some other layout or a photo.
 *
 * Everything works on one grey picture: { width, height, data } with one
 * byte per pixel.
 */

const { BarcodeFormat, BinaryBitmap, DecodeHintType, GlobalHistogramBinarizer, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } = ZXing;

// ---------------------------------------------------------------- pictures

function toGrey(pixels, width, height, channels) {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 1, p += channels) {
    if (channels >= 3) data[i] = (pixels[p] * 299 + pixels[p + 1] * 587 + pixels[p + 2] * 114) / 1000;
    else data[i] = pixels[p];
  }
  return { width, height, data };
}

/** Undoes PNG row filters (PDF Predictor 10-15). */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return out;
}

/**
 * The label pictures inside a PDF, in page order. Soft masks and small
 * pictures (logos) are skipped. Handles raw, Flate (with or without a
 * predictor) and JPEG pictures, in grey or RGB.
 */
export function imagesFromPdf(buffer) {
  const text = buffer.toString('latin1');
  const masks = new Set([...text.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)].map((m) => m[1]));
  const images = [];
  const objRe = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = objRe.exec(text))) {
    const [, id, dict] = m;
    if (!/\/Subtype\s*\/Image/.test(dict) || masks.has(id)) continue;
    const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1]);
    const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1]);
    if (!(width >= 400 && height >= 400)) continue;
    if (Number(dict.match(/\/BitsPerComponent\s+(\d+)/)?.[1] || 8) !== 8) continue;

    const start = m.index + m[0].length;
    const direct = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    const end = direct ? start + Number(direct[1]) : text.indexOf('endstream', start);
    const data = buffer.subarray(start, end);

    try {
      if (/\/DCTDecode/.test(dict)) {
        const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
        images.push(toGrey(img.data, img.width, img.height, 4));
        continue;
      }
      const channels = /\/DeviceGray/.test(dict) ? 1 : /\/DeviceCMYK/.test(dict) ? 4 : 3;
      let raw = /\/FlateDecode/.test(dict) ? zlib.inflateSync(data) : data;
      const predictor = Number(dict.match(/\/Predictor\s+(\d+)/)?.[1] || 1);
      if (predictor >= 10) raw = unfilter(raw, width, height, channels);
      if (raw.length < width * height * channels) continue;
      images.push(toGrey(raw, width, height, channels));
    } catch (err) {
      console.error(`Label PDF: could not read picture ${id}:`, err.message);
    }
  }
  return images;
}

/** A PNG or JPEG file (a screenshot or a photo of a label). */
export function imageFromFile(buffer) {
  if (buffer.subarray(0, 4).toString('latin1') === '\x89PNG') {
    const png = PNG.sync.read(buffer);
    return toGrey(png.data, png.width, png.height, 4);
  }
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  return toGrey(img.data, img.width, img.height, 4);
}

function crop(img, x, y, w, h) {
  const cx = Math.max(0, Math.round(x));
  const cy = Math.max(0, Math.round(y));
  const cw = Math.min(img.width - cx, Math.round(w));
  const ch = Math.min(img.height - cy, Math.round(h));
  const data = new Uint8ClampedArray(cw * ch);
  for (let row = 0; row < ch; row += 1) {
    data.set(img.data.subarray((cy + row) * img.width + cx, (cy + row) * img.width + cx + cw), row * cw);
  }
  return { width: cw, height: ch, data };
}

function rotate90(img) {
  const data = new Uint8ClampedArray(img.width * img.height);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) data[x * img.height + (img.height - 1 - y)] = img.data[y * img.width + x];
  }
  return { width: img.height, height: img.width, data };
}

function toPng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i += 1) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = img.data[i];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------- barcodes

function decodeBarcode(img, formats) {
  const reader = new MultiFormatReader();
  reader.setHints(new Map([[DecodeHintType.POSSIBLE_FORMATS, formats], [DecodeHintType.TRY_HARDER, true]]));
  const source = new RGBLuminanceSource(img.data, img.width, img.height);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      return reader.decode(new BinaryBitmap(new Binarizer(source))).getText();
    } catch {
      // try the next binarizer
    }
  }
  return null;
}

/** The AusPost article id inside a GS1 DataMatrix: the (91) field, after (01). */
export function trackingFromGs1(text) {
  let s = String(text || '').replace(/^\x1d/, '');
  if (s.startsWith('01')) s = s.slice(16);
  if (!s.startsWith('91')) return null;
  const code = s.slice(2).split('\x1d')[0];
  return /^[0-9A-Z]{10,30}$/.test(code) ? code : null;
}

export function readTracking(img) {
  // Label Pro puts the DataMatrix in the top right corner; look there first.
  const corner = crop(img, img.width * 0.6, 0, img.width * 0.4, img.height * 0.4);
  for (const area of [corner, img]) {
    const code = trackingFromGs1(decodeBarcode(area, [BarcodeFormat.DATA_MATRIX]));
    if (code) return code;
  }
  for (const area of [rotate90(img), img]) {
    const text = decodeBarcode(area, [BarcodeFormat.CODE_128]);
    const digits = text?.match(/\d{20,24}/)?.[0];
    if (digits) return digits;
  }
  return null;
}

// ---------------------------------------------------------------- OCR

let worker = null;
let idleTimer = null;

async function getWorker() {
  clearTimeout(idleTimer);
  if (!worker) {
    // The English data downloads once and is kept next to the database.
    const cachePath = path.join(path.dirname(path.resolve(config.databasePath)), 'ocr');
    fs.mkdirSync(cachePath, { recursive: true });
    worker = Tesseract.createWorker('eng', 1, { cachePath });
  }
  const w = await worker;
  idleTimer = setTimeout(() => {
    worker = null;
    w.terminate().catch(() => {});
  }, 120000);
  idleTimer.unref?.();
  return w;
}

async function ocr(img) {
  const w = await getWorker();
  const { data } = await w.recognize(toPng(img));
  return data.text || '';
}

/** "Melissa Pranata" from "To:\nMelissa Pranata\n9 Barnard Grove..." */
function nameFromToBox(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /^to\s*:?$/i.test(l) || /^to:/i.test(l));
  if (at === -1) return lines[0] || null;
  const inline = lines[at].replace(/^to\s*:?\s*/i, '');
  return inline || lines[at + 1] || null;
}

const looksLikeLabelPro = (img) => Math.abs(img.width / img.height - 1280 / 1784) < 0.03;

/**
 * The To: name and the Ref: line. On Label Pro's layout each box is read on
 * its own (fast, and nothing else gets in the way); anything else is read
 * whole and picked apart.
 */
export async function readLabelText(img) {
  if (looksLikeLabelPro(img)) {
    const { width: W, height: H } = img;
    const to = await ocr(crop(img, W * 0.031, H * 0.098, W * 0.69, H * 0.102));
    const ref = await ocr(crop(img, W * 0.031, H * 0.518, W * 0.69, H * 0.037));
    return { name: nameFromToBox(to), ref: ref.replace(/^\s*ref\s*:?\s*/i, '').trim() || null, raw: `${to}\n${ref}` };
  }
  const all = await ocr(img);
  const refLine = all.split('\n').find((l) => /ref\s*:/i.test(l)) || '';
  return { name: nameFromToBox(all), ref: refLine.replace(/^.*?ref\s*:?\s*/i, '').trim() || null, raw: all };
}

/** Everything from one label picture. */
export async function readLabel(img) {
  const tracking = readTracking(img);
  const { name, ref, raw } = await readLabelText(img);
  return { tracking, name, ref, raw };
}

/** Every label in a Discord attachment (a PDF may hold several). */
export async function readLabelsFromFile(buffer, filename = '') {
  const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-' || /\.pdf$/i.test(filename);
  const images = isPdf ? imagesFromPdf(buffer) : [imageFromFile(buffer)];
  const labels = [];
  for (const img of images) labels.push(await readLabel(img));
  return labels;
}
