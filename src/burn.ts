import { ethers, WebSocketProvider } from 'ethers';
import * as dotenv from 'dotenv';
import BurnManagerAbi from './abi/BurnManager.json';
import MintTokensAbi from './abi/MintTokens.json';
import LockTokensAbi from './abi/LockTokens.json';
import { connectDB } from './db';
import CrossBridgeRecord from './model/CrossBridgeRecord.model';
import { sendToUser } from './WebSocket/websocket';
import { QueueChecker } from './utils/queueChecker';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const {
    PRIVATE_KEY,
    IMUA_RPC_URL,
    ETH_RPC_URL,
    ETH_API_KEY,
    PLATON_RPC_URL
} = process.env;

if (!PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL || !PLATON_RPC_URL) {
    throw new Error('❌ 请检查 .env 文件，确保所有必要的环境变量已配置');
}

// 读取部署地址配置文件
const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, './abi/deployed_addresses.json'), 'utf8'));

function createWssProvider(url: string): ethers.Provider {
    if (!url.startsWith('wss')) {
        throw new Error(`❌ 非 wss 链接，请检查 provider URL: ${url}`);
    }
    return new WebSocketProvider(url);
}

// 创建提供者
const imuaProvider = createWssProvider(IMUA_RPC_URL); 
const sepoliaProvider = createWssProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const platonProvider = createWssProvider(PLATON_RPC_URL);

// 创建钱包
const wallet = new ethers.Wallet(PRIVATE_KEY!);
const imuaWallet = wallet.connect(imuaProvider);
const sepoliaWallet = wallet.connect(sepoliaProvider);
const platonWallet = wallet.connect(platonProvider);

// 创建源链的锁定合约实例 - 使用新的配置结构
const sepoliaLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['Ethereum-Sepolia'],
    LockTokensAbi.abi,
    sepoliaWallet
);

const platonLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['PlatON-Mainnet'],
    LockTokensAbi.abi,
    platonWallet
);

export async function startBurnListening() {
    await connectDB();
    console.log('✅ 已连接数据库，准备监听 IMUA 链上所有目标合约的 Burned 事件...');

    // 初始化队列检查器
    const queueChecker = new QueueChecker({
        mintContract: new ethers.Contract(deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet']['maoETH'], MintTokensAbi.abi, imuaWallet),
        lockTokensContract: sepoliaLockContract,
        bProvider: imuaProvider,
        ethProvider: sepoliaProvider,
        wallet: imuaWallet
    });
    
    // 启动时检查待处理队列
    await queueChecker.checkPendingQueue();
    
    // 监听所有 IMUA 链上的目标合约
    const targetContracts = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];

    if (targetContracts !== null && typeof targetContracts === 'object') {
        for (const [tokenKey, contractValue] of Object.entries(targetContracts)) {
            if (typeof contractValue === 'string') {
                // 跳过空地址的监听（如 IMUA 原生代币）
                if (contractValue && contractValue.trim() !== '') {
                    listenToBurnContract(contractValue, tokenKey, queueChecker);
                } else {
                    console.log(`⏭️ 跳过空地址的合约监听: ${tokenKey}`);
                }
            } else if (contractValue !== null && typeof contractValue === 'object') {
                // 处理嵌套对象（如 maoUSDC 根据目标网络不同使用不同地址）
                const nestedContracts = contractValue as { [key: string]: unknown };
                for (const [networkType, address] of Object.entries(nestedContracts)) {
                    if (typeof address === 'string' && address && address.trim() !== '') {
                        listenToBurnContract(address, `${tokenKey}_${networkType}`, queueChecker);
                    } else if (typeof address === 'string' && (!address || address.trim() === '')) {
                        console.log(`⏭️ 跳过空地址的嵌套合约监听: ${tokenKey}_${networkType}`);
                    }
                }
            }
        }
    }
    
    // 定期检查队列（每30分钟检查一次）
    setInterval(async () => {
        try {
            console.log('🔄 定期检查队列...');
            await queueChecker.checkPendingQueue();
            console.log('✅ 定期队列检查完成');
        } catch (error) {
            console.error('❌ 定期队列检查失败:', error);
        }
    }, 30 * 60 * 1000); // 30分钟
}

