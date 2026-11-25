import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;

// Connects on first use. Call from anywhere: const redis = getRedis();
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // don't loop endlessly when Redis is down
    });
    // Prevent unhandled error events in node when Redis is unavailable
    redis.on('error', () => {});
  }
  return redis;
}
