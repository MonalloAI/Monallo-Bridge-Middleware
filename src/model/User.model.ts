import mongoose, { Schema } from 'mongoose';
import { IUser } from './interface/User.interface';

const UserSchema = new Schema<IUser>({
  address: { type: String, required: true, unique: true },
  chain: {
    type: String,
    enum: ['Ethereum', 'Imua', 'Zetachain'],
    required: true,
  },
});

export default mongoose.model<IUser>('User', UserSchema);
