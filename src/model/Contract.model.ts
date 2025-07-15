import mongoose, { Schema } from 'mongoose';
import { IContract } from './interface/Contract.interface';

const ContractSchema = new Schema<IContract>({
  contractAddress: { type: String, required: true, unique: true },
  deployChain: { type: String, required: true },
  deployChainId: { type: Number, required: true },
  contractType: {
    type: Number,
    enum: [0, 1], // 0 = Lock, 1 = Mint
    required: true,
  },
  deployAddress: { type: String, required: true },
});

export default mongoose.model<IContract>('Contract', ContractSchema);
