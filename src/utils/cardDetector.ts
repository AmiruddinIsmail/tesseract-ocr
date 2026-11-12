import cvModule from '@techstark/opencv-js';
import sharp from 'sharp';

let cv: any;
let cvReadyPromise: Promise<any> | null = null;

/**
 * @techstark/opencv-js loads its WASM binary asynchronously. This must
 * resolve before any cv.* call is made. Call `warmUpOpenCv()` once at
 * server startup so the first real request isn't stuck waiting ~1-3s
 * for WASM init.
 *
 * IMPORTANT: in current versions of this package the default export is a
 * Promise that resolves to the cv namespace — it is NOT the namespace
 * directly, and `onRuntimeInitialized` is a read-only property on some
 * versions (assigning to it silently no-ops rather than throwing, which
 * causes an infinite hang if you rely on it as a completion signal). This
 * follows the library's own documented Node.js initialization pattern.
 */
export function warmUpOpenCv(): Promise<any> {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      const mod: any = cvModule;

      if (mod instanceof Promise) {
        cv = await mod;
      } else if (mod.Mat) {
        // Already initialized synchronously (can happen with some builds/caching)
        cv = mod;
      } else {
        // Older-style builds that use a genuine, writable onRuntimeInitialized
        cv = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('OpenCV.js failed to initialize within timeout')),
            20000
          );
          mod.onRuntimeInitialized = () => {
            clearTimeout(timeout);
            resolve(mod);
          };
        });
      }

      return cv;
    })();
  }
  return cvReadyPromise;
}

interface Point {
  x: number;
  y: number;
}

function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  // Returns corners in consistent order: [topLeft, topRight, bottomRight, bottomLeft]
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.x - p.y);

  const topLeft = pts[sums.indexOf(Math.min(...sums))];
  const bottomRight = pts[sums.indexOf(Math.max(...sums))];
  const topRight = pts[diffs.indexOf(Math.max(...diffs))];
  const bottomLeft = pts[diffs.indexOf(Math.min(...diffs))];

  return [topLeft, topRight, bottomRight, bottomLeft];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Finds the largest 4-corner rectangular contour in the image (assumed to be
 * an ID card), perspective-warps it flat, and returns a cropped, front-on
 * PNG buffer of just the card.
 *
 * Returns null if no suitable rectangle was found, so the caller can fall
 * back to using the original, uncropped image.
 */
export async function detectAndWarpCard(inputBuffer: Buffer): Promise<Buffer | null> {
  await warmUpOpenCv();

  // opencv.js needs raw {data, width, height} pixels, not an encoded
  // JPEG/PNG buffer — decode with sharp first.
  const { data, info } = await sharp(inputBuffer)
    .rotate() // respect EXIF orientation before we start detecting corners
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const imageData = { data: new Uint8ClampedArray(data), width, height };

  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const hierarchy = new cv.Mat();
  const contours = new cv.MatVector();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);

  let warpedBuffer: Buffer | null = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edged, 50, 150);
    cv.dilate(edged, edged, kernel); // close small gaps in the card outline

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
        // Card should cover a meaningful chunk of the frame but not the
        // entire photo (that would just be the photo's own border).
        if (area > bestArea && area > imageArea * 0.1 && area < imageArea * 0.95) {
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

      if (outWidth > 50 && outHeight > 50) {
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          tl.x, tl.y,
          tr.x, tr.y,
          br.x, br.y,
          bl.x, bl.y,
        ]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0,
          outWidth, 0,
          outWidth, outHeight,
          0, outHeight,
        ]);

        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const dst = new cv.Mat();
        const dsize = new cv.Size(outWidth, outHeight);
        cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

        warpedBuffer = await sharp(Buffer.from(dst.data), {
          raw: { width: dst.cols, height: dst.rows, channels: 4 },
        })
          .png()
          .toBuffer();

        srcTri.delete();
        dstTri.delete();
        M.delete();
        dst.delete();
      }
    }
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edged.delete();
    hierarchy.delete();
    contours.delete();
    kernel.delete();
  }

  return warpedBuffer;
}