import { Document } from 'mongoose';

export interface ICrossBridgeRecord extends Document {
  sourceChainId: number;
  sourceChain: string;
  sourceRpc: string;
  sourceFromAddress: string;
  sourceFromTokenName: string;
  sourceFromTokenContractAddress: string;
  sourceFromAmount: string;
  sourceFromHandingFee: string;
  sourceFromRealAmount: string;
  sourceFromTxHash: string;
  sourceFromTxStatus: 'pending' | 'failed' | 'success';

  targetChainId: number;
  targetChain: string;
  targetRpc: string;
  targetToAddress: string;
  targetToTokenName: string;
  targetToTokenContractAddress: string;
  targetToReceiveAmount: string;
  targetToCallContractAddress: string;
  targetToGasStatus: string;
  targetToTxHash: string;
  targetToTxStatus: 'pending' | 'failed' | 'success';

  crossBridgeStatus: 'pending' | 'failed' | 'minted';

  createdAt?: Date;
  updatedAt?: Date;
}
