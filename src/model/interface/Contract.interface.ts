import { Document } from 'mongoose';

export interface IContract extends Document {
  contractAddress: string; 
  deployChain: string;
  deployChainId: number;
  contractType: 0 | 1; // 0 = 锁币合约, 1 = 铸币合约
  deployAddress: string;
}
