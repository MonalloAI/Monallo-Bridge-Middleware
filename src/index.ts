import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import LockTokensAbi from './abi/LockTokens.json';
import MintTokensAbi from './abi/MintTokens.json';
import { connectDB } from './db';
import CrossBridgeRecord from './model/CrossBridgeRecord.model';
import { sendToUser } from './WebSocket/websocket';
import ws from 'ws';
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
    throw new Error('请检查 .env 文件，相关环境变量未配置完整');
}

// 读取部署地址配置文件
const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, './abi/deployed_addresses.json'), 'utf8'));

// 创建提供者
const sepoliaProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const platonProvider = new ethers.WebSocketProvider(PLATON_RPC_URL!);

// 为 IMUA 网络创建提供者，使用自定义网络配置
const imuaNetwork = {
    chainId: 233,
    name: 'imua'
};
const imuaProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!, imuaNetwork);

// 创建钱包
const wallet = new ethers.Wallet(PRIVATE_KEY!);
const sepoliaWallet = wallet.connect(sepoliaProvider);
const platonWallet = wallet.connect(platonProvider);
const imuaWallet = wallet.connect(imuaProvider);

// 创建合约实例
const sepoliaLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['Ethereum-Sepolia'],
    LockTokensAbi.abi,
    sepoliaProvider
);

const platonLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['PlatON-Mainnet'],
    LockTokensAbi.abi,
    platonProvider
);

// 创建 Imua 网络的锁币合约实例
const imuaLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['Imua-Testnet'],
    LockTokensAbi.abi,
    imuaProvider
);

// 创建 ZetaChain 网络的锁币合约实例
const zetaChainLockContract = new ethers.Contract(
    deployedAddresses.LOCK_CONTRACTS['ZetaChain-Testnet'],
    LockTokensAbi.abi,
    imuaProvider // 使用 imuaProvider，因为 ZetaChain 可能使用相同的 RPC
);

// 创建目标链的Mint合约
const mintContract = new ethers.Contract(
    deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet']['maoETH'], // 默认使用sepolia对应的目标合约
    MintTokensAbi.abi,
    imuaWallet
);

export async function startListening() {
    await connectDB();
    console.log('✅ 已连接数据库，开始监听多个源链 LockTokens 合约的 AssetLocked 事件...');
    
    // 初始化队列检查器
    const queueChecker = new QueueChecker({
        mintContract,
        lockTokensContract: sepoliaLockContract, // 默认使用sepolia的锁定合约
        bProvider: imuaProvider,
        ethProvider: sepoliaProvider,
        wallet: imuaWallet
    });
    
    // 启动时检查待处理队列
    await queueChecker.checkPendingQueue();
    
    // 监听Sepolia网络的合约
    listenToContract(sepoliaLockContract, sepoliaProvider, queueChecker, 'Ethereum-Sepolia');
    
    // 监听Platon网络的合约
    listenToContract(platonLockContract, platonProvider, queueChecker, 'PlatON-Mainnet');
    
    // 监听 Imua 网络的合约
    listenToContract(imuaLockContract, imuaProvider, queueChecker, 'Imua-Testnet');

    // 监听 ZetaChain 网络的合约
    listenToContract(zetaChainLockContract, imuaProvider, queueChecker, 'ZetaChain-Testnet');
    
    // 全局定期检查队列（每30分钟检查一次）
    setInterval(async () => {
        try {
            console.log('🔄 全局定期检查队列...');
            await queueChecker.checkPendingQueue();
            console.log('✅ 全局定期队列检查完成');
        } catch (error) {
            console.error('❌ 全局定期队列检查失败:', error);
        }
    }, 30 * 60 * 1000); // 30分钟
}

