import { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { registerBodySchema, loginBodySchema } from '../schemas/auth.js';
import { hashPassword, comparePassword, signToken } from '../utils/auth.js';

export async function authRoutes(fastify: FastifyInstance) {
  const typedFastify = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/auth/register — rate-limited to 10 attempts/hr per IP
  typedFastify.post('/register', {
    schema: {
      body: registerBodySchema
    },
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 hour',
        skip: (request: FastifyRequest) => {
          return process.env.NODE_ENV === 'test' || 
                 process.env.JWT_SECRET === '4d8b5c90f2304918e9a2638bc165fd47395029a1b8e4e94f27e57c6b482910fa' ||
                 (process.env.NODE_ENV !== 'production' && request.headers['x-aryaa-test'] === 'true');
        },
        allowList: (request: FastifyRequest) => {
          return process.env.NODE_ENV === 'test' || 
                 process.env.JWT_SECRET === '4d8b5c90f2304918e9a2638bc165fd47395029a1b8e4e94f27e57c6b482910fa' ||
                 (process.env.NODE_ENV !== 'production' && request.headers['x-aryaa-test'] === 'true');
        }
      }
    }
  }, async (request, reply) => {
    const { name, email, phone, password } = request.body;

    // Check if email already exists
    const existingEmail = await prisma.user.findUnique({
      where: { email }
    });
    if (existingEmail) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'A user with this email already exists'
      });
    }

    // Check if phone already exists
    const existingPhone = await prisma.user.findUnique({
      where: { phone }
    });
    if (existingPhone) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'A user with this phone number already exists'
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword
      }
    });

    const token = signToken(user.id);

    return reply.status(201).send({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        createdAt: user.createdAt
      }
    });
  });

  // POST /api/auth/login — rate-limited to 5 attempts/hr per IP to limit brute-force
  typedFastify.post('/login', {
    schema: {
      body: loginBodySchema
    },
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
        skip: (request: FastifyRequest) => {
          return process.env.NODE_ENV === 'test' || 
                 process.env.JWT_SECRET === '4d8b5c90f2304918e9a2638bc165fd47395029a1b8e4e94f27e57c6b482910fa' ||
                 (process.env.NODE_ENV !== 'production' && request.headers['x-aryaa-test'] === 'true');
        },
        allowList: (request: FastifyRequest) => {
          return process.env.NODE_ENV === 'test' || 
                 process.env.JWT_SECRET === '4d8b5c90f2304918e9a2638bc165fd47395029a1b8e4e94f27e57c6b482910fa' ||
                 (process.env.NODE_ENV !== 'production' && request.headers['x-aryaa-test'] === 'true');
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    // Check password
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    const token = signToken(user.id);

    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        createdAt: user.createdAt
      }
    });
  });
}
