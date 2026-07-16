// ==========================================
// Simplified Focused IC OCR

import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import { MykadData, parseMykadText } from "./mykadParser";

// ==========================================
export async function performFocusedIcOcr(buffer: Buffer, request: any) {
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