import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Contract details
const CONTRACT_ADDRESS = '0xb4b5E8654EFd675Cde9EFAf4E6131D33ABEa3aF5';
const CONTRACT_ABI = [
  {
    "inputs": [
      {"internalType": "uint256", "name": "finalNetWorth", "type": "uint256"},
      {"internalType": "uint256", "name": "daysPlayed", "type": "uint256"},
      {"internalType": "bytes32", "name": "runId", "type": "bytes32"},
      {"internalType": "bytes", "name": "signature", "type": "bytes"}
    ],
    "name": "settleRun",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

export async function POST(request: NextRequest) {
  try {
    const { playerAddress } = await request.json();

    console.log('📥 Settlement request for:', playerAddress);

    if (!playerAddress) {
      return NextResponse.json(
        { success: false, error: 'Player address required' },
        { status: 400 }
      );
    }

    // Get the active run for this player
    const { data: gameRun, error: runError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('wallet_address', playerAddress)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (runError || !gameRun) {
      return NextResponse.json(
        { success: false, error: 'No active game found to settle' },
        { status: 404 }
      );
    }

    // Check if already settled
    if (gameRun.settled) {
      return NextResponse.json(
        { success: false, error: 'Game already settled' },
        { status: 400 }
      );
    }

    // Calculate final net worth
    const { data: priceData } = await supabase
      .from('daily_prices')
      .select('*')
      .eq('run_id', gameRun.id)
      .eq('day', gameRun.days_played)
      .eq('location', gameRun.location)
      .single();

    const prices = priceData ? {
      weed: priceData.weed_price,
      acid: priceData.acid_price,
      cocaine: priceData.cocaine_price,
      heroin: priceData.heroin_price
    } : { weed: 0, acid: 0, cocaine: 0, heroin: 0 };

    const finalNetWorth = gameRun.cash +
      (gameRun.weed * prices.weed) +
      (gameRun.acid * prices.acid) +
      (gameRun.cocaine * prices.cocaine) +
      (gameRun.heroin * prices.heroin);

    console.log('💰 Final net worth:', finalNetWorth);
    console.log('📅 Days played:', gameRun.days_played);

    // Generate runId (unique identifier for this game)
    const runId = ethers.keccak256(
      ethers.toUtf8Bytes(`${gameRun.id}-${gameRun.created_at}`)
    );

    console.log('🆔 Run ID:', runId);

    // Get server wallet
    const serverPrivateKey = process.env.SERVER_PRIVATE_KEY;
    if (!serverPrivateKey) {
      throw new Error('Server private key not configured');
    }
    const serverWallet = new ethers.Wallet(serverPrivateKey);
    const msgSender = serverWallet.address;
    
    console.log('🔑 msg.sender will be:', msgSender);
    
    // CRITICAL: Contract uses msg.sender (server address) in getMessageHash, NOT player address!
    const packed = ethers.solidityPacked(
      ['address', 'uint256', 'uint256', 'bytes32'],
      [msgSender, finalNetWorth, gameRun.days_played, runId]
    );
    const messageHash = ethers.keccak256(packed);

    console.log('📝 Packed data:', packed);
    console.log('📝 Message hash:', messageHash);
    
    // Create Ethereum signed message hash (contract does this in getEthSignedMessageHash)
    const ethSignedMessageHash = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
        ethers.getBytes(messageHash)
      ])
    );
    
    console.log('📝 Eth signed message hash:', ethSignedMessageHash);
    
    // Sign directly
    const signingKey = new ethers.SigningKey(serverPrivateKey);
    const sig = signingKey.sign(ethSignedMessageHash);
    const signature = ethers.Signature.from(sig).serialized;

    console.log('✍️ Server signature:', signature);

    // Submit to blockchain
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
    const wallet = new ethers.Wallet(serverPrivateKey, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

    console.log('📤 Submitting to blockchain...');

    const tx = await contract.settleRun(
      finalNetWorth,
      gameRun.days_played,
      runId,
      signature
    );

    console.log('⏳ Transaction sent:', tx.hash);

    const receipt = await tx.wait();

    console.log('✅ Transaction confirmed:', receipt.hash);

    // Update game run as settled
    await supabase
      .from('game_runs')
      .update({
        status: 'finished',
        settled: true,
        blockchain_tx: receipt.hash,
        final_net_worth: finalNetWorth,
        did_win: finalNetWorth >= 1000000
      })
      .eq('id', gameRun.id);

    // Update leaderboard
    const { data: existingLeaderboard } = await supabase
      .from('leaderboard')
      .select('*')
      .eq('wallet_address', playerAddress)
      .single();

    if (existingLeaderboard) {
      await supabase
        .from('leaderboard')
        .update({
          best_net_worth: Math.max(existingLeaderboard.best_net_worth, finalNetWorth),
          total_runs: existingLeaderboard.total_runs + 1,
          total_wins: existingLeaderboard.total_wins + (finalNetWorth >= 1000000 ? 1 : 0)
        })
        .eq('wallet_address', playerAddress);
    } else {
      await supabase
        .from('leaderboard')
        .insert({
          wallet_address: playerAddress,
          best_net_worth: finalNetWorth,
          total_runs: 1,
          total_wins: finalNetWorth >= 1000000 ? 1 : 0
        });
    }

    return NextResponse.json({
      success: true,
      txHash: receipt.hash,
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      didWin: finalNetWorth >= 1000000
    });

  } catch (error: any) {
    console.error('❌ Settlement error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Settlement failed' },
      { status: 500 }
    );
  }
}