async function listenToBurnContract(contractAddress: string, contractKey: string, queueChecker: QueueChecker) {
    console.log(`🔥 开始监听合约 ${contractKey} (${contractAddress}) 的 TokensBurned 事件`);
    
    // 创建合约实例（使用 MintTokens ABI，因为我们要监听 TokensBurned 事件）
    const burnContract = new ethers.Contract(contractAddress, MintTokensAbi.abi, imuaProvider);
    
    burnContract.on('TokensBurned', (...args) => {
        const event = args[args.length - 1];
        handleBurnedEvent(event, contractKey, queueChecker);
    });
}

async function handleBurnedEvent(event: any, contractKey: string, queueChecker: QueueChecker) {
    try {
        // 确保 event 对象包含必要的属性
        if (!event || !event.args || !event.log) {
            console.error('❌ 事件对象缺少必要的属性:', event);
            return;
        }

        const txHash = event.log.transactionHash;
        console.log(`🔥 检测到 TokensBurned 事件 - 合约: ${contractKey}, 交易哈希: ${txHash}`);
        
        // 解析事件参数
        const { transactionId, burner: user, sourceChainId, recipientAddress, amount } = event.args;
        
        // === 动态币种映射：根据销毁合约地址查找币种类型和目标链 ===
        // 1. 获取 deployedAddresses
        const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, './abi/deployed_addresses.json'), 'utf8'));
        // 2. 反查币种类型和 maoKey
        function findBurnedTokenTypeAndMaoKey(burnedAddress: string) {
            const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
            for (const [maoKey, value] of Object.entries(imuaTokens)) {
                if (typeof value === 'string') {
                    if (value.toLowerCase() === burnedAddress.toLowerCase()) {
                        return { type: maoKey.replace('mao', ''), maoKey, sourceChain: null };
                    }
                } else if (typeof value === 'object' && value !== null) {
                    for (const [chain, addr] of Object.entries(value)) {
                        if (typeof addr === 'string' && addr.toLowerCase() === burnedAddress.toLowerCase()) {
                            return { type: maoKey.replace('mao', ''), maoKey, sourceChain: chain };
                        }
                    }
                }
            }
            return null;
        }
        // 3. 获取目标链币种合约地址
        function getTargetTokenAddress(tokenType: string, targetChainName: string) {
            // 原生币
            const nativeMap = {
                'ETH': '0x0000000000000000000000000000000000000000',
                'LAT': '0x0000000000000000000000000000000000000000',
                'IMUA': '0x0000000000000000000000000000000000000000',
                'ZETA': '0x0000000000000000000000000000000000000000',
            };
            if (nativeMap[tokenType.toUpperCase() as keyof typeof nativeMap]) return nativeMap[tokenType.toUpperCase() as keyof typeof nativeMap];
            // ERC20
            const tokenContracts = deployedAddresses.TOKEN_CONTRACTS[targetChainName];
            if (!tokenContracts) return null;
            // 先查主币名
            if (tokenContracts[tokenType]) return tokenContracts[tokenType];
            // 再查锚定币名
            if (tokenContracts['mao' + tokenType]) return tokenContracts['mao' + tokenType];
            return null;
        }
        // 4. 反查币种类型
        const burnedTokenInfo = findBurnedTokenTypeAndMaoKey(event.log.address);
        if (!burnedTokenInfo) {
            console.error('❌ 未能识别销毁的锚定币种:', event.log.address);
            return;
        }
        // 5. 获取目标链名
        let targetChainKey = '';
        const sourceChainIdNum = parseInt(sourceChainId.toString());
        if (sourceChainIdNum === 11155111) targetChainKey = 'Ethereum-Sepolia';
        else if (sourceChainIdNum === 210425) targetChainKey = 'PlatON-Mainnet';
        else if (sourceChainIdNum === 7001) targetChainKey = 'ZetaChain-Testnet';
        else if (sourceChainIdNum === 233) targetChainKey = 'Imua-Testnet';
        else {
            console.error('❌ 不支持的目标链ID:', sourceChainIdNum);
            return;
        }
        // 6. 获取目标链币种合约地址
        let tokenAddress = getTargetTokenAddress(burnedTokenInfo.type, targetChainKey);
        if (!tokenAddress) {
            console.error('❌ 未找到目标链币种合约地址:', burnedTokenInfo.type, targetChainKey);
            return;
        }
        // 7. 单位换算（USDC等6位币种）
        let unlockAmount = amount;
        const decimals6 = ['USDC', 'maoUSDC'];
        if (decimals6.includes(burnedTokenInfo.type.toUpperCase())) {
            unlockAmount = amount * BigInt(10 ** 12);
        }

        // 确保所有必要的参数都存在
        if (!transactionId || !user || !sourceChainId || !recipientAddress || !amount || !tokenAddress) {
            console.error('❌ 事件参数不完整:', event.args);
            return;
        }

        console.log(`📋 TokensBurned 事件详情:`, {
            transactionId: transactionId.toString(),
            user,
            sourceChainId: sourceChainId.toString(),
            recipientAddress,
            tokenAddress,
            amount: ethers.formatEther(amount),
            txHash
        });
        
        // 检查数据库中是否已存在该记录
        const existingRecord = await CrossBridgeRecord.findOne({ transactionId: transactionId.toString() });
        if (existingRecord) {
            console.log(`⚠️ 交易ID ${transactionId.toString()} 已存在，跳过处理`);
            return;
        }
        
        // 根据源链ID确定要解锁的链和合约
        let unlockContract;
        let unlockProvider;
        let targetChainName;
        
        if (sourceChainIdNum === 11155111) { // Sepolia
            unlockContract = sepoliaLockContract;
            unlockProvider = sepoliaProvider;
            targetChainName = 'Ethereum-Sepolia';
        } else if (sourceChainIdNum === 210425) { // Platon
            unlockContract = platonLockContract;
            unlockProvider = platonProvider;
            targetChainName = 'PlatON-Mainnet';
        } else if (sourceChainIdNum === 233) { // Imua
            // Imua 链上的销毁事件，需要解锁到对应的源链
            // 这里需要根据具体情况决定解锁到哪个链
            console.log(`🔍 Imua 链上的销毁事件，需要确定解锁目标链`);
            return;
        } else if (sourceChainIdNum === 7001) { // ZetaChain
            // ZetaChain 链上的销毁事件，需要解锁到对应的源链
            console.log(`🔍 ZetaChain 链上的销毁事件，需要确定解锁目标链`);
            return;
        } else {
            console.error(`❌ 不支持的源链ID: ${sourceChainIdNum}`);
            return;
        }
        
        console.log(`🔓 准备在 ${targetChainName} 链上解锁代币`);
        
        // === 代币类型映射：锚定代币映射为原生代币 ===
        const tokenMapping: { [key: string]: string } = {
            // 只保留原生币的映射
            '0x4a91a4a24b6883dbbddc6e6704a3c0e96396d2e9': '0x0000000000000000000000000000000000000000', // maoETH -> ETH
            '0x924a9fb56b2b1b5554327823b201b7eef691e524': '0x0000000000000000000000000000000000000000', // maoLAT -> LAT
            '0xfce1ac30062efdd9119f6527392d4b935397f714': '0x0000000000000000000000000000000000000000', // maoZETA -> ZETA
            '0xdfec8f8c99ec22aa21e392aa00efb3f517c44987': '0x0000000000000000000000000000000000000000', // maoEURC -> EURC
            // 不要映射 maoUSDC、maoUSDT、maoEURC
        };
        const originalTokenAddress = tokenAddress;
        const tokenAddressStr = tokenAddress.toString().toLowerCase();
        const mappedTokenAddress = tokenMapping[tokenAddressStr];
        if (mappedTokenAddress) {
            tokenAddress = mappedTokenAddress;
            console.log(`🔄 检测到锚定代币 ${originalTokenAddress}，解锁时映射为原生代币 ${tokenAddress}`);
        }

        // 创建跨链记录，确保所有必填字段都有值
        const crossBridgeRecord = new CrossBridgeRecord({
            transactionId: transactionId.toString(),
            sourceChainId: 233, // IMUA 链ID
            sourceChain: 'imua',
            sourceRpc: IMUA_RPC_URL,
            sourceFromAddress: user,
            sourceFromTokenName: contractKey.split('_').pop() || 'unknown', // 从合约键名中提取代币名称
            sourceFromTokenContractAddress: tokenAddress, // 确保这个字段有值
            sourceFromAmount: amount.toString(),
            sourceFromHandingFee: '0', // 假设手续费为0，根据实际情况修改
            sourceFromRealAmount: amount.toString(),
            sourceFromTxHash: txHash, // 确保这个字段有值
            sourceFromTxStatus: 'success',

            targetChainId: sourceChainIdNum,
            targetChain: targetChainName.toLowerCase(),
            targetRpc: sourceChainIdNum === 11155111 ? `${ETH_RPC_URL}${ETH_API_KEY}` : PLATON_RPC_URL,
            targetToAddress: recipientAddress,
            targetToTokenName: contractKey.split('_').pop() || 'unknown', // 假设目标代币名称与源代币相同
            targetToTokenContractAddress: tokenAddress, // 确保这个字段有值
            targetToReceiveAmount: amount.toString(),
            targetToCallContractAddress: unlockContract.target,
            targetToGas: '0', // 稍后在执行解锁时更新
            targetToTxHash: '0x', // 稍后在执行解锁时更新
            targetToTxStatus: 'pending',

            crossBridgeStatus: 'pending',
        });
        
        await crossBridgeRecord.save();
        console.log(`✅ 已保存跨链记录到数据库`);
        
        // 执行解锁操作
        try {
            console.log(`🔓 开始在 ${targetChainName} 链上解锁代币...`);
            
            // 根据 LockTokens.json ABI，正确的函数名是 unlock 而不是 unlockTokens
            // unlock 函数需要 5 个参数：_txId, _token, _recipient, _amount, _signature
            
            // 生成签名 - 参考 index.ts 中的签名生成逻辑
            console.log('🔐 开始生成签名...');
            
            // 构造消息哈希（匹配合约逻辑）
            // 合约期望的消息哈希格式：keccak256(abi.encodePacked(txId, token, recipient, amount))
            // 注意：合约中没有包含 address(this)，这是我们之前的错误
            const messageHash = ethers.solidityPackedKeccak256(
                ['bytes32', 'address', 'address', 'uint256'],
                [transactionId, tokenAddress, recipientAddress, unlockAmount]
            );
            
            console.log('🔐 消息哈希:', messageHash);
            console.log('🔐 签名参数:', {
                txId: transactionId,
                token: tokenAddress,
                recipient: recipientAddress,
                amount: unlockAmount.toString()
            });
            
            // 将哈希转换为以太坊签名消息格式
            // 在合约中使用了 messageHash.toEthSignedMessageHash()
            const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));
            console.log('🔐 以太坊签名消息哈希:', ethSignedMessageHash);
            
            // 使用钱包签名消息
            let wallet;
            if (targetChainName === 'Ethereum-Sepolia') {
                wallet = sepoliaWallet;
            } else if (targetChainName === 'PlatON-Mainnet') {
                wallet = platonWallet;
            } else {
                console.error(`❌ 未知的目标链: ${targetChainName}`);
                return;
            }
            
            // 直接对原始消息哈希进行签名，ethers.js 会自动添加前缀
            const signature = await wallet.signMessage(ethers.getBytes(messageHash));
            
            console.log('✅ 签名生成成功:', signature.slice(0, 20) + '...');
            
            // 检查合约中的代币余额
            console.log('🔍 检查合约代币余额...');
            try {
                let contractBalance;
                let tokenContract;
                let symbol = 'ETH';
                let decimals = 18;
                
                if (tokenAddress === '0x0000000000000000000000000000000000000000') {
                    // 检查原生代币余额
                    // 确保使用正确的provider
                    contractBalance = await unlockProvider.getBalance(unlockContract.target);
                    console.log(`💰 合约原生代币余额: ${ethers.formatEther(contractBalance)} ETH`);
                } else {
                    // 检查ERC20代币余额
                    tokenContract = new ethers.Contract(
                        tokenAddress,
                        [
                            'function balanceOf(address account) view returns (uint256)',
                            'function symbol() view returns (string)',
                            'function decimals() view returns (uint8)',
                            'function allowance(address owner, address spender) view returns (uint256)'
                        ],
                        unlockProvider
                    );
                    
                    contractBalance = await tokenContract.balanceOf(unlockContract.target);
                    symbol = await tokenContract.symbol().catch(() => 'TOKEN');
                    decimals = await tokenContract.decimals().catch(() => 18);
                    
                    console.log(`💰 合约 ${symbol} 代币余额: ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
                    
                    // 检查代币是否已经授权给合约
                    try {
                        // 检查钱包对合约的授权
                        // 使用对应链的钱包地址
                        const walletAddress = sourceChainIdNum === 11155111 ? 
                            await sepoliaWallet.getAddress() : 
                            await platonWallet.getAddress();
                        const allowance = await tokenContract.allowance(walletAddress, unlockContract.target);
                        console.log(`🔑 钱包对合约的授权额度: ${ethers.formatUnits(allowance, decimals)} ${symbol}`);
                        
                        if (allowance < unlockAmount) {
                            console.error(`❌ 授权额度不足! 需要 ${ethers.formatUnits(unlockAmount, decimals)} ${symbol}，但只授权了 ${ethers.formatUnits(allowance, decimals)} ${symbol}`);
                            console.log('💡 请确保已经授权足够的代币给合约');
                            return;
                        }
                    } catch (allowanceError) {
                        console.error('❌ 检查授权额度时出错:', allowanceError);
                    }
                }
                
                // 检查余额是否足够
                if (contractBalance < unlockAmount) {
                    console.error(`❌ 合约余额不足! 需要 ${ethers.formatUnits(unlockAmount, decimals)} ${symbol}，但只有 ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
                    console.log('💡 请确保合约中有足够的代币余额');
                    return;
                }
                
                console.log('✅ 合约余额充足，继续执行...');
            } catch (balanceError) {
                console.error('❌ 检查余额时出错:', balanceError);
            }
            
            // 测试签名是否有效
            console.log('🧪 测试签名有效性...');
            try {
                await unlockContract.unlock.staticCall(
                    transactionId,
                    tokenAddress,
                    recipientAddress,
                    unlockAmount,
                    signature
                );
                console.log('✅ 签名验证成功！准备执行实际 unlock 操作');
            } catch (testError) {
                console.error('❌ 签名验证失败:', testError);
                console.log('💡 可能需要进一步调试签名格式');
                return;
            }
            
            // 执行 unlock 操作
            const unlockTx = await unlockContract.unlock(
                transactionId,
                tokenAddress,
                recipientAddress,
                unlockAmount,
                signature,
                { gasLimit: 500000 } // 设置足够的 gas 限制
            );
            
            console.log(`📤 解锁交易已发送 - 哈希: ${unlockTx.hash}`);
            
            // 等待交易确认
            const receipt = await unlockTx.wait();
            console.log(`✅ 解锁交易已确认 - 区块: ${receipt.blockNumber}`);
            
            // 更新记录状态
            await CrossBridgeRecord.updateOne(
                { transactionId: transactionId.toString() },
                { 
                    crossBridgeStatus: 'minted',
                    targetToTxHash: unlockTx.hash,
                    targetToTxStatus: 'success',
                    updatedAt: new Date()
                }
            );
            
            console.log(`🎉 跨链解锁完成 - 交易ID: ${transactionId.toString()}`);
            
            // 发送 WebSocket 通知
            sendToUser(recipientAddress, {
                type: 'UNLOCK_SUCCESS',
                data: { 
                    unlockTxHash: unlockTx.hash,
                    transactionId: transactionId.toString(),
                    sourceChain: targetChainName,
                    amount: ethers.formatUnits(unlockAmount, 18)
                }
            });
            
        } catch (unlockError: any) {
            console.error(`❌ 解锁操作失败:`, unlockError);
            
            // 更新记录状态为失败
            await CrossBridgeRecord.updateOne(
                { transactionId: transactionId.toString() },
                { 
                    crossBridgeStatus: 'failed',
                    targetToTxStatus: 'failed',
                    updatedAt: new Date()
                }
            );
            
            // 发送 WebSocket 通知
            sendToUser(recipientAddress, {
                type: 'UNLOCK_FAILED',
                data: { 
                    error: unlockError.message,
                    transactionId: transactionId.toString(),
                    sourceChain: targetChainName
                }
            });
        }
        
    } catch (error) {
        console.error(`❌ 处理 Burned 事件时出错:`, error);
    }
}

if (require.main === module) {
    startBurnListening();
}
