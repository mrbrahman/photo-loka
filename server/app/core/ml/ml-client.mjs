import { config } from '#config';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function recognizeFaces(uuid, imagePath, orientation, xmpRegions) {
  const url = `${config.mlServiceUrl}/faces/recognize`;

  const body = {
    image_id: uuid,
    image_path: imagePath,
    orientation: orientation || 1,
  };

  if (xmpRegions) {
    body.xmp_regions = xmpRegions;
  }

  logger.info(`Calling ML face recognition for ${uuid}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }

  return await response.json();
}
