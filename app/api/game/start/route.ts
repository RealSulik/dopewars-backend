import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Drug names for easy reference
const DRUG_NAMES = ['Weed', 'Acid', 'Cocaine', 'Heroin'];

// Price ranges (min, max) for each drug
const PRICE_RANGES = {
  0: { min: 100, max: 1000 },    // Weed
  1: { min: 1000, max: 4000 },   // Acid
  2: { min: 15000, max: 30000 }, // Cocaine
  3: { min: 5000, max: 15000 }   // Heroin
};

// City multipliers [Weed, Acid, Cocaine, Heroin]
const CITY_MULTIPLIERS = [
  [1.0, 1.2, 1.5, 1.1],  // Staten Island
  [0.9, 1.1, 0.8, 0.7],  // Bronx
  [1.1, 1.0, 1.0, 1.0],  // Queens
  [0.95, 0.9, 1.05, 1.0], // Brooklyn
  [1.3, 1.4, 1.6, 1.2],  // Central Park
  [1.0, 1.0, 0.9, 1.6],  // Coney Island
  [1.4, 1.2, 1.7, 1.3]   // Manhattan
];

function generatePrice(drugIndex: number, location: number): number {
  const range = PRICE_RANGES[drugIndex as keyof typeof PRICE_RANGES];
  const mid = (range.min + range.max) / 2;
  const halfRange = (range.max - range.min) / 2;
  
  // Random offset
  const offset = Math.random() * (halfRange * 2) - halfRange;
  let price = mid + offset;
  
  // Apply city multiplier
  price = price * CITY_MULTIPLIERS[location][drugIndex];
  
  // Ensure within bounds
  price = Math.max(range.min, Math.min(range.max, price));
  
  return Math.round(price);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const playerAddress = body.playerAddress || body.walletAddress; // Accept both names
    
    console.log('📥 Received request body:', body);
    console.log('📥 Player address:', playerAddress);
    
    if (!playerAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }
    
    // Check if player exists, if not create
    const { data: existingPlayer } = await supabase
      .from('players')
      .select('id')
      .eq('wallet_address', playerAddress)
      .single();
    
    let playerId: string;
    
    if (!existingPlayer) {
      // Create new player
      const { data: newPlayer, error: playerError } = await supabase
        .from('players')
        .insert({ wallet_address: playerAddress })
        .select('id')
        .single();
      
      if (playerError) throw playerError;
      playerId = newPlayer.id;
    } else {
      playerId = existingPlayer.id;
    }
    
    // Create new game run
    const { data: gameRun, error: runError } = await supabase
      .from('game_runs')
      .insert({
        player_id: playerId,
        wallet_address: playerAddress,
        cash: 2000,
        location: 0, // Start at Staten Island
        days_played: 0,
        weed: 0,
        acid: 0,
        cocaine: 0,
        heroin: 0,
        status: 'active'
      })
      .select()
      .single();
    
    if (runError) throw runError;
    
    // Generate initial prices for day 0, location 0
    const prices = [0, 1, 2, 3].map(drugIndex =>
      generatePrice(drugIndex, 0)
    );
    
    // Store prices in database
    const { error: pricesError } = await supabase
      .from('daily_prices')
      .insert({
        run_id: gameRun.id,
        day: 0,
        location: 0,
        weed_price: prices[0],
        acid_price: prices[1],
        cocaine_price: prices[2],
        heroin_price: prices[3]
      });
    
    if (pricesError) throw pricesError;
    
    // Generate nonce for session
    const nonce = Math.random().toString(36).substring(7);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    
    // Return session data
    return NextResponse.json({
      success: true,
      nonce,
      expiresAt,
      gameRun: {
        ...gameRun,
        prices: {
          weed: prices[0],
          acid: prices[1],
          cocaine: prices[2],
          heroin: prices[3]
        }
      }
    });
  } catch (error: any) {
    console.error('Start game error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start game' },
      { status: 500 }
    );
  }
}