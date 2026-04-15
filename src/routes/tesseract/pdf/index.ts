import { type FastifyPluginAsync } from 'fastify'
import { PDFParse } from 'pdf-parse';

const pdf: FastifyPluginAsync = async (fastify, opts): Promise<void> => {

    fastify.post('/', async function (request, reply) {
        const file = await request.file();

        if (!file) {
            return reply.badRequest('No file uploaded');
        }

        const buffer = await file.toBuffer();

        const parser = new PDFParse(new Uint8Array(buffer));
        const text = await parser.getText();
        const table = await parser.getTable();

        return { text, table };
    })
}

export default pdf;
