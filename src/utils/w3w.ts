import dotenv from 'dotenv';

dotenv.config();

const W3W_API_KEY = process.env.W3W_API_KEY;
const W3W_TIMEOUT_MS = 2000; // 2 seconds safety critical timeout

/**
 * Converts latitude and longitude coordinates into a What3Words 3-word address.
 * 
 * Enforces a strict 2-second timeout using Promise.race() to prevent slow API
 * responses from adding latency to safety-critical SOS trigger flow.
 * 
 * Returns the 3-word address string (e.g. "filled.count.soap") on success,
 * or null on any failure (missing key, timeout, API/network error). Never throws.
 */
export async function getW3WAddress(lat: number, lng: number): Promise<string | null> {
  if (!W3W_API_KEY) {
    console.warn('[W3W] Skipping What3Words lookup: W3W_API_KEY is not configured.');
    return null;
  }


  const url = `https://api.what3words.com/v3/convert-to-3wa?coordinates=${lat},${lng}&key=${W3W_API_KEY}`;

  const fetchPromise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      if (data && typeof data.words === 'string') {
        return data.words;
      }
      throw new Error('Invalid response structure from What3Words API');
    });

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, W3W_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    if (result === null) {
      console.warn(`[W3W] What3Words lookup timed out after ${W3W_TIMEOUT_MS}ms.`);
    }
    return result;
  } catch (error: any) {
    console.warn(`[W3W] What3Words lookup failed: ${error.message || error}`);
    return null;
  }
}
