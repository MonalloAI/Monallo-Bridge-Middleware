import mongoose, { Schema } from 'mongoose';
import { ILog } from './interface/Log.interface';

const LogSchema = new Schema<ILog>({
  address: { type: String, required: true },
  event: {
    type: String,
    enum: ['connect', 'bridge'],
    required: true,
  },
  IP: { type: String, required: true },
  Browser: { type: String, required: true },
  System: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

export default mongoose.model<ILog>('Log', LogSchema);
