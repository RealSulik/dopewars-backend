import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Contract details - WILL UPDATE WITH NEW CONTRACT ADDRESS
const CONTRACT_ADDRESS = '0x58b200A5ac031DD6245ffc63E0A247AEe39ec609'; // UPDATE THIS AFTER DEPLOYMENT
const CONTRACT_ABI = [
  {
    "inputs": [
      {"internalType": "address", "name": "playerAddress", "type": "address"},
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

    console.log('🔥 Settlement request for:', playerAddress);

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

    // Get current prices for final net worth calculation
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

    // Calculate PROPER net worth: cash + bank - debt + drugs
    const drugValue = 
      (gameRun.weed * prices.weed) +
      (gameRun.acid * prices.acid) +
      (gameRun.cocaine * prices.cocaine) +
      (gameRun.heroin * prices.heroin);

    const finalNetWorth = Math.max(0, 
      gameRun.cash + 
      gameRun.bank_balance - 
      gameRun.debt + 
      drugValue
    );

    console.log('💰 Final net worth calculation:', {
      cash: gameRun.cash,
      bank: gameRun.bank_balance,
      debt: gameRun.debt,
      drugValue,
      finalNetWorth
    });
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

    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    const serverWallet = new ethers.Wallet(serverPrivateKey, provider);

    console.log('🔑 Server wallet:', serverWallet.address);

    // ===== CRITICAL FIX: Sign with PLAYER ADDRESS (not server wallet!) =====
    const messageHash = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'uint256', 'uint256', 'bytes32'],
        [playerAddress, finalNetWorth, gameRun.days_played, runId] // PLAYER ADDRESS!
      )
    );

    const ethSignedMessageHash = ethers.keccak256(
      ethers.solidityPacked(
        ['string', 'bytes32'],
        ['\x19Ethereum Signed Message:\n32', messageHash]
      )
    );

    const signature = await serverWallet.signMessage(ethers.getBytes(messageHash));

    console.log('✍️ Signature created:', signature);

    // Call smart contract with PLAYER ADDRESS as first parameter
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, serverWallet);

    console.log('📞 Calling settleRun with:', {
      playerAddress,  // REAL PLAYER ADDRESS!
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      runId,
      signatureLength: signature.length
    });

    const tx = await contract.settleRun(
      playerAddress,  // ✅ REAL PLAYER ADDRESS (NOT SERVER WALLET!)
      finalNetWorth,
      gameRun.days_played,
      runId,
      signature
    );

    console.log('⏳ Transaction sent:', tx.hash);

    const receipt = await tx.wait();
    console.log('✅ Transaction confirmed:', receipt.hash);

    // Get player's database ICE
    const { data: playerData } = await supabase
      .from('players')
      .select('total_ice')
      .eq('wallet_address', playerAddress)
      .single();

    const databaseIce = playerData?.total_ice || 0;

    // Mark game as settled in database
    await supabase
      .from('game_runs')
      .update({
        settled: true,
        status: finalNetWorth >= 1_000_000 ? 'won' : 'lost',
        final_net_worth: finalNetWorth,
        blockchain_tx: receipt.hash,
        ice_awarded: calculateIceReward(finalNetWorth, gameRun.days_played)
      })
      .eq('id', gameRun.id);

    // Update leaderboard
    await supabase
      .from('leaderboard')
      .upsert({
        wallet_address: playerAddress,
        best_net_worth: finalNetWorth,
        total_runs: 1,
        total_wins: finalNetWorth >= 1_000_000 ? 1 : 0,
        total_ice: databaseIce
      }, {
        onConflict: 'wallet_address',
        ignoreDuplicates: false
      });

    console.log('✅ Settlement complete!');

    return NextResponse.json({
      success: true,
      txHash: receipt.hash,
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      iceAwarded: calculateIceReward(finalNetWorth, gameRun.days_played),
      didWin: finalNetWorth >= 1_000_000,
      message: finalNetWorth >= 1_000_000 
        ? '🎉 YOU WON! Net worth over $1M!' 
        : 'Game settled. Try again for the $1M goal!'
    });

  } catch (error: any) {
    console.error('❌ Settlement error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Settlement failed' },
      { status: 500 }
    );
  }
}

function calculateIceReward(netWorth: number, days: number): number {
  if (netWorth >= 1_000_000) return 10; // Win!
  if (days >= 30) return 3; // Survived full game
  if (netWorth >= 500_000) return 5; // Good run
  if (netWorth >= 250_000) return 2; // Decent run
  return 1; // Participation
}
