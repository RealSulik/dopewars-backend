import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { runId } = await request.json();

    if (!runId) {
      return NextResponse.json(
        { error: 'Run ID required' },
        { status: 400 }
      );
    }

    // Get game run
    const { data: gameRun, error: fetchError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('id', runId)
      .single();

    if (fetchError || !gameRun) {
      return NextResponse.json(
        { error: 'Game run not found' },
        { status: 404 }
      );
    }

    // Check if game is finished
    if (gameRun.status === 'active') {
      return NextResponse.json(
        { error: 'Game is still active. Complete the run first.' },
        { status: 400 }
      );
    }

    // Check if already settled
    if (gameRun.settled) {
      return NextResponse.json(
        { error: 'Run already settled on blockchain' },
        { status: 400 }
      );
    }

    // Calculate final net worth
    const { data: prices } = await supabase
      .from('daily_prices')
      .select('*')
      .eq('run_id', runId)
      .eq('day', gameRun.days_played)
      .eq('location', gameRun.location)
      .single();

    let netWorth = gameRun.cash;
    
    if (prices) {
      netWorth += gameRun.weed * prices.weed_price;
      netWorth += gameRun.acid * prices.acid_price;
      netWorth += gameRun.cocaine * prices.cocaine_price;
      netWorth += gameRun.heroin * prices.heroin_price;
    }

    // Create signature
    const serverWallet = new ethers.Wallet(process.env.SERVER_WALLET_PRIVATE_KEY!);
    
    // Create runId as bytes32 (keccak256 hash of UUID)
    const runIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(runId));
    
    // Create message hash matching contract's getMessageHash function
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'bytes32'],
      [gameRun.wallet_address, netWorth, gameRun.days_played, runIdBytes32]
    );

    // Sign the message (ethers v6 automatically adds Ethereum prefix)
    const signature = await serverWallet.signMessage(ethers.getBytes(messageHash));

    // Update leaderboard
    const { data: existingLeader } = await supabase
      .from('leaderboard')
      .select('*')
      .eq('wallet_address', gameRun.wallet_address)
      .single();

    const didWin = gameRun.status === 'won';
    const iceAwarded = didWin ? 10 : gameRun.days_played >= 30 ? 3 : netWorth >= 50000 ? 5 : netWorth >= 25000 ? 2 : 1;

    if (existingLeader) {
      await supabase
        .from('leaderboard')
        .update({
          best_net_worth: Math.max(existingLeader.best_net_worth, netWorth),
          total_ice: existingLeader.total_ice + iceAwarded,
          total_runs: existingLeader.total_runs + 1,
          total_wins: existingLeader.total_wins + (didWin ? 1 : 0)
        })
        .eq('wallet_address', gameRun.wallet_address);
    } else {
      await supabase
        .from('leaderboard')
        .insert({
          wallet_address: gameRun.wallet_address,
          best_net_worth: netWorth,
          total_ice: iceAwarded,
          total_runs: 1,
          total_wins: didWin ? 1 : 0
        });
    }

    return NextResponse.json({
      success: true,
      settlement: {
        finalNetWorth: netWorth,
        daysPlayed: gameRun.days_played,
        runId: runIdBytes32,
        signature,
        iceAwarded,
        didWin
      }
    });

  } catch (error: any) {
    console.error('Settlement error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate settlement' },
      { status: 500 }
    );
  }
}