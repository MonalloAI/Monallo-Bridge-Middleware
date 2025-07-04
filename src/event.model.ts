import mongoose from 'mongoose';

const eventSchema = new mongoose.Schema({
  event: { type: String, required: true },
  from: String,
  to: String,
  owner: String,
  spender: String,
  value: String,
  blockNumber: Number,
  transactionHash: String,
  timestamp: { type: Date, default: Date.now }
});

eventSchema.index({ transactionHash: 1, blockNumber: 1 ,logIndex:1}, { unique: true });

export const EventModel = mongoose.model('Event', eventSchema); 