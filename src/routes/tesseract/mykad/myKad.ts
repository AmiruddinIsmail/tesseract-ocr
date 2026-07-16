import { type FastifyPluginAsync } from 'fastify';
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import cvModule from '@techstark/opencv-js';

// ==========================================
// 1. FASTIFY ROUTE & SIMPLIFIED OCR
// ==========================================
const mykad: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post('/', async function (request, reply) {
    const file = await request.file();
    if (!file) {
      return reply.badRequest('No file uploaded');
    }

    const originalBuffer = await file.toBuffer();

    // Optional: Card detection + perspective correction (helps accuracy)
    let cardBuffer: Buffer = originalBuffer;
    try {
      const warped = await detectAndWarpCard(originalBuffer);
      if (warped) {
        cardBuffer = warped;
        request.log.info('Card successfully detected and warped');
      } else {
        request.log.warn('Card contour not detected — using original image');
      }
    } catch (err) {
      request.log.error(err, 'Card detection failed, using original image');
    }

    // Focused IC-only OCR
    const result = await performFocusedIcOcr(cardBuffer, request);

    if (!result.icNumber) {
      return reply.badRequest(
        'Could not extract IC number. Please retake the photo with the card flat, well-lit, and filling most of the frame.'
      );
    }

    return {
      success: true,
      confidence: result.confidence,
      data: result.parsed,
      rawText: result.rawText,
    };
  });
};

export default mykad;

// ==========================================
// Simplified Focused IC OCR
// ==========================================
async function performFocusedIcOcr(buffer: Buffer, request: any) {
  const strategies = [
    // Best for most cards
    async () => {
      const processed = await sharp(buffer)
        .resize({ width: 2400, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .linear(1.4, -10)
        .modulate({ brightness: 1.1 })
        .sharpen({ sigma: 1.5 })
        .threshold(130)
        .toBuffer();
      return ocrWithWorker(processed, PSM.SPARSE_TEXT);
    },
    // Standard fallback
    async () => {
      const processed = await sharp(buffer)
        .resize({ width: 2000 })
        .grayscale()
        .normalize()
        .linear(1.3, -8)
        .sharpen({ sigma: 1.2 })
        .toBuffer();
      return ocrWithWorker(processed, PSM.AUTO);
    },
    // Faint / difficult text
    async () => {
      const processed = await sharp(buffer)
        .resize({ width: 2200 })
        .grayscale()
        .gamma(1.2)
        .normalize()
        .modulate({ brightness: 1.05 })
        .sharpen({ sigma: 1.8 })
        .toBuffer();
      return ocrWithWorker(processed, PSM.SPARSE_TEXT);
    },
  ];

  let bestResult: any = {
    icNumber: null,
    confidence: 0,
    parsed: {
      icNumber: null, name: null, address: null, gender: null,
      dateOfBirth: null, age: null, birthPlace: null, isCitizen: false
    } as MykadData,
    rawText: ''
  };

  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result.icNumber && result.confidence > bestResult.confidence) {
        bestResult = result;
        request.log.info(`IC extraction succeeded with confidence: ${result.confidence}`);
        return bestResult; // Early return on good IC
      }
    } catch (e) {
      request.log.warn(e, 'OCR strategy failed');
    }
  }

  // Final fallback
  try {
    const rawProcessed = await sharp(buffer)
      .resize({ width: 1800 })
      .grayscale()
      .normalize()
      .toBuffer();
    const fallback = await ocrWithWorker(rawProcessed, PSM.AUTO);
    if (fallback.icNumber) return fallback;
  } catch (e) {
    request.log.error(e, 'Final OCR fallback failed');
  }

  return bestResult;
}

async function ocrWithWorker(imageBuffer: Buffer, psmMode: string) {
  const worker = await createWorker(['eng', 'msa']);
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: psmMode as any,
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/ \n',
    });

    const { data } = await worker.recognize(imageBuffer);
    const cleanedText = cleanOcrText(data.text);
    const parsed = parseMykadText(cleanedText);

    return {
      icNumber: parsed.icNumber,
      confidence: data.confidence || 0,
      parsed,
      rawText: cleanedText,
    };
  } finally {
    await worker.terminate();
  }
}

function cleanOcrText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 1)
    .join('\n');
}

// ==========================================
// IC-Focused Parsing
// ==========================================
export interface MykadData {
  icNumber: string | null;
  name: string | null;
  address: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  dateOfBirth: string | null;
  age: number | null;
  birthPlace: string | null;
  isCitizen: boolean;
}

