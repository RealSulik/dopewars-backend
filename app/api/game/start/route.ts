import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Game constants
const STARTING_CASH = 2000;
const STARTING_DEBT = 5500;
const STARTING_CAPACITY = 100;
const STARTING_HEALTH = 100;
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Store nonces temporarily (in production, use Redis or database)
const nonceStore = new Map<string, { nonce: string, expiresAt: string }>();

export async function POST(request: NextRequest) {
  try {
    const { playerAddress, signature, nonce } = await request.json();

    console.log('🔍 DEBUG - Request received:', {
      playerAddress,
      hasSignature: !!signature,
      hasNonce: !!nonce,
      signature: signature?.substring(0, 20) + '...',
      nonce: nonce?.substring(0, 20) + '...'
    });

    if (!playerAddress) {
      return NextResponse.json(
        { success: false, error: 'Player address required' },
        { status: 400 }
      );
    }

    // ===== PHASE 1: Create session (no signature yet) =====
    if (!signature && !nonce) {
      console.log('📝 PHASE 1: Generating nonce for', playerAddress);
      
      // Generate nonce
      const sessionNonce = ethers.hexlify(ethers.randomBytes(32));
      const expiresAt = new Date(Date.now() + SESSION_DURATION);
      
      // Store nonce
      nonceStore.set(playerAddress.toLowerCase(), {
        nonce: sessionNonce,
        expiresAt: expiresAt.toISOString()
      });

      console.log('✅ Nonce generated:', {
        nonce: sessionNonce.substring(0, 20) + '...',
        expiresAt: expiresAt.toISOString()
      });

      return NextResponse.json({
        success: true,
        nonce: sessionNonce,
        expiresAt: expiresAt.toISOString(),
        message: 'Sign this message to start your game session'
      });
    }

    // ===== PHASE 2: Verify signature and create game =====
    console.log('🔐 PHASE 2: Verifying signature for', playerAddress);
    
    if (!signature || !nonce) {
      console.log('❌ Missing signature or nonce');
      return NextResponse.json(
        { success: false, error: 'Signature and nonce required' },
        { status: 400 }
      );
    }

    // Get stored nonce
    const storedData = nonceStore.get(playerAddress.toLowerCase());
    
    if (!storedData) {
      console.log('❌ No stored nonce found for player');
      return NextResponse.json(
        { success: false, error: 'No nonce found. Please start session again.' },
        { status: 400 }
      );
    }

    console.log('🔍 Stored data:', {
      storedNonce: storedData.nonce.substring(0, 20) + '...',
      receivedNonce: nonce.substring(0, 20) + '...',
      match: storedData.nonce === nonce
    });

    if (storedData.nonce !== nonce) {
      console.log('❌ Nonce mismatch');
      return NextResponse.json(
        { success: false, error: 'Invalid nonce' },
        { status: 400 }
      );
    }

    // Verify signature
    try {
      const message = `DopeWars Session Key\nNonce: ${nonce}\nExpires: ${storedData.expiresAt}`;
      
      console.log('🔍 Verifying message:', message);
      console.log('🔍 Signature:', signature.substring(0, 20) + '...');
      
      const recoveredAddress = ethers.verifyMessage(message, signature);
      
      console.log('🔍 Address comparison:', {
        recovered: recoveredAddress.toLowerCase(),
        expected: playerAddress.toLowerCase(),
        match: recoveredAddress.toLowerCase() === playerAddress.toLowerCase()
      });

      if (recoveredAddress.toLowerCase() !== playerAddress.toLowerCase()) {
        console.log('❌ Signature verification failed - address mismatch');
        return NextResponse.json(
          { success: false, error: 'Invalid signature' },
          { status: 400 }
        );
      }
      
      console.log('✅ Signature verified successfully!');
      
      // Clear nonce
      nonceStore.delete(playerAddress.toLowerCase());
      
    } catch (err: any) {
      console.error('❌ Signature verification error:', err);
      return NextResponse.json(
        { success: false, error: `Signature verification failed: ${err.message}` },
        { status: 400 }
      );
    }

    // Check for existing active run
    const { data: existingRun } = await supabase
      .from('game_runs')
      .select('id')
      .eq('wallet_address', playerAddress)
      .eq('status', 'active')
      .single();

    if (existingRun) {
      console.log('⚠️ Player already has active game');
      return NextResponse.json(
        { success: false, error: 'You already have an active game. Settle it first!' },
        { status: 400 }
      );
    }

    // Ensure player exists
    const { data: existingPlayer } = await supabase
      .from('players')
      .select('id')
      .eq('wallet_address', playerAddress)
      .single();

    let playerId: string;

    if (!existingPlayer) {
      const { data: newPlayer, error: playerError } = await supabase
        .from('players')
        .insert({
          wallet_address: playerAddress,
          total_ice: 0
        })
        .select()
        .single();

      if (playerError || !newPlayer) {
        throw new Error('Failed to create player');
      }

      playerId = newPlayer.id;
      console.log('✅ New player created:', playerId);
    } else {
      playerId = existingPlayer.id;
      console.log('✅ Existing player found:', playerId);
    }

    // Create new game run with all new fields
    const { data: newRun, error: runError } = await supabase
      .from('game_runs')
      .insert({
        player_id: playerId,
        wallet_address: playerAddress,
        cash: STARTING_CASH,
        debt: STARTING_DEBT,
        bank_balance: 0,
        trenchcoat_capacity: STARTING_CAPACITY,
        health: STARTING_HEALTH,
        has_gun: false,
        coat_upgrades: 0,
        location: 0,
        days_played: 0,
        weed: 0,
        acid: 0,
        cocaine: 0,
        heroin: 0,
        hustles_used: 0,
        stashes_used: 0,
        status: 'active',
        last_event_description: 'Game started! You have $2,000 cash and owe $5,500 to the loan shark. Good luck!'
      })
      .select()
      .single();

    if (runError || !newRun) {
      console.error('❌ Failed to create game run:', runError);
      throw new Error('Failed to create game run');
    }

    console.log('✅ Game run created:', newRun.id);

    // Generate initial prices for starting location
    const generatePrice = (min: number, max: number) => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    await supabase.from('daily_prices').insert({
      run_id: newRun.id,
      day: 0,
      location: 0,
      weed_price: generatePrice(100, 1000),
      acid_price: generatePrice(1000, 4000),
      cocaine_price: generatePrice(15000, 30000),
      heroin_price: generatePrice(5000, 15000)
    });

    console.log('✅ Game session started successfully!');

    return NextResponse.json({
      success: true,
      message: 'Game session created successfully!',
      gameData: {
        cash: STARTING_CASH,
        debt: STARTING_DEBT,
        bankBalance: 0,
        capacity: STARTING_CAPACITY,
        health: STARTING_HEALTH,
        hasGun: false,
        location: 0,
        daysPlayed: 0
      }
    });

  } catch (error: any) {
    console.error('❌ Start session error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to start session' },
      { status: 500 }
    );
  }
}