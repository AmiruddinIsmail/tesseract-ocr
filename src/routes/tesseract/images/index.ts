import { type FastifyPluginAsync } from 'fastify'
import { createWorker } from 'tesseract.js';

const images: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
    fastify.post('/', async function (request, reply) {

        const file = await request.file();

        if (!file) {
            return reply.badRequest('No file uploaded');
        }

        const buffer = await file.toBuffer();
        const worker = await createWorker('eng');
        const result = await worker.recognize(buffer);
        await worker.terminate();

        return result;
    })
}

export default images;