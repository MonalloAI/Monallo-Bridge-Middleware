import { Document } from 'mongoose';

export interface IUser extends Document {
  address: string; 
  chain: 'Ethereum' | 'Imua' | 'Zetachain'; 
}
