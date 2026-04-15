import { type FastifyPluginAsync } from 'fastify'

const tesseract: FastifyPluginAsync = async (fastify, opts): Promise<void> => {

    fastify.get('/', async function (request, reply) {
        return reply.send({
            message: 'Welcome to Tesseract OCR',
        });
    })
}

export default tesseract
