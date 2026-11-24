// config/db.js
// MongoDB Atlas connection via Mongoose. Never logs or exposes MONGODB_URI.
import mongoose from 'mongoose';

let _connectPromise = null;

export function isMongoConfigured() {
  const uri = process.env.MONGODB_URI || '';
  return Boolean(uri.trim() && !/^REPLACE_WITH|^your_mongodb/i.test(uri.trim()));
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

export async function connectDB() {
  if (isDbConnected()) return mongoose.connection;
  if (!isMongoConfigured()) {
    const err = new Error(
      'MongoDB is not configured on the server yet. Add MONGODB_URI to askmed-backend/.env and restart.'
    );
    err.status = 503;
    throw err;
  }
  if (!_connectPromise) {
    _connectPromise = mongoose
      .connect(process.env.MONGODB_URI.trim(), {
        serverSelectionTimeoutMS: 10000,
      })
      .then((m) => {
        console.log('[mongodb] Connected to MongoDB Atlas');
        return m.connection;
      })
      .catch((err) => {
        _connectPromise = null;
        throw err;
      });
  }
  return _connectPromise;
}

