import { type FastifyPluginAsync } from 'fastify';
import { detectAndWarpCard } from '../../../utils/cardDetector';
import { performFocusedIcOcr } from '../../../utils/ocrProcessor';

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