function decodeIc(icDigits: string, pb: string, serial: string) {
  const yy = icDigits.slice(0, 2);
  const mm = icDigits.slice(2, 4);
  const dd = icDigits.slice(4, 6);
  let dateOfBirth: string | null = null;
  let age: number | null = null;
  const mmNum = parseInt(mm, 10);
  const ddNum = parseInt(dd, 10);

  if (mmNum >= 1 && mmNum <= 12 && ddNum >= 1 && ddNum <= 31) {
    const currentYearTwoDigit = new Date().getFullYear() % 100;
    const yyNum = parseInt(yy, 10);
    const century = yyNum > currentYearTwoDigit + 5 ? 1900 : 2000;
    const fullYear = century + yyNum;
    const dobDate = new Date(fullYear, mmNum - 1, ddNum);
    if (!isNaN(dobDate.getTime()) && dobDate.getDate() === ddNum) {
      dateOfBirth = `${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      const today = new Date();
      let calcAge = today.getFullYear() - fullYear;
      const hasHadBirthdayThisYear =
        today.getMonth() > mmNum - 1 ||
        (today.getMonth() === mmNum - 1 && today.getDate() >= ddNum);
      if (!hasHadBirthdayThisYear) calcAge--;
      age = calcAge;
    }
  }

  const lastDigit = parseInt(serial.slice(-1), 10);
  const gender: 'MALE' | 'FEMALE' = lastDigit % 2 === 0 ? 'FEMALE' : 'MALE';
  return { dateOfBirth, age, gender, birthPlace: null };
}

export function parseMykadText(rawText: string): MykadData {
  const lines = rawText
    .toUpperCase()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const fullNormalizedText = lines.join(' ');

  // Strong IC number patterns
  let icNumber: string | null = null;
  const icPatterns = [
    /([0-9OIl]{6})[\s\-–—]*([0-9OIl]{2})[\s\-–—]*([0-9OIl]{4})/g,
    /([0-9OIl]{6})\s*-\s*([0-9OIl]{2})\s*-\s*([0-9OIl]{4})/g,
    /NO[:.\s]*([0-9OIl]{6})[\s\-]*([0-9OIl]{2})[\s\-]*([0-9OIl]{4})/gi,
    /(\d{6})[\s\-]?(\d{2})[\s\-]?(\d{4})/g,
  ];

  for (const pattern of icPatterns) {
    const matches = [...fullNormalizedText.matchAll(pattern)];
    for (const match of matches) {
      const cleanDigits = (str: string) => str.replace(/O/g, '0').replace(/[Il]/g, '1').replace(/[^0-9]/g, '');
      const candidate = `${cleanDigits(match[1])}-${cleanDigits(match[2])}-${cleanDigits(match[3])}`;
      if (candidate.replace(/-/g, '').length === 12) {
        icNumber = candidate;
        break;
      }
    }
    if (icNumber) break;
  }

  let dateOfBirth: string | null = null;
  let age: number | null = null;
  let gender: 'MALE' | 'FEMALE' | null = null;

  if (icNumber) {
    const parts = icNumber.split('-');
    if (parts.length === 3) {
      const decoded = decodeIc(parts[0], parts[1], parts[2]);
      dateOfBirth = decoded.dateOfBirth;
      age = decoded.age;
      gender = decoded.gender;
    }
  }

  // Minimal fields for compatibility
  return {
    icNumber,
    name: null,
    address: null,
    gender,
    dateOfBirth,
    age,
    birthPlace: null,
    isCitizen: /WARGANEGARA|WARGA\s*NEGARA/i.test(fullNormalizedText)
  };
}

// OpenCV card detection (kept — improves OCR accuracy)
let cv: any;
let cvReadyPromise: Promise<any> | null = null;

export function warmUpOpenCv(): Promise<any> {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      const mod: any = cvModule;
      if (mod instanceof Promise) cv = await mod;
      else if (mod.Mat) cv = mod;
      else {
        cv = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('OpenCV.js timeout')), 25000);
          mod.onRuntimeInitialized = () => { clearTimeout(timeout); resolve(mod); };
        });
      }
      return cv;
    })();
  }
  return cvReadyPromise;
}

interface Point { x: number; y: number; }

function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  const sums = pts.map(p => p.x + p.y);
  const diffs = pts.map(p => p.x - p.y);
  return [
    pts[sums.indexOf(Math.min(...sums))],
    pts[diffs.indexOf(Math.max(...diffs))],
    pts[sums.indexOf(Math.max(...sums))],
    pts[diffs.indexOf(Math.min(...diffs))]
  ];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function detectAndWarpCard(inputBuffer: Buffer): Promise<Buffer | null> {
  await warmUpOpenCv();
  const { data, info } = await sharp(inputBuffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const imageData = { data: new Uint8ClampedArray(data), width, height };
  const src = cv.matFromImageData(imageData);

  const gray = new cv.Mat(), blurred = new cv.Mat(), edged = new cv.Mat();
  const hierarchy = new cv.Mat(), contours = new cv.MatVector();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  let warpedBuffer: Buffer | null = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edged, 50, 150);
    cv.dilate(edged, edged, kernel);
    cv.findContours(edged, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let bestQuad: Point[] | null = null;
    let bestArea = 0;
    const imageArea = width * height;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > imageArea * 0.08 && area < imageArea * 0.98) {
          const pts: Point[] = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          bestQuad = pts;
          bestArea = area;
        }
      }
      approx.delete();
      contour.delete();
    }

    if (bestQuad) {
      const [tl, tr, br, bl] = orderCorners(bestQuad);
      const outWidth = Math.max(distance(tl, tr), distance(bl, br));
      const outHeight = Math.max(distance(tl, bl), distance(tr, br));

      if (outWidth > 100 && outHeight > 60) {
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outWidth, 0, outWidth, outHeight, 0, outHeight]);
        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const dst = new cv.Mat();
        cv.warpPerspective(src, dst, M, new cv.Size(outWidth, outHeight));

        warpedBuffer = await sharp(Buffer.from(dst.data), {
          raw: { width: dst.cols, height: dst.rows, channels: 4 }
        }).png().toBuffer();

        srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
      }
    }
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edged.delete();
    hierarchy.delete(); contours.delete(); kernel.delete();
  }
  return warpedBuffer;
}