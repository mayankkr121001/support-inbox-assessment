import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let customDb: Db | undefined;

/**
 * Sets a custom DB instance (useful for unit tests or mocking).
 */
export function setDb(db: Db | undefined): void {
  customDb = db;
}

/**
 * Connects to MongoDB if not already connected and returns the database instance.
 */
export async function getDb(): Promise<Db> {
  if (customDb) return customDb;
  if (!client) {
    client = new MongoClient(config.mongoUrl, {
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
  }
  return client.db();
}

/**
 * Creates required MongoDB indexes if they do not already exist.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('conversations').createIndex(
      { workspace: 1, contact: 1 },
      { unique: true },
    ),
    db.collection('conversations').createIndex(
      { workspace: 1, lastActivityAt: -1 },
    ),
    db.collection('messages').createIndex(
      { workspace: 1, messageId: 1 },
      {
        unique: true,
        partialFilterExpression: { messageId: { $type: 'string' } },
      },
    ),
    db.collection('messages').createIndex(
      { workspace: 1, contact: 1, occurredAt: 1, messageId: 1 },
    ),
    db.collection('webhook_events').createIndex(
      { eventId: 1 },
      { unique: true },
    ),
  ]);
}

/**
 * Establishes the initial MongoDB connection, verifies connectivity, and ensures indexes.
 */
export async function connectDb(): Promise<Db> {
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  return db;
}

/**
 * Checks whether MongoDB responds to a ping command.
 */
export async function pingDb(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the MongoDB connection cleanly during shutdown.
 */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}
