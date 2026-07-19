import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyToken } from '../utils/auth.js';

// Authenticate hook
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
    }
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    (request as any).userId = decoded.userId;
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  type: z.enum(['police', 'hospital', 'pharmacy', 'fire'])
});

export async function nearbyRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get('/', {
    preHandler: authenticate,
    schema: {
      querystring: nearbyQuerySchema
    }
  }, async (request, reply) => {
    const { lat, lng, type } = request.query;

    const apiKey = process.env.MAPPLS_API_KEY;
    const isProduction = process.env.NODE_ENV === 'production';

    // If API Key is present, attempt to query MapMyIndia (Mappls)
    if (apiKey && apiKey.trim().length > 0) {
      try {
        const mappedKeyword = getMapplsKeyword(type);
        const url = `https://apis.mappls.com/advancedmaps/v1/${apiKey}/nearby?keywords=${encodeURIComponent(mappedKeyword)}&refLocation=${lat},${lng}&radius=2000`;
        
        console.log(`[MAPPLS_PROXY] Querying Mappls Nearby URL: ${url.replace(apiKey, 'HIDDEN')}`);
        const response = await fetch(url);
        
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && Array.isArray(data.suggestedLocations)) {
            const results = data.suggestedLocations.map((loc: any) => ({
              name: loc.placeName || 'Unknown Place',
              lat: loc.latitude ? parseFloat(loc.latitude) : lat,
              lng: loc.longitude ? parseFloat(loc.longitude) : lng,
              distanceMeters: loc.distance ? parseInt(loc.distance, 10) : 0,
              phone: loc.mobile || null,
              address: loc.addr || null
            }));
            
            // Sort by distance ascending, cap at 15
            const sortedResults = results
              .sort((a: any, b: any) => a.distanceMeters - b.distanceMeters)
              .slice(0, 15);
              
            return reply.status(200).send(sortedResults);
          }
        }
        
        console.warn(`[MAPPLS_PROXY] Mappls API returned status ${response.status}`);
      } catch (err: any) {
        console.error(`[MAPPLS_PROXY] Error calling Mappls API:`, err.message);
      }
    }

    // Fallback logic
    if (isProduction) {
      // Safety constraint: Never return mock data in production
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Nearby services search is currently unavailable. Please try again later or contact emergency services directly.'
      });
    }

    // Development/Testing fallback to realistic mock data
    console.log(`[MAPPLS_PROXY] Returning mock data fallback for type: ${type} (NODE_ENV !== production)`);
    const mockData = getMockServices(lat, lng, type);
    return reply.status(200).send(mockData);
  });
}

function getMapplsKeyword(type: 'police' | 'hospital' | 'pharmacy' | 'fire'): string {
  switch (type) {
    case 'police': return 'police station';
    case 'hospital': return 'hospital';
    case 'pharmacy': return 'pharmacy';
    case 'fire': return 'fire station';
  }
}

// Distance calculator (haversine formula)
function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // metres
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

function getMockServices(lat: number, lng: number, type: 'police' | 'hospital' | 'pharmacy' | 'fire') {
  const policeNames = [
    { name: 'Sardar Cantonment Police Station', phone: '020-26122880', address: '12, Gen. Thimayya Road, Pune Camp' },
    { name: 'Bund Garden Police Station', phone: '020-26123344', address: 'Bund Garden Road, near Pune Railway Station' },
    { name: 'Koregaon Park Police Chowky', phone: '020-26124455', address: 'North Main Road, Lane 5, Koregaon Park' },
    { name: 'Shivajinagar Police Station', phone: '020-25501122', address: 'PMT Building, Shivajinagar, Pune' },
    { name: 'Deccan Gymkhana Police Station', phone: '020-25678899', address: 'Prabhat Road, Deccan Gymkhana' }
  ];

  const hospitalNames = [
    { name: 'Ruby Hall Clinic', phone: '020-66455100', address: '40, Sassoon Road, near Pune Station' },
    { name: 'Jehangir Hospital', phone: '020-66819999', address: '32, Sassoon Road, Pune' },
    { name: 'KEM Hospital', phone: '020-26217300', address: '489, Rasta Peth, Pune' },
    { name: 'Sassoon General Hospital', phone: '020-26128000', address: 'Jai Prakash Narayan Road, near Pune Station' },
    { name: 'Poona Hospital & Research Centre', phone: '020-66096000', address: '27, LBS Road, Sadashiv Peth' }
  ];

  const pharmacyNames = [
    { name: 'Apollo Pharmacy', phone: '1860-500-0101', address: 'Shop 3, North Main Road, Koregaon Park' },
    { name: 'Wellness Forever 24x7', phone: '020-26121111', address: 'Central Street, Pune Camp' },
    { name: 'MedPlus Pharmacy', phone: '020-25654321', address: 'FC Road, Shivajinagar' },
    { name: 'Poona Chemist & Druggist', phone: '020-24456789', address: 'Laxmi Road, Budhwar Peth' },
    { name: 'Noble Chemist', phone: '020-26134567', address: 'Sassoon Road, opposite Jehangir Hospital' }
  ];

  const fireNames = [
    { name: 'Central Fire Station (Pune City)', phone: '101', address: '455, Budhwar Peth, Pune' },
    { name: 'Cantonment Fire Station', phone: '020-26361111', address: 'Cantonment Board Office, Pune Camp' },
    { name: 'Erandwane Fire Station', phone: '020-25442222', address: 'Karve Road, Erandwane, Pune' },
    { name: 'Aundh Fire Station', phone: '020-25883333', address: 'Aundh-Baner Link Road, Aundh' },
    { name: 'Hadapsar Fire Station', phone: '020-26814444', address: 'Solapur Road, Hadapsar' }
  ];

  const sourceList = (() => {
    switch (type) {
      case 'police': return policeNames;
      case 'hospital': return hospitalNames;
      case 'pharmacy': return pharmacyNames;
      case 'fire': return fireNames;
    }
  })();

  // Shift coordinates by small random offsets to simulate geographic proximity
  return sourceList.map((item, index) => {
    const offsetLat = (index + 1) * 0.003 * (index % 2 === 0 ? 1 : -1);
    const offsetLng = (index + 1) * 0.004 * (index % 3 === 0 ? 1 : -1);
    const itemLat = lat + offsetLat;
    const itemLng = lng + offsetLng;
    const distance = getDistanceMeters(lat, lng, itemLat, itemLng);

    return {
      name: item.name,
      lat: itemLat,
      lng: itemLng,
      distanceMeters: distance,
      phone: item.phone,
      address: item.address
    };
  }).sort((a, b) => a.distanceMeters - b.distanceMeters);
}