async function listenToContract(lockContract: ethers.Contract, provider: ethers.WebSocketProvider, queueChecker: QueueChecker, networkName: string) {
    console.log(`✅ 开始监听 ${networkName} 网络上的 LockTokens 合约地址: ${lockContract.target}`);
    
    const socket = provider.websocket as ws.WebSocket;

    lockContract.on('AssetLocked', async (transactionId, user, destinationChainId, recipientAddress, tokenAddress, amount, fee, event) => {
        console.log(`🔔 监听到 ${networkName} 网络上的 AssetLocked 事件:`);
        
        // 安全的序列化函数，处理BigInt
        const safeStringify = (obj: any) => {
            return JSON.stringify(obj, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value, 2
            );
        };

        // 调试：打印所有参数
        console.log('🔍 事件参数调试信息:', {
            transactionId: transactionId.toString(),
            user: user.toString(),
            destinationChainId: destinationChainId.toString(),
            recipientAddress: recipientAddress.toString(),
            tokenAddress: tokenAddress.toString(),
            amount: amount.toString(),
            fee: fee.toString(),
            eventType: typeof event,
            eventKeys: Object.keys(event || {}),
        });

        // 使用正确的参数名称
        const sender = user;
        const receiver = recipientAddress;

        // 在ethers.js v6中，event参数包含了交易信息
        let txHash;
        
        // 优先从事件对象中获取真正的区块链交易哈希
        if (event && event.log && event.log.transactionHash) {
            txHash = event.log.transactionHash;
            console.log('✅ 从 event.log.transactionHash 获取到交易哈希:', txHash);
        } else if (event && event.transactionHash) {
            txHash = event.transactionHash;
            console.log('✅ 从 event.transactionHash 获取到交易哈希:', txHash);
        } else if (event && event.hash) {
            txHash = event.hash;
            console.log('✅ 从 event.hash 获取到交易哈希:', txHash);
        } else {
            // 如果event对象不包含交易哈希，我们需要通过其他方式获取
            console.log('🔍 event对象不包含交易哈希，尝试其他方式...');
            console.log('完整event对象:', safeStringify(event));
            
            // 在某些情况下，我们可能需要通过查询最新的交易来获取
            try {
                const latestBlock = await provider.getBlockNumber();
                const block = await provider.getBlock(latestBlock);
                if (block && block.transactions.length > 0) {
                    // 获取最新的交易哈希作为候选
                    const latestTx = block.transactions[block.transactions.length - 1];
                    console.log('🔍 尝试使用最新交易哈希:', latestTx);
                    txHash = latestTx;
                }
            } catch (blockError) {
                console.error('❌ 获取最新区块失败:', blockError);
                return;
            }
        }
        
        // 记录 transactionId 用于调试，但不作为交易哈希使用
        console.log('🔍 事件中的 transactionId (仅用于调试):', transactionId);
        
        if (!txHash) {
            console.error('❌ 无法获取交易哈希');
            return;
        }

        // 根据 tokenAddress 和源链ID选择对应的目标合约
        let targetContractAddress;
        let sourceChainId;
        
        console.log('🔍 代币地址分析:', {
            tokenAddress: tokenAddress.toString(),
            networkName,
            destinationChainId: destinationChainId.toString()
        });
        
        // 根据源链网络确定 sourceChainId
        if (networkName === 'Ethereum-Sepolia') {
            sourceChainId = '11155111';
        } else if (networkName === 'PlatON-Mainnet') {
            sourceChainId = '210425';
        } else if (networkName === 'Imua-Testnet') {
            sourceChainId = '233';
        } else if (networkName === 'ZetaChain-Testnet') {
            sourceChainId = '7001';
        } else {
            sourceChainId = '11155111'; // 默认
        }
        
        // 根据 tokenAddress 和目标链选择合适的目标合约
        let tokenType = 'USDT'; // 默认为 USDT
        
        console.log('🔍 开始代币类型判断...');
        
        // 首先根据已知的代币地址直接判断类型（避免 RPC 调用问题）
        const tokenAddr = tokenAddress.toString().toLowerCase();
        if (tokenAddr === '0xda396a3c7fc762643f658b47228cd51de6ce936d') {
            tokenType = 'USDC';
            console.log('🔍 根据地址直接判断为 PlatON USDC 代币');
        } else if (tokenAddr === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') {
            tokenType = 'USDC';
            console.log('🔍 根据地址直接判断为 Sepolia USDC 代币');
        } else if (tokenAddr === '0x0000000000000000000000000000000000000000') {
            // 零地址，根据源链判断原生代币类型
            if (networkName === 'Ethereum-Sepolia') {
                tokenType = 'ETH';
            } else if (networkName === 'PlatON-Mainnet') {
                tokenType = 'LAT';
            } else if (networkName === 'Imua-Testnet') {
                tokenType = 'IMUA';
            } else if (networkName === 'ZetaChain-Testnet') {
                tokenType = 'ZETA';
            } else {
                tokenType = 'ETH'; // 默认
            }
            console.log(`🔍 根据源链 ${networkName} 确定原生代币类型: ${tokenType}`);
        } else {
            console.log('🔍 未知代币地址，尝试通过 RPC 读取代币信息...');
            
            // 首先尝试通过 tokenAddress 获取代币信息来确定代币类型
            try {
                console.log('🔍 进入 try 块，开始读取代币信息...');
                // 根据网络选择正确的提供者，避免 ENS 解析问题
                let sourceProvider;
                if (networkName === 'Ethereum-Sepolia') {
                    sourceProvider = sepoliaProvider;
                } else if (networkName === 'PlatON-Mainnet') {
                    sourceProvider = platonProvider;
                } else if (networkName === 'Imua-Testnet') {
                    sourceProvider = imuaProvider;
                } else if (networkName === 'ZetaChain-Testnet') {
                    sourceProvider = imuaProvider;
                } else {
                    sourceProvider = provider; // 默认使用传入的提供者
                }
                
                console.log('🔍 创建代币合约实例...');
                const tokenContract = new ethers.Contract(
                    tokenAddress.toString(),
                    ['function symbol() view returns (string)'],
                    sourceProvider
                );
                
                console.log('🔍 调用 symbol() 方法...');
                const tokenSymbol = await tokenContract.symbol();
                console.log('🔍 源链代币信息:', {
                    address: tokenAddress.toString(),
                    symbol: tokenSymbol,
                    network: networkName
                });
                
                // 根据代币符号确定类型
                if (tokenSymbol.toUpperCase().includes('USDC')) {
                    tokenType = 'USDC';
                } else if (tokenSymbol.toUpperCase().includes('USDT')) {
                    tokenType = 'USDT';
                } else if (tokenSymbol.toUpperCase().includes('EURC')) {
                    tokenType = 'EURC';
                }
            } catch (tokenError: any) {
                console.warn('⚠️ 无法读取源链代币信息，使用默认类型 USDT:', tokenError.message);
                console.error('🔍 详细错误信息:', {
                    error: tokenError.message,
                    code: tokenError.code,
                    reason: tokenError.reason,
                    data: tokenError.data,
                    stack: tokenError.stack
                });
                console.log('💡 尝试根据代币地址判断类型...');
                
                // 根据代币地址判断类型（备用方案）
                if (tokenAddr === '0xda396a3c7fc762643f658b47228cd51de6ce936d') {
                    tokenType = 'USDC';
                    console.log('🔍 根据地址判断为 USDC 代币');
                } else if (tokenAddr === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') {
                    tokenType = 'USDC';
                    console.log('🔍 根据地址判断为 USDC 代币');
                } else {
                    console.log('🔍 无法根据地址判断代币类型，使用默认 USDT');
                }
            }
        }
        
        console.log('🎯 确定代币类型:', tokenType);
        
        console.log('🔍 代币类型判断完成，开始选择目标合约...');
        
        // 根据目标链和代币类型选择合适的目标合约
        if (destinationChainId.toString() === '210425') {
        console.log('🔍 目标链是 PlatON (210425)...');
        // 目标是 Platon 链 (210425)
        const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
        
        if (tokenType === 'USDC' && imuaTokens.maoUSDC && typeof imuaTokens.maoUSDC === 'object') {
            // 使用嵌套的 maoUSDC 配置
            const maoUSDCConfig = imuaTokens.maoUSDC as { [key: string]: string };
            targetContractAddress = maoUSDCConfig['PlatON'];
            console.log(`🎯 选择 Platon 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'LAT' && imuaTokens.maoLAT) {
            targetContractAddress = imuaTokens.maoLAT;
            console.log(`🎯 选择 Platon 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'ETH' && imuaTokens.maoETH) {
            targetContractAddress = imuaTokens.maoETH;
            console.log(`🎯 选择 Platon 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else {
            // 默认使用 maoLAT（因为目标是 PlatON 链）
            targetContractAddress = imuaTokens.maoLAT;
            console.log('🎯 选择 Platon 链默认目标合约 (maoLAT):', targetContractAddress);
        }
    } else if (destinationChainId.toString() === '11155111') {
        // 目标是 Sepolia 链 (11155111)
        const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
        
        if (tokenType === 'USDC' && imuaTokens.maoUSDC && typeof imuaTokens.maoUSDC === 'object') {
            // 使用嵌套的 maoUSDC 配置
            const maoUSDCConfig = imuaTokens.maoUSDC as { [key: string]: string };
            targetContractAddress = maoUSDCConfig['Ethereum-Sepolia'];
            console.log(`🎯 选择 Sepolia 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'ETH' && imuaTokens.maoETH) {
            targetContractAddress = imuaTokens.maoETH;
            console.log(`🎯 选择 Sepolia 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'EURC' && imuaTokens.maoEURC) {
            targetContractAddress = imuaTokens.maoEURC;
            console.log(`🎯 选择 Sepolia 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else {
            // 默认使用 maoETH（因为目标是 Sepolia 链）
            targetContractAddress = imuaTokens.maoETH;
            console.log('🎯 选择 Sepolia 链默认目标合约 (maoETH):', targetContractAddress);
        }
    } else if (destinationChainId.toString() === '7001') {
        // 目标是 ZetaChain 链 (7001)
        const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
        
        if (tokenType === 'ZETA' && imuaTokens.maoZETA) {
            targetContractAddress = imuaTokens.maoZETA;
            console.log(`🎯 选择 ZetaChain 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'USDC' && imuaTokens.maoUSDC) {
            // ZetaChain 可能使用默认的 maoUSDC
            targetContractAddress = imuaTokens.maoUSDC;
            console.log(`🎯 选择 ZetaChain 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else {
            // 默认使用 maoZETA
            targetContractAddress = imuaTokens.maoZETA;
            console.log('🎯 选择 ZetaChain 链默认目标合约 (maoZETA):', targetContractAddress);
        }
    } else if (destinationChainId.toString() === '233') {
        console.log('🔍 目标链是 Imua (233)...');
        // 目标是 Imua 链 (233)
        const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
        
        // 添加调试信息
        console.log('🔍 Imua 链目标合约选择调试:', {
            tokenType,
            tokenTypeType: typeof tokenType,
            tokenTypeLength: tokenType ? tokenType.length : 0,
            sourceChainId,
            hasMaoLAT: !!imuaTokens.maoLAT,
            hasMaoETH: !!imuaTokens.maoETH,
            hasMaoUSDC: !!imuaTokens.maoUSDC,
            hasMaoZETA: !!imuaTokens.maoZETA,
            hasMaoEURC: !!imuaTokens.maoEURC,
            maoLATAddress: imuaTokens.maoLAT,
            maoETHAddress: imuaTokens.maoETH,
            maoUSDCType: typeof imuaTokens.maoUSDC,
            maoUSDCConfig: imuaTokens.maoUSDC
        });
        
        // 条件判断调试
        console.log('🔍 条件判断调试:', {
            isLAT: tokenType === 'LAT',
            isLATStrict: tokenType === 'LAT',
            hasMaoLAT: !!imuaTokens.maoLAT,
            latCondition: tokenType === 'LAT' && imuaTokens.maoLAT
        });
        
        if (tokenType === 'LAT' && imuaTokens.maoLAT) {
            targetContractAddress = imuaTokens.maoLAT;
            console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'USDC' && imuaTokens.maoUSDC) {
            // 处理嵌套的 maoUSDC 配置
            if (typeof imuaTokens.maoUSDC === 'object') {
                // 如果是嵌套对象，根据源链选择正确的地址
                const maoUSDCConfig = imuaTokens.maoUSDC as { [key: string]: string };
                
                // 根据源链选择对应的 maoUSDC 地址
                let selectedAddress;
                if (sourceChainId === '210425') { // PlatON
                    selectedAddress = maoUSDCConfig['PlatON'];
                } else if (sourceChainId === '11155111') { // Sepolia
                    selectedAddress = maoUSDCConfig['Ethereum-Sepolia'];
                } else {
                    // 默认使用第一个可用地址
                    const addresses = Object.values(maoUSDCConfig);
                    selectedAddress = addresses.length > 0 ? addresses[0] : null;
                }
                
                if (selectedAddress) {
                    targetContractAddress = selectedAddress;
                    console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约 (根据源链 ${sourceChainId}):`, targetContractAddress);
                } else {
                    console.warn('⚠️ 无法根据源链选择 maoUSDC 地址');
                    targetContractAddress = imuaTokens.maoETH; // 回退到默认
                }
            } else {
                targetContractAddress = imuaTokens.maoUSDC as string;
                console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约:`, targetContractAddress);
            }
        } else if (tokenType === 'ETH' && imuaTokens.maoETH) {
            targetContractAddress = imuaTokens.maoETH;
            console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'ZETA' && imuaTokens.maoZETA) {
            targetContractAddress = imuaTokens.maoZETA;
            console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else if (tokenType === 'EURC' && imuaTokens.maoEURC) {
            targetContractAddress = imuaTokens.maoEURC;
            console.log(`🎯 选择 Imua 链 ${tokenType} 目标合约:`, targetContractAddress);
        } else {
            // 根据代币类型选择默认合约
            if (tokenType === 'LAT') {
                targetContractAddress = imuaTokens.maoLAT;
                console.log('🎯 选择 Imua 链默认目标合约 (maoLAT):', targetContractAddress);
            } else if (tokenType === 'ETH') {
                targetContractAddress = imuaTokens.maoETH;
                console.log('🎯 选择 Imua 链默认目标合约 (maoETH):', targetContractAddress);
            } else {
                targetContractAddress = imuaTokens.maoETH;
                console.log('🎯 选择 Imua 链默认目标合约 (maoETH):', targetContractAddress);
            }
        }
    } else {
        // 如果没有匹配到明确的目标链，则默认使用Sepolia对应的目标合约
        const imuaTokens = deployedAddresses.TOKEN_CONTRACTS['Imua-Testnet'];
        targetContractAddress = imuaTokens.maoETH;
        console.log('🎯 未匹配到目标链，默认使用 Sepolia 目标合约 (maoETH):', targetContractAddress);
    }
    
    let mintContractProvider;
    if (destinationChainId.toString() === '233') {
        const imuaNetworkConfig = {
            chainId: 233,
            name: 'imua'
        };
        const imuaProviderForContract = new ethers.WebSocketProvider(IMUA_RPC_URL!, imuaNetworkConfig);
        mintContractProvider = new ethers.Wallet(PRIVATE_KEY!, imuaProviderForContract);
    } else {
        mintContractProvider = imuaWallet;
    }
    
    const dynamicMintContract = new ethers.Contract(
        targetContractAddress,
        MintTokensAbi.abi,
        mintContractProvider
    );
    // 金额处理：用户锁定多少就铸造多少，gas费用由中继器承担
    const originalAmount = BigInt(amount.toString());
    const feeAmount = BigInt(fee.toString());
    let mintAmount = originalAmount; // 默认直接用原始金额
    let mintFeeAmount = feeAmount;
    // USDC 特殊处理：6位小数转18位
    if (tokenType === 'USDC') {
        const multiplier = BigInt(10 ** 12);
        mintAmount = originalAmount * multiplier;
        mintFeeAmount = feeAmount * multiplier;
        console.log("🔢 USDC 单位换算详情:");
        console.log("  转换前 originalAmount:", originalAmount.toString());
        console.log("  转换前 feeAmount:", feeAmount.toString());
        console.log("  转换后 mintAmount:", mintAmount.toString());
        console.log("  转换后 mintFeeAmount:", mintFeeAmount.toString());
    }

    // 详细日志记录
    console.log('💰 金额计算详情:');
    console.log(`  用户锁定金额: ${originalAmount.toString()} wei (${ethers.formatUnits(originalAmount, tokenType === 'USDC' ? 6 : 18)} ${tokenType})`);
    console.log(`  手续费: ${feeAmount.toString()} wei (${ethers.formatUnits(feeAmount, tokenType === 'USDC' ? 6 : 18)} ${tokenType})`);
    console.log(`  实际铸造金额: ${mintAmount.toString()} wei (${ethers.formatUnits(mintAmount, 18)} mao${tokenType})`);

    console.log('\n🔔 监听到 AssetLocked 事件:', {
        sender,
        receiver,
        lockedAmount: ethers.formatUnits(originalAmount, tokenType === 'USDC' ? 6 : 18),
        fee: ethers.formatUnits(feeAmount, tokenType === 'USDC' ? 6 : 18),
        mintAmount: ethers.formatUnits(mintAmount, 18),
        txHash
    });

    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || !receipt.blockNumber) {
            console.error('❌ A 链交易未确认，跳过:', txHash);
            return;
        }

        // 更新前先查找记录
        const before = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
        console.log('更新前查到的记录:', before);

        await CrossBridgeRecord.updateOne(
            { sourceFromTxHash: txHash },
            {
                $set: {
                    sourceFromTxStatus: 'success',
                }
            }
        );
    

        const after = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
        console.log('更新后查到的记录:', after);

        const existingRecord = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });

        if (existingRecord?.crossBridgeStatus === 'minted') {
            console.log('⏭️ 事件已处理，跳过:', txHash);
            return;
        }

        // B 链 mint 代币 - 使用动态选择的合约
        // mint函数需要4个参数: txId, recipient, amount, signature
        
        console.log('🔍 合约基本信息检查:', {
            contractAddress: targetContractAddress,
            sourceChainId,
            networkName
        });
        
        // 检查合约代币信息
        try {
            const contractName = await dynamicMintContract.name();
            const contractSymbol = await dynamicMintContract.symbol();
            const contractDecimals = await dynamicMintContract.decimals();
            
            console.log('🪙 合约代币信息:', {
                name: contractName,
                symbol: contractSymbol,
                decimals: contractDecimals.toString(),
                address: targetContractAddress
            });
            
            // 检查是否是期望的代币类型
            const expectedTokenTypes = ['maoUSDT', 'maoLAT', 'maoUSDC'];
            if (!expectedTokenTypes.includes(contractSymbol)) {
                console.warn('⚠️ 警告：合约代币类型可能不正确:', contractSymbol);
                console.log('💡 期望的代币类型:', expectedTokenTypes.join(', '));
            } else {
                console.log('✅ 合约代币类型验证通过:', contractSymbol);
            }
            
        } catch (tokenInfoError: any) {
            // 特别处理 ENS 错误
            if (tokenInfoError.message && tokenInfoError.message.includes('network does not support ENS')) {
                console.warn('⚠️ ENS 解析错误已被忽略（合约代币信息读取）:', tokenInfoError.message);
            } else {
                console.error('❌ 无法读取合约代币信息:', tokenInfoError.message);
            }
        }
        
        let checkProvider;
        if (destinationChainId.toString() === '233') {
            const imuaNetworkConfig = {
                chainId: 233,
                name: 'imua'
            };
            checkProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!, imuaNetworkConfig);
        } else {
            checkProvider = imuaProvider;
        }
        
        const contractCode = await checkProvider.getCode(targetContractAddress);
        console.log('🔍 合约代码检查:', {
            hasCode: contractCode !== '0x',
            codeLength: contractCode.length
        });
        
        if (contractCode === '0x') {
            console.error('❌ 目标地址没有合约代码，可能地址错误或合约未部署');
            return;
        }
        
        // 检查合约余额
        const contractBalance = await checkProvider.getBalance(targetContractAddress);
        console.log('🔍 合约余额:', ethers.formatEther(contractBalance), 'ETH');
        
        // 首先检查合约的relayerSigner地址
        let contractRelayerSigner, ourWalletAddress, isPaused, sourceChainIdFromContract;
        
        try {
            contractRelayerSigner = await dynamicMintContract.relayerSigner();
            ourWalletAddress = imuaWallet.address;
            isPaused = await dynamicMintContract.paused();
            sourceChainIdFromContract = await dynamicMintContract.sourceChainId();
            
            console.log('🔍 合约状态读取成功:', {
                contractRelayerSigner,
                ourWalletAddress,
                isPaused,
                sourceChainIdFromContract: sourceChainIdFromContract.toString(),
                expectedSourceChainId: sourceChainId.toString(),
                chainIdMatch: sourceChainIdFromContract.toString() === sourceChainId.toString()
            });
        } catch (readError: any) {
            console.error('❌ 读取合约状态失败:', readError.message);
            console.log('💡 这可能表明合约ABI不匹配或合约未正确初始化');
            return;
        }
        
        console.log('🔍 地址检查:', {
            contractRelayerSigner,
            ourWalletAddress,
            addressMatch: contractRelayerSigner.toLowerCase() === ourWalletAddress.toLowerCase()
        });
        
        // 检查我们的钱包是否有MINTER_ROLE权限
        const MINTER_ROLE = await dynamicMintContract.MINTER_ROLE();
        const hasMinterRole = await dynamicMintContract.hasRole(MINTER_ROLE, ourWalletAddress);
        
        console.log('🔍 权限检查:', {
            MINTER_ROLE,
            ourWalletAddress,
            hasMinterRole
        });
        
        if (!hasMinterRole) {
            console.error('❌ 钱包没有MINTER_ROLE权限，无法执行mint操作');
            console.log('💡 需要合约管理员为地址', ourWalletAddress, '授予MINTER_ROLE权限');
            return;
        }
        
        // 检查合约是否暂停
        console.log('🔍 合约状态检查:', {
            isPaused
        });
        
        if (isPaused) {
            console.error('❌ 合约处于暂停状态，无法执行mint操作');
            return;
        }
        
        // 检查源链ID是否匹配
        if (sourceChainIdFromContract.toString() !== sourceChainId.toString()) {
            console.warn('⚠️ 源链ID不匹配:', {
                expected: sourceChainId.toString(),
                actual: sourceChainIdFromContract.toString()
            });
            console.log('💡 这可能是正常的，因为不同合约可能有不同的配置，继续执行...');
            // 不中断流程，继续执行
        }
        
        // 检查交易是否已经处理过
        const isProcessed = await dynamicMintContract.processedMintTxs(txHash);
        console.log('🔍 交易处理状态:', {
            txHash,
            isProcessed
        });
        
        if (isProcessed) {
            console.log('⏭️ 交易已处理，跳过:', txHash);
            return;
        }
        
        // 根据合约源码生成正确的签名
        console.log('🔐 开始签名过程（基于合约源码）...');
        
        // 合约期望的消息哈希格式：
        // keccak256(abi.encodePacked(txId, recipient, amount, address(this)))
        // 其中 txId 是事件中的 transactionId，不是区块链交易哈希
        
        console.log('🔐 构造消息哈希（匹配合约逻辑）...');
        const innerHash = ethers.solidityPackedKeccak256(
            ['bytes32', 'address', 'uint256', 'address'],
            [transactionId, receiver, mintAmount, targetContractAddress]
        );
        
        console.log('🔐 内部哈希:', innerHash);
        console.log('🔐 签名参数:', {
            txId: transactionId,
            recipient: receiver,
            amount: mintAmount.toString(),
            contractAddress: targetContractAddress
        });
        
        // 使用 ethers.js 的 signMessage 会自动添加以太坊签名前缀
        // 这与合约中的 messageHash.recover(signature) 匹配
        const signature = await imuaWallet.signMessage(ethers.getBytes(innerHash));
        
        console.log('✅ 签名生成成功:', signature.slice(0, 20) + '...');
        console.log('🔐 最终签名信息:', {
            transactionId,
            receiver,
            amount: mintAmount.toString(),
            signature: signature.slice(0, 20) + '...',
            signatureLength: signature.length
        });
        
        // 测试签名是否有效
        console.log('🧪 测试签名有效性...');
        try {
            await dynamicMintContract.mint.staticCall(
                transactionId,  // 使用 transactionId 作为 txId
                receiver,
                mintAmount,
                signature
            );
            console.log('✅ 签名验证成功！准备执行实际mint操作');
        } catch (testError: any) {
            console.error('❌ 签名验证仍然失败:', testError.message);
            console.log('💡 可能需要进一步调试签名格式');
            return;
        }
        
        // 在实际调用mint之前，先测试一个简单的只读调用
        console.log('🧪 测试合约连接...');
        try {
            const testName = await dynamicMintContract.name();
            const testSymbol = await dynamicMintContract.symbol();
            const testDecimals = await dynamicMintContract.decimals();
            console.log('✅ 合约连接测试成功:', {
                name: testName,
                symbol: testSymbol,
                decimals: testDecimals.toString()
            });
        } catch (testError: any) {
            console.error('❌ 合约连接测试失败:', testError.message);
            console.log('💡 这表明合约ABI或地址可能有问题');
            return;
        }
        
        // 尝试估算gas
        console.log('⛽ 开始估算gas...');
        let gasEstimate;
        try {
            gasEstimate = await dynamicMintContract.mint.estimateGas(
                transactionId,  // txId (bytes32) - 使用 transactionId
                receiver,    // recipient (address)
                mintAmount,      // amount (uint256) - 使用完整的锁定金额
                signature    // signature (bytes)
            );
            console.log('✅ Gas估算成功:', gasEstimate.toString());
        } catch (gasError: any) {
            console.error('❌ Gas估算失败:', gasError.message);
            console.log('🔍 Gas估算错误详情:', {
                code: gasError.code,
                reason: gasError.reason,
                data: gasError.data
            });
            
            // 尝试使用静态调用来获取更多信息
            console.log('🔍 尝试静态调用来诊断问题...');
            try {
                await dynamicMintContract.mint.staticCall(
                    transactionId,  // 使用 transactionId
                    receiver,
                    mintAmount,
                    signature
                );
                console.log('✅ 静态调用成功，问题可能在gas估算');
            } catch (staticError: any) {
                console.error('❌ 静态调用也失败:', staticError.message);
                console.log('💡 这确认了mint函数调用本身有问题');
            }
            return;
        }
        console.log("数量",amount);
        const tx = await dynamicMintContract.mint(
            transactionId,  // txId (bytes32) - 使用 transactionId
            receiver,    // recipient (address)
            mintAmount,      // amount (uint256) - 使用完整的锁定金额
            signature,   // signature (bytes)
            { gasLimit: gasEstimate * BigInt(120) / BigInt(100) } // 增加20%的gas缓冲
        );
        console.log('🚀 已发送 B 链 mint 交易，txHash:', tx.hash);
        await tx.wait();
        console.log('✅ B 链 mint 交易已确认');

        sendToUser(receiver, {
            type: 'MINT_SUCCESS',
            data: { targetToTxHash: tx.hash }
        });

       
        const maxRetry = 3;
        let retry = 0;
        let updated = false;
        while (retry < maxRetry && !updated) {
            await new Promise(res => setTimeout(res, 2000));
            const record = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
            if (record) {
                await CrossBridgeRecord.updateOne(
                    { sourceFromTxHash: txHash },
                    { $set: { sourceFromTxStatus: 'success' } }
                );
                console.log(`✅ 第${retry + 1}次重试后，成功更新 sourceFromTxStatus 为 success`);
                updated = true;
            } else {
                console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                retry++;
            }
        }
        if (!updated) {
            console.warn('⚠️ 多次重试后仍未查到记录，未能更新状态:', txHash);
        }

  
        if (updated) {

            const finalRecord = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
            const isSourceSuccess = finalRecord?.sourceFromTxStatus === 'success';
            const isTargetSuccess = finalRecord?.targetToTxStatus === 'success' || true; 

            if (isSourceSuccess && isTargetSuccess) {
                await CrossBridgeRecord.updateOne(
                    { sourceFromTxHash: txHash },
                    { $set: { crossBridgeStatus: 'minted' } }
                );
                console.log('🎉 crossBridgeStatus 已更新为 minted');
            }
        }

        const updateData: any = {
            targetToTxHash: tx.hash,
            targetToTxStatus: 'success',
            timestamp: new Date(),
            mintAmount: mintAmount.toString(),  // 实际铸造的金额（完整锁定金额）
            feeAmount: feeAmount.toString(),    // 手续费（由中继器承担）
            transactionId: transactionId  // 记录事件中的 transactionId
        };

        const isSourceSuccess = existingRecord?.sourceFromTxStatus === 'success';
        const isTargetSuccess = true;
        if (isSourceSuccess && isTargetSuccess) {
            updateData.crossBridgeStatus = 'minted';
        }

        await CrossBridgeRecord.updateOne(
            { sourceFromTxHash: txHash },  // 使用真正的交易哈希查找记录
            { $set: updateData },
     
        );

        console.log('🎉 铸币成功:', {
            sender,
            receiver,
            lockedAmount: ethers.formatUnits(originalAmount, tokenType === 'USDC' ? 6 : 18),
            mintedAmount: ethers.formatUnits(mintAmount, 18),
            fee: ethers.formatUnits(feeAmount, tokenType === 'USDC' ? 6 : 18),
            sourceFromTxHash: txHash,
            targetToTxHash: tx.hash
        });
    } catch (err: any) {
        if (err.code === 'INSUFFICIENT_FUNDS') {
            console.error('❌ B 链钱包余额不足，无法支付 Gas，请充值 ETH 到:', imuaWallet.address);
        } else {
            console.error('❌ 事件处理失败:', err);
        }

        sendToUser(receiver, {
            type: 'MINT_FAILED',
            data: { error: err.message || err }
        });
    }
});


socket.on('error', (err: any) => {
    console.error('❌ A链 WebSocket 错误:', err);
});

socket.on('close', async (code: number) => {
    console.warn(`⚠️ ${networkName} WebSocket 连接关闭，code: ${code}，尝试重连...`);
    
    // 断线重连后重新检查队列
    try {
        await queueChecker.checkPendingQueue();
        console.log(`✅ ${networkName} 断线重连后队列检查完成`);
    } catch (error) {
        console.error(`❌ ${networkName} 断线重连后队列检查失败:`, error);
    }
    
    // 重新连接特定网络的WebSocket
    setTimeout(() => {
        try {
            // 重新创建provider
            let newProvider;
            if (networkName === 'Ethereum-Sepolia') {
                newProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
            } else if (networkName === 'PlatON-Mainnet') {
                newProvider = new ethers.WebSocketProvider(PLATON_RPC_URL!);
            } else if (networkName === 'Imua-Testnet') {
                newProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!, imuaNetwork);
            } else if (networkName === 'ZetaChain-Testnet') {
                newProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!, imuaNetwork);
            } else {
                return; // 未知网络，不重连
            }
            
            // 重新监听该网络的合约
            listenToContract(
                new ethers.Contract(lockContract.target as string, LockTokensAbi.abi, newProvider),
                newProvider,
                queueChecker,
                networkName
            );
            
            console.log(`✅ ${networkName} 网络重新连接成功`);
        } catch (error) {
            console.error(`❌ ${networkName} 网络重连失败:`, error);
            // 继续尝试重连
            setTimeout(() => listenToContract(lockContract, provider, queueChecker, networkName), 5000);
        }
    }, 3000);
});
    
// 各网络不再单独定期检查队列，由全局定时器统一处理
}
